import type { EventMap, Warning } from '../model.js';
import { renderContractMarkdown, type ContractDiff } from './contract.js';

export interface MapDiff {
  addedFlows: string[];
  removedFlows: string[];
  addedServices: string[];
  removedServices: string[];
  addedBindings: string[];
  removedBindings: string[];
  newWarnings: Warning[];
  resolvedWarnings: Warning[];
  get empty(): boolean;
}

function warnKey(w: Warning): string {
  return `${w.code}|${w.ref ?? ''}`;
}

function flowLabel(id: string): string {
  // id = "from→to|exchange|routingKey|queue"
  const [route, exchange, key, queue] = id.split('|');
  return `${route}  \`${key}\` via ${exchange} → ${queue}`;
}

export function diffMaps(prev: EventMap | undefined, next: EventMap): MapDiff {
  const p = prev ?? {
    flows: [],
    services: [],
    bindings: [],
    warnings: [],
  } as unknown as EventMap;

  const prevFlows = new Set(p.flows.map((f) => f.id));
  const nextFlows = new Set(next.flows.map((f) => f.id));
  const prevServices = new Set(p.services.map((s) => s.id));
  const nextServices = new Set(next.services.map((s) => s.id));
  const bKey = (b: { exchange: string; queue: string; pattern: string }) =>
    `${b.exchange} --[${b.pattern}]--> ${b.queue}`;
  const prevBindings = new Set(p.bindings.map(bKey));
  const nextBindings = new Set(next.bindings.map(bKey));

  const prevWarn = new Map(p.warnings.map((w) => [warnKey(w), w]));
  const nextWarn = new Map(next.warnings.map((w) => [warnKey(w), w]));

  const diff: MapDiff = {
    addedFlows: [...nextFlows].filter((x) => !prevFlows.has(x)),
    removedFlows: [...prevFlows].filter((x) => !nextFlows.has(x)),
    addedServices: [...nextServices].filter((x) => !prevServices.has(x)),
    removedServices: [...prevServices].filter((x) => !nextServices.has(x)),
    addedBindings: [...nextBindings].filter((x) => !prevBindings.has(x)),
    removedBindings: [...prevBindings].filter((x) => !nextBindings.has(x)),
    newWarnings: [...nextWarn].filter(([k]) => !prevWarn.has(k)).map(([, w]) => w),
    resolvedWarnings: [...prevWarn].filter(([k]) => !nextWarn.has(k)).map(([, w]) => w),
    get empty() {
      return (
        this.addedFlows.length === 0 &&
        this.removedFlows.length === 0 &&
        this.addedServices.length === 0 &&
        this.removedServices.length === 0 &&
        this.addedBindings.length === 0 &&
        this.removedBindings.length === 0 &&
        this.newWarnings.length === 0 &&
        this.resolvedWarnings.length === 0
      );
    },
  };

  return diff;
}

/**
 * GitHub refuse un corps de PR au-delà de 65 536 octets. Sur un système de 26
 * services, un premier run produit déjà 72 Ko : sans plafond, la PR serait
 * tronquée au milieu d'une liste, ce qui donne un rapport trompeur plutôt
 * qu'incomplet. On coupe donc explicitement, section par section, en disant
 * combien d'entrées ont été omises.
 */
const MAX_ITEMS_PER_SECTION = 40;

const ICON: Record<Warning['code'], string> = {
  'orphan-event': '📤',
  'ghost-queue': '📥',
  'unknown-consumer': '❓',
  'manifest-unreachable': '🔌',
  'binding-drift': '↔️',
  'dynamic-key': '🌀',
  'starved-queue': '🍽️',
  'schema-divergence': '🔀',
  'contract-mismatch': '💥',
};

/**
 * Le vrai livrable du job. Le graphe est joli ; c'est ce rapport qu'on relit en PR.
 */
