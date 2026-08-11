import type { EventMap, MessageKind } from '../model.js';
import { seriate } from './seriate.js';

export interface MatrixCell {
  from: string;
  to: string;
  /** Nombre de routing keys distinctes passant de `from` à `to`. */
  count: number;
  routingKeys: string[];
  queues: string[];
  kind: MessageKind | 'mixed';
  /** true si toutes les arêtes sous-jacentes sont en sursis (non revues). */
  stale: boolean;
}

export interface MatrixService {
  id: string;
  name: string;
  namespace: string;
  kind: 'api' | 'worker' | 'unknown';
  /** Nombre de partenaires distincts, pour l'échelle des en-têtes. */
  outDegree: number;
  inDegree: number;
}

export interface MatrixData {
  /** Ordre sérié, commun aux lignes et aux colonnes. */
  order: string[];
  services: Record<string, MatrixService>;
  cells: MatrixCell[];
  /** Plus grand `count`, pour normaliser l'intensité des cellules. */
  max: number;
  /** Taux de remplissage, utile pour juger si la matrice reste lisible. */
  density: number;
}

/**
 * Construit la matrice producteurs × consommateurs.
 *
 * Ligne = producteur, colonne = consommateur — la convention habituelle des
 * matrices de dépendances, et celle qui fait qu'un consommateur transverse se
 * lit comme une colonne pleine plutôt que comme une ligne.
 */
export function buildMatrix(map: EventMap): MatrixData {
  const byPair = new Map<string, MatrixCell>();

  for (const f of map.flows) {
    const key = `${f.from}|${f.to}`;
    let cell = byPair.get(key);
    if (!cell) {
      cell = {
        from: f.from,
        to: f.to,
        count: 0,
        routingKeys: [],
        queues: [],
        kind: f.kind,
        stale: true,
      };
      byPair.set(key, cell);
    }
    if (!cell.routingKeys.includes(f.routingKey)) cell.routingKeys.push(f.routingKey);
    if (!cell.queues.includes(f.queue)) cell.queues.push(f.queue);
    if (cell.kind !== f.kind) cell.kind = 'mixed';
    if ((f.missingRuns ?? 0) === 0) cell.stale = false;
  }

  const cells = [...byPair.values()];
  for (const c of cells) {
    c.routingKeys.sort();
    c.queues.sort();
    c.count = c.routingKeys.length;
  }

  const weightMap = new Map(cells.map((c) => [`${c.from}|${c.to}`, c.count]));
  const weight = (from: string, to: string) => weightMap.get(`${from}|${to}`) ?? 0;

  const ids = map.services.map((s) => s.id);
  const order = seriate({ ids, weight });

  const services: Record<string, MatrixService> = {};
  for (const s of map.services) {
    services[s.id] = {
      id: s.id,
      name: s.name,
      namespace: s.namespace,
      kind: s.kind,
      outDegree: cells.filter((c) => c.from === s.id).length,
      inDegree: cells.filter((c) => c.to === s.id).length,
    };
  }

  const n = ids.length || 1;
  return {
    order,
    services,
    cells: cells.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`)),
    max: cells.reduce((m, c) => Math.max(m, c.count), 0),
    density: cells.length / (n * n),
  };
}
