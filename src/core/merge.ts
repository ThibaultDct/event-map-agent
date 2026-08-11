import type { Config } from '../config.js';
import type { EventMap, FlowEdge, ServiceNode } from '../model.js';

/**
 * Un run de découverte est un **instantané** : un worker scale-to-zéro, en cours
 * de rolling update, ou dont les consommateurs sont momentanément déconnectés
 * disparaît de la topologie observée. Supprimer immédiatement ce qui n'a pas été
 * vu produirait une map qui clignote et un diff illisible.
 *
 * On applique donc un TTL : une arête absente est conservée avec un compteur
 * `missingRuns`, et n'est réellement retirée qu'après N runs consécutifs.
 */
export function mergeWithPrevious(current: EventMap, previous: EventMap | undefined, cfg: Config): EventMap {
  if (!previous) return current;

  const ttl = cfg.output.staleAfterRuns;

  // ------------------------------------------------------------------- flows
  const currentFlows = new Map(current.flows.map((f) => [f.id, f]));
  const merged: FlowEdge[] = [];

  for (const f of current.flows) {
    const prev = previous.flows.find((p) => p.id === f.id);
    merged.push({ ...f, firstSeen: prev?.firstSeen ?? f.firstSeen, missingRuns: 0 });
  }

  for (const p of previous.flows) {
    if (currentFlows.has(p.id)) continue;
    const missing = (p.missingRuns ?? 0) + 1;
    if (missing >= ttl) continue; // périmée : on la laisse tomber
    merged.push({ ...p, missingRuns: missing });
  }
  current.flows = merged;

  // ---------------------------------------------------------------- services
  const currentServices = new Map(current.services.map((s) => [s.id, s]));
  const mergedServices: ServiceNode[] = current.services.map((s) => {
    const prev = previous.services.find((p) => p.id === s.id);
    return { ...s, firstSeen: prev?.firstSeen ?? s.firstSeen, missingRuns: 0 };
  });

  for (const p of previous.services) {
    if (currentServices.has(p.id)) continue;
    const missing = (p.missingRuns ?? 0) + 1;
    if (missing >= ttl) continue;
    mergedServices.push({ ...p, missingRuns: missing });
  }
  current.services = mergedServices;

  return current;
}

/**
 * Ordonne l'IR pour que deux runs identiques produisent un JSON strictement
 * identique. Sans ça, le diff git est noyé sous des réordonnancements
 * arbitraires dus à l'ordre de réponse des API.
 */
export function stabilize(map: EventMap): EventMap {
  const by = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

  map.services.sort(by((s: ServiceNode) => s.id));
  map.exchanges.sort(by((e) => e.name));
  map.queues.sort(by((q) => q.name));
  map.bindings.sort(by((b) => `${b.exchange}|${b.queue}|${b.pattern}`));
  map.publishes.sort(by((p) => `${p.service}|${p.exchange}|${p.routingKey}`));
  map.subscribes.sort(by((s) => `${s.service}|${s.queue}`));
  map.flows.sort(by((f) => f.id));
  map.warnings.sort(by((w) => `${w.code}|${w.ref ?? ''}|${w.message}`));
  return map;
}