export function renderDiffMarkdown(diff: MapDiff, map: EventMap, contract?: ContractDiff): string {
  const L: string[] = [];
  const section = (title: string, items: string[], prefix = '') => {
    if (items.length === 0) return;
    L.push(`### ${title} (${items.length})`, '');
    for (const i of items.slice(0, MAX_ITEMS_PER_SECTION)) L.push(`- ${prefix}${i}`);
    if (items.length > MAX_ITEMS_PER_SECTION) {
      L.push(`- _… et ${items.length - MAX_ITEMS_PER_SECTION} autres — liste complète dans \`event-map.json\`_`);
    }
    L.push('');
  };

  L.push(`# Carte des événements — ${map.generatedAt.slice(0, 19).replace('T', ' ')} UTC`, '');
  if (map.cluster) L.push(`Cluster : \`${map.cluster}\``, '');

  const described = map.publishes.filter((p) => p.schema && p.schema.length > 0).length;
  L.push(
    `${map.services.length} services · ${map.exchanges.length} exchanges · ` +
      `${map.queues.length} queues · ${map.flows.length} flux · ${map.warnings.length} alertes` +
      (described > 0 ? ` · ${described}/${map.publishes.length} payloads décrits` : ''),
    '',
  );

  if (diff.empty && (!contract || contract.breaking.length + contract.additive.length === 0)) {
    L.push('_Aucun changement de topologie ni de contrat depuis le run précédent._', '');
  }

  // Les ruptures de contrat passent avant tout le reste : un champ retiré casse
  // des consommateurs en production, là où un binding ajouté est une évolution.
  if (contract) L.push(...renderContractMarkdown(contract, MAX_ITEMS_PER_SECTION));

  section('Nouveaux services', diff.addedServices);
  section('Services disparus', diff.removedServices);
  section('Nouveaux flux', diff.addedFlows.map(flowLabel));
  section('Flux disparus', diff.removedFlows.map(flowLabel));
  section('Nouveaux bindings', diff.addedBindings);
  section('Bindings supprimés', diff.removedBindings);

  // À 26 services, une seule liste à plat atteint la quarantaine d'entrées et
  // devient illisible. Le regroupement par code met en avant la *nature* du
  // problème avant son volume.
  const SEVERITY: Record<Warning['level'], number> = { error: 0, warn: 1, info: 2 };
  const groupByCode = (warnings: Warning[]) => {
    const groups = new Map<Warning['code'], Warning[]>();
    for (const w of warnings) {
      if (!groups.has(w.code)) groups.set(w.code, []);
      groups.get(w.code)!.push(w);
    }
    return [...groups.entries()].sort((a, b) => {
      const sa = Math.min(...a[1].map((w) => SEVERITY[w.level]));
      const sb = Math.min(...b[1].map((w) => SEVERITY[w.level]));
      return sa - sb || b[1].length - a[1].length;
    });
  };

  const warningSection = (title: string, warnings: Warning[], collapsed: boolean) => {
    if (warnings.length === 0) return;
    if (collapsed) L.push(`<details><summary>${title} (${warnings.length})</summary>`, '');
    else L.push(`### ${title} (${warnings.length})`, '');

    for (const [code, items] of groupByCode(warnings)) {
      L.push(`**${ICON[code]} ${code}** — ${items.length}`, '');
      for (const w of items.slice(0, MAX_ITEMS_PER_SECTION)) {
        L.push(`- ${w.level === 'error' ? '**' : ''}${w.message}${w.level === 'error' ? '**' : ''}`);
      }
      if (items.length > MAX_ITEMS_PER_SECTION) {
        L.push(`- _… et ${items.length - MAX_ITEMS_PER_SECTION} autres_`);
      }
      L.push('');
    }
    if (collapsed) L.push('</details>', '');
  };

  warningSection('⚠️ Nouvelles anomalies', diff.newWarnings, false);

  if (diff.resolvedWarnings.length > 0) {
    L.push(`### ✅ Anomalies résolues (${diff.resolvedWarnings.length})`, '');
    for (const w of diff.resolvedWarnings.slice(0, MAX_ITEMS_PER_SECTION)) {
      L.push(`- ~~${w.code} — ${w.message}~~`);
    }
    if (diff.resolvedWarnings.length > MAX_ITEMS_PER_SECTION) {
      L.push(`- _… et ${diff.resolvedWarnings.length - MAX_ITEMS_PER_SECTION} autres_`);
    }
    L.push('');
  }

  const persistent = map.warnings.filter(
    (w) => !diff.newWarnings.some((n) => warnKey(n) === warnKey(w)),
  );
  warningSection('Anomalies persistantes', persistent, true);

  return L.join('\n');
}
