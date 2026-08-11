import type { MessageKind, QueueRole } from './model.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Variable d'environnement requise manquante : ${name}`);
  }
  return v;
}

function list(name: string, fallback: string): string[] {
  return env(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export interface Config {
  rabbit: {
    url: string;
    user: string;
    pass: string;
    vhost: string;
  };
  k8s: {
    /** Namespaces à scanner. Vide = tous. */
    namespaces: string[];
    /** Labels essayés dans l'ordre pour nommer un workload. */
    nameLabels: string[];
    /**
     * Ports à sonder pour l'endpoint de manifeste, dans l'ordre.
     *
     * Il en faut plusieurs : une API web sert le manifeste sur son port
     * applicatif, tandis qu'un worker sans servlet ouvre un port dédié.
     */
    manifestPorts: number[];
    manifestPath: string;
    manifestTimeoutMs: number;
    /** Si false, on saute complètement l'interrogation des pods. */
    collectManifests: boolean;
  };
  conventions: {
    /** Préfixes de routing key → nature du message. */
    eventPrefixes: string[];
    commandPrefixes: string[];
    /** Suffixes/fragments identifiant les queues techniques. */
    dlqPatterns: string[];
    retryPatterns: string[];
    /** Exchanges ignorés (par défaut les exchanges système AMQP). */
    ignoreExchanges: string[];
  };
  output: {
    dir: string;
    /** Nombre de runs sans observation avant suppression d'une arête. */
    staleAfterRuns: number;
    /** Map du run précédent, pour le merge et le diff. */
    previousPath?: string;
  };
  git: {
    enabled: boolean;
    /** URL de clonage. Si absente, on suppose repoDir déjà cloné. */
    repoUrl?: string;
    repoDir: string;
    /** Sous-dossier du repo où déposer les artefacts. */
    subdir: string;
    branchPrefix: string;
    baseBranch: string;
    authorName: string;
    authorEmail: string;
    /** Création d'une PR GitHub — nécessite GITHUB_TOKEN et GITHUB_REPOSITORY. */
    openPr: boolean;
    token?: string;
    repository?: string;
  };
  layout: {
    /**
     * Au-delà de ce nombre de nœuds, on bascule sur un placement plus rapide mais
     * moins compact. Cf. le commentaire dans core/layout.ts pour les mesures.
     */
    maxExactNodes: number;
  };
  /** Sortir en code 1 si le run révèle de nouvelles anomalies (utile en CI). */
  failOnNewWarnings: boolean;
  /**
   * Sortir en code 1 si un payload perd un champ ou en change le type.
   *
   * Séparé de `failOnNewWarnings` à dessein : une rupture de contrat n'a
   * pratiquement pas de faux positif, alors que les anomalies de topologie en
   * comportent tant que la dette initiale n'est pas triée. On peut donc activer
   * ce garde-fou dès le premier jour, et l'autre bien plus tard.
   */
  failOnBreakingSchema: boolean;
  clusterName?: string;
}

export function loadConfig(): Config {
  return {
    rabbit: {
      url: env('RABBIT_MGMT_URL').replace(/\/+$/, ''),
      user: env('RABBIT_USER'),
      pass: env('RABBIT_PASS'),
      vhost: env('RABBIT_VHOST', '/'),
    },
    k8s: {
      namespaces: process.env.K8S_NAMESPACES ? list('K8S_NAMESPACES', '') : [],
      nameLabels: list(
        'K8S_NAME_LABELS',
        'app.kubernetes.io/name,app.kubernetes.io/instance,app',
      ),
      manifestPorts: list('MANIFEST_PORTS', env('MANIFEST_PORT', '8080,8081'))
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
      manifestPath: env('MANIFEST_PATH', '/internal/event-manifest'),
      manifestTimeoutMs: Number(env('MANIFEST_TIMEOUT_MS', '4000')),
      collectManifests: bool('COLLECT_MANIFESTS', true),
    },
    conventions: {
      eventPrefixes: list('EVENT_PREFIXES', 'evt,event'),
      commandPrefixes: list('COMMAND_PREFIXES', 'cmd,command'),
      dlqPatterns: list('DLQ_PATTERNS', '.dlq,.dead,-dlq,.parking'),
      retryPatterns: list('RETRY_PATTERNS', '.retry,-retry,.delay'),
      ignoreExchanges: list(
        'IGNORE_EXCHANGES',
        'amq.direct,amq.fanout,amq.headers,amq.match,amq.topic,amq.rabbitmq.trace,amq.rabbitmq.log',
      ),
    },
    output: {
      dir: env('OUTPUT_DIR', './out'),
      staleAfterRuns: Number(env('STALE_AFTER_RUNS', '3')),
      previousPath: process.env.PREVIOUS_MAP_PATH,
    },
    git: {
      enabled: bool('GIT_ENABLED', false),
      repoUrl: process.env.GIT_REPO_URL,
      repoDir: env('GIT_REPO_DIR', './repo'),
      subdir: env('GIT_SUBDIR', 'docs/event-map'),
      branchPrefix: env('GIT_BRANCH_PREFIX', 'eventmap/'),
      baseBranch: env('GIT_BASE_BRANCH', 'main'),
      authorName: env('GIT_AUTHOR_NAME', 'event-map-discovery'),
      authorEmail: env('GIT_AUTHOR_EMAIL', 'event-map-discovery@noreply.internal'),
      openPr: bool('GIT_OPEN_PR', false),
      token: process.env.GITHUB_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
    },
    layout: {
      maxExactNodes: Number(env('LAYOUT_MAX_EXACT_NODES', '60')),
    },
    failOnNewWarnings: bool('FAIL_ON_NEW_WARNINGS', false),
    failOnBreakingSchema: bool('FAIL_ON_BREAKING_SCHEMA', false),
    clusterName: process.env.CLUSTER_NAME,
  };
}

/** Classe une routing key en événement / commande selon les préfixes configurés. */
export function classifyKey(key: string, cfg: Config): MessageKind {
  const head = key.split('.')[0]?.toLowerCase() ?? '';
  if (cfg.conventions.eventPrefixes.includes(head)) return 'event';
  if (cfg.conventions.commandPrefixes.includes(head)) return 'command';
  return 'unknown';
}

/** Classe une queue en principale / DLQ / retry selon son nom. */
export function classifyQueue(name: string, cfg: Config): QueueRole {
  const n = name.toLowerCase();
  if (cfg.conventions.dlqPatterns.some((p) => n.includes(p))) return 'dlq';
  if (cfg.conventions.retryPatterns.some((p) => n.includes(p))) return 'retry';
  return 'main';
}
