import { KubeConfig, CoreV1Api, AppsV1Api } from '@kubernetes/client-node';
import type { Config } from '../config.js';
import type { ServiceNode } from '../model.js';

/**
 * Un pod, réduit à ce dont on a besoin pour la corrélation.
 */
export interface PodRef {
  name: string;
  namespace: string;
  ip: string;
  workload: string;
  image?: string;
  hasPorts: boolean;
  annotations: Record<string, string>;
}

export interface K8sSnapshot {
  /** Index IP → pod : c'est la clé de voûte de la corrélation avec RabbitMQ. */
  byIp: Map<string, PodRef>;
  /** Un pod représentatif par workload (les réplicas sont identiques). */
  representatives: Map<string, PodRef>;
  services: ServiceNode[];
}

/**
 * Les versions <1.0 de @kubernetes/client-node enveloppent la réponse dans
 * `{ response, body }`, les versions >=1.0 renvoient l'objet directement.
 * On absorbe les deux plutôt que d'épingler une version.
 */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === 'object' && 'body' in (res as Record<string, unknown>)) {
    return (res as { body: T }).body;
  }
  return res as T;
}

/** Enlève le suffixe de hash que le ReplicaSet ajoute au nom du Deployment. */
function stripReplicaSetHash(name: string): string {
  return name.replace(/-[a-z0-9]{5,10}$/, '');
}

function resolveWorkload(
  pod: { metadata?: { name?: string; labels?: Record<string, string>; ownerReferences?: Array<{ kind: string; name: string }> } },
  cfg: Config,
): string {
  const labels = pod.metadata?.labels ?? {};
  for (const key of cfg.k8s.nameLabels) {
    const v = labels[key];
    if (v) return v;
  }
  const owner = pod.metadata?.ownerReferences?.[0];
  if (owner) {
    // ReplicaSet → Deployment ; les autres kinds (StatefulSet, DaemonSet, Job)
    // portent déjà le nom final.
    return owner.kind === 'ReplicaSet' ? stripReplicaSetHash(owner.name) : owner.name;
  }
  return stripReplicaSetHash(pod.metadata?.name ?? 'unknown');
}

export async function collectKubernetes(cfg: Config): Promise<K8sSnapshot> {
  const kc = new KubeConfig();
  // Détecte automatiquement le ServiceAccount monté quand on tourne dans un pod,
  // et retombe sur ~/.kube/config en local.
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);

  const podList = unwrap<{ items: any[] }>(await core.listPodForAllNamespaces());
  const deployList = unwrap<{ items: any[] }>(await apps.listDeploymentForAllNamespaces());
  const stsList = unwrap<{ items: any[] }>(await apps.listStatefulSetForAllNamespaces());

  const nsFilter = cfg.k8s.namespaces;
  const inScope = (ns: string) => nsFilter.length === 0 || nsFilter.includes(ns);

  const byIp = new Map<string, PodRef>();
  const representatives = new Map<string, PodRef>();
  const replicaCount = new Map<string, number>();

  for (const pod of podList.items ?? []) {
    const ns: string = pod.metadata?.namespace ?? 'default';
    const ip: string | undefined = pod.status?.podIP;
    // On ignore les pods sans IP (Pending) ou terminés : ils ne peuvent pas
    // porter de connexion AMQP active.
    if (!ip || !inScope(ns) || pod.status?.phase !== 'Running') continue;

    const workload = resolveWorkload(pod, cfg);
    const containers: any[] = pod.spec?.containers ?? [];
    const ref: PodRef = {
      name: pod.metadata?.name ?? '',
      namespace: ns,
      ip,
      workload,
      image: containers[0]?.image,
      hasPorts: containers.some((c) => (c.ports?.length ?? 0) > 0),
      annotations: pod.metadata?.annotations ?? {},
    };

    byIp.set(ip, ref);
    const key = `${ns}/${workload}`;
    replicaCount.set(key, (replicaCount.get(key) ?? 0) + 1);
    if (!representatives.has(key)) representatives.set(key, ref);
  }

  // Le nombre de réplicas déclaré est plus fiable que le comptage de pods, qui
  // fluctue pendant un rolling update.
  const declaredReplicas = new Map<string, number>();
  for (const w of [...(deployList.items ?? []), ...(stsList.items ?? [])]) {
    const ns = w.metadata?.namespace ?? 'default';
    if (!inScope(ns)) continue;
    declaredReplicas.set(`${ns}/${w.metadata?.name}`, w.spec?.replicas ?? 0);
  }

  const services: ServiceNode[] = [...representatives.entries()].map(([key, pod]) => {
    const override = pod.annotations['eventmap.io/kind'];
    const kind: ServiceNode['kind'] =
      override === 'api' || override === 'worker'
        ? override
        : pod.hasPorts
          ? 'api'
          : 'worker';
    return {
      id: key,
      name: pod.workload,
      namespace: pod.namespace,
      kind,
      replicas: declaredReplicas.get(key) ?? replicaCount.get(key) ?? 1,
      image: pod.image,
      manifestOk: false, // renseigné par le collecteur de manifestes
    };
  });

  return { byIp, representatives, services };
}
