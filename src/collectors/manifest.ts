import type { Config } from '../config.js';
import type { ServiceManifest, Warning } from '../model.js';
import type { PodRef } from './kubernetes.js';

export interface ManifestResult {
  /** Clé : `namespace/workload`. */
  manifests: Map<string, ServiceManifest>;
  warnings: Warning[];
}

async function fetchOnPort(
  pod: PodRef,
  port: number,
  cfg: Config,
): Promise<ServiceManifest | { error: string }> {
  const url = `http://${pod.ip}:${port}${cfg.k8s.manifestPath}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.k8s.manifestTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as ServiceManifest;
    if (!body || typeof body.service !== 'string') return { error: 'payload inattendu' };
    return body;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: ctl.signal.aborted ? `timeout ${cfg.k8s.manifestTimeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sonde les ports configurés dans l'ordre, et s'arrête au premier qui répond.
 *
 * Une API web sert le manifeste sur son port applicatif ; un worker sans servlet
 * ouvre un port dédié. Comme rien ne permet de deviner lequel depuis l'extérieur
 * — l'absence de `containerPort` déclaré ne prouve rien — on essaie.
 */
async function fetchManifest(
  pod: PodRef,
  cfg: Config,
): Promise<ServiceManifest | { error: string }> {
  const errors: string[] = [];
  for (const port of cfg.k8s.manifestPorts) {
    const res = await fetchOnPort(pod, port, cfg);
    if (!('error' in res)) return res;
    errors.push(`${port}: ${res.error}`);
  }
  return { error: errors.join(' · ') };
}

/**
 * Interroge /internal/event-manifest sur **un seul pod par workload** : les
 * réplicas servent le même manifeste, les interroger tous n'apporte rien et
 * multiplie les timeouts sur un gros cluster.
 *
 * Un service injoignable n'est pas une erreur fatale : la moitié consommateur
 * reste dérivable du broker. On dégrade, on ne s'arrête pas.
 */
export async function collectManifests(
  representatives: Map<string, PodRef>,
  cfg: Config,
): Promise<ManifestResult> {
  const manifests = new Map<string, ServiceManifest>();
  const warnings: Warning[] = [];

  if (!cfg.k8s.collectManifests) return { manifests, warnings };

  const entries = [...representatives.entries()];
  const CONCURRENCY = 16;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ([key, pod]) => ({ key, pod, res: await fetchManifest(pod, cfg) })),
    );
    for (const { key, pod, res } of results) {
      if ('error' in res) {
        warnings.push({
          level: 'info',
          code: 'manifest-unreachable',
          message: `${pod.workload} (${pod.namespace}) : pas de manifeste sur ${pod.ip} — ${res.error}`,
          ref: key,
        });
      } else {
        manifests.set(key, res);
      }
    }
  }

  return { manifests, warnings };
}
