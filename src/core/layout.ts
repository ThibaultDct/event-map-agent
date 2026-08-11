import ELK from 'elkjs/lib/elk.bundled.js';
import type { Confidence, EventMap, MessageKind } from '../model.js';

export interface GraphNode {
  id: string;
  label: string;
  sublabel?: string;
  type: 'service' | 'queue';
  /** Pour les services : api | worker. Pour les queues : main | dlq | retry. */
  variant: string;
  width: number;
  height: number;
  x: number;
  y: number;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: MessageKind;
  confidence: Confidence;
  /** Détail complet, affiché au survol dans le viewer. */
  routingKeys: string[];
  queues: string[];
  meta: Record<string, unknown>;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export interface LaidOutGraph {
  /** Services seuls, arêtes agrégées : la vue « qui envoie quoi à qui ». */
  service: GraphView;
  /** Services + queues intermédiaires : la vue topologique. */
  detailed: GraphView;
}

const NODE_W = 190;
const NODE_H = 60;
const QUEUE_W = 170;
const QUEUE_H = 44;

/** Un label d'arête lisible : 3 clés max, puis un compteur. */
function summarizeKeys(keys: string[]): string {
  const uniq = [...new Set(keys)].sort();
  if (uniq.length <= 3) return uniq.join('\n');
  return `${uniq.slice(0, 3).join('\n')}\n+${uniq.length - 3} autres`;
}

/** La confiance d'un agrégat est celle de son maillon le plus faible. */
function weakest(list: Confidence[]): Confidence {
  const order: Confidence[] = ['dynamic', 'observed', 'literal', 'resolved', 'declared'];
  for (const c of order) if (list.includes(c)) return c;
  return 'declared';
}

function buildServiceView(map: EventMap): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const used = new Set<string>();
  const grouped = new Map<string, typeof map.flows>();

  for (const f of map.flows) {
    const k = `${f.from}→${f.to}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(f);
    used.add(f.from);
    used.add(f.to);
  }

  // On garde tous les services connus, même isolés : un service qui n'échange
  // rien est en soi une information.
  const nodes: GraphNode[] = map.services.map((s) => ({
    id: s.id,
    label: s.name,
    sublabel: `${s.namespace} · ${s.kind}${s.replicas > 1 ? ` ×${s.replicas}` : ''}`,
    type: 'service',
    variant: s.kind,
    width: NODE_W,
    height: NODE_H,
    x: 0,
    y: 0,
    meta: {
      namespace: s.namespace,
      replicas: s.replicas,
      image: s.image,
      manifestOk: s.manifestOk,
      isolated: !used.has(s.id),
      stale: (s.missingRuns ?? 0) > 0,
    },
  }));

  const known = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const [k, flows] of grouped) {
    const first = flows[0]!;
    if (!known.has(first.from) || !known.has(first.to)) continue;
    const kinds = new Set(flows.map((f) => f.kind));
    edges.push({
      id: k,
      source: first.from,
      target: first.to,
      label: summarizeKeys(flows.map((f) => f.routingKey)),
      kind: kinds.size === 1 ? first.kind : 'unknown',
      confidence: weakest(flows.map((f) => f.confidence)),
      routingKeys: [...new Set(flows.map((f) => f.routingKey))].sort(),
      queues: [...new Set(flows.map((f) => f.queue))].sort(),
      meta: {
        count: flows.length,
        payloads: [...new Set(flows.map((f) => f.payload).filter(Boolean))],
        sources: [...new Set(flows.map((f) => f.source).filter(Boolean))],
        stale: flows.every((f) => (f.missingRuns ?? 0) > 0),
      },
    });
  }

  return { nodes, edges };
}

/**
 * Vue topologique : services + queues.
 *
 * Elle inclut **toutes les queues bindées**, pas seulement celles traversées par
 * un flux résolu, et tire les arêtes queue→consommateur depuis `subscribes`
 * plutôt que depuis les flux. C'est ce qui rend les pathologies visibles au lieu
 * de les faire disparaître :
 *
 *   - queue affamée : une flèche part vers son worker, mais rien n'entre ;
 *   - queue fantôme : un producteur y pousse, et la flèche s'arrête là ;
 *   - queue morte   : le nœud flotte, isolé des deux côtés.
 *
 * Une vue construite uniquement à partir des flux masquait précisément les trois.
 */
function buildDetailedView(map: EventMap): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const base = buildServiceView(map);
  const nodes: GraphNode[] = base.nodes.map((n) => ({ ...n }));
  const edges: GraphEdge[] = [];
  const queueByName = new Map(map.queues.map((q) => [q.name, q]));

  const queueIds = new Set<string>();
  const addQueue = (name: string) => {
    const id = `queue:${name}`;
    if (queueIds.has(id)) return id;
    queueIds.add(id);
    const q = queueByName.get(name);
    nodes.push({
      id,
      label: name,
      sublabel: q ? `${q.consumerCount} conso · ${q.messages} msg` : 'non déclarée',
      type: 'queue',
      variant: q?.role ?? 'main',
      width: QUEUE_W,
      height: QUEUE_H,
      x: 0,
      y: 0,
      meta: {
        durable: q?.durable,
        autoDelete: q?.autoDelete,
        messages: q?.messages,
        consumerCount: q?.consumerCount,
      },
    });
    return id;
  };

  // Toutes les queues bindées entrent dans le graphe, flux ou pas.
  const patternsOf = new Map<string, string[]>();
  for (const b of map.bindings) {
    addQueue(b.queue);
    if (!patternsOf.has(b.queue)) patternsOf.set(b.queue, []);
    patternsOf.get(b.queue)!.push(b.pattern);
  }

  // producteur → queue, agrégé par couple
  const pubGroups = new Map<string, typeof map.flows>();
  for (const f of map.flows) {
    const pk = `${f.from}|${f.queue}`;
    if (!pubGroups.has(pk)) pubGroups.set(pk, []);
    pubGroups.get(pk)!.push(f);
  }

  for (const [, flows] of pubGroups) {
    const f = flows[0]!;
    const qid = addQueue(f.queue);
    edges.push({
      id: `pub:${f.from}|${f.queue}`,
      source: f.from,
      target: qid,
      label: summarizeKeys(flows.map((x) => x.routingKey)),
      kind: f.kind,
      confidence: weakest(flows.map((x) => x.confidence)),
      routingKeys: [...new Set(flows.map((x) => x.routingKey))].sort(),
      queues: [f.queue],
      meta: { exchange: f.exchange, pattern: f.pattern },
    });
  }

  // queue → consommateur, depuis les abonnements et non depuis les flux : un
  // worker qui écoute une queue que personne n'alimente doit rester relié à elle.
  const known = new Set(nodes.map((n) => n.id));
  for (const s of map.subscribes) {
    if (!known.has(s.service)) continue;
    const qid = addQueue(s.queue);
    edges.push({
      id: `sub:${s.queue}|${s.service}`,
      source: qid,
      target: s.service,
      label: '',
      kind: 'unknown',
      confidence: s.confidence,
      routingKeys: [],
      queues: [s.queue],
      meta: { patterns: patternsOf.get(s.queue) ?? [] },
    });
  }

  return { nodes, edges };
}

/**
 * Seuil de bascule entre les deux stratégies de placement.
 *
 * `NETWORK_SIMPLEX` produit un graphe environ 2,2× plus compact en hauteur, ce
 * qui compte pour un diagramme lu par des humains — mais son coût explose avec
 * la taille. Mesures sur un système de 26 services (146 queues, 492 flux) :
 *
 *   vue services   26 nœuds / 118 arêtes   NETWORK_SIMPLEX  1,2 s
 *   vue détaillée  95 nœuds / 198 arêtes   NETWORK_SIMPLEX 11,4 s   BRANDES_KOEPF 0,2 s
 *   (à 380 nœuds : 23 s contre 0,5 s — le facteur reste autour de 40-50×)
 *
 * D'où ce seuil : la vue services, celle qu'on lit vraiment, garde le placement
 * soigné ; la vue détaillée, qu'on explore dans draw.io, bascule sur le rapide.
 * Le job passe ainsi de ~12,6 s à ~1,4 s de layout sans rien perdre d'utile.
 *
 * Relever `LAYOUT_MAX_EXACT_NODES` si la compacité de la vue détaillée compte
 * plus que la durée du job.
 */
const DEFAULT_MAX_EXACT_NODES = 60;

export interface LayoutOptions {
  maxExactNodes?: number;
  /** Reçoit un compte-rendu par vue : stratégie retenue et durée. */
  onProgress?: (msg: string) => void;
}

/**
 * Applique un layout en couches à un ensemble de nœuds/arêtes et renvoie les
 * positions. Exporté pour que les vues ego (une par service) réutilisent
 * exactement le même moteur et le même paramétrage que les vues globales.
 */
export async function layoutView(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { compact?: boolean; spacing?: number; nodeSpacing?: number } = {},
): Promise<GraphView> {
  const view = { nodes, edges };
  const compact = opts.compact ?? true;
  const elk = new ELK();

  const laid = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.spacing ?? 140),
      'elk.spacing.nodeNode': String(opts.nodeSpacing ?? 48),
      'elk.layered.nodePlacement.strategy': compact ? 'NETWORK_SIMPLEX' : 'BRANDES_KOEPF',
      // Les cycles sont normaux dans un système événementiel (A → B → A) :
      // il faut que le layout les tolère au lieu de s'emballer.
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      // On ne consomme que les positions des nœuds — les tracés d'arêtes calculés
      // par ELK sont jetés, draw.io et Cytoscape refont le leur. POLYLINE est le
      // mode le moins cher qui produise quand même un placement correct.
      'elk.edgeRouting': 'POLYLINE',
    },
    children: view.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    // Les boucles sur soi n'influencent aucune position et perturbent le
    // découpage en couches : on les retire du calcul, les renderers les
    // dessinent quand même à partir de `view.edges`.
    edges: view.edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });

  const pos = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const placed = view.nodes.map((n) => ({
    ...n,
    x: pos.get(n.id)?.x ?? 0,
    y: pos.get(n.id)?.y ?? 0,
  }));

  const width = Math.max(1, ...placed.map((n) => n.x + n.width)) + 60;
  const height = Math.max(1, ...placed.map((n) => n.y + n.height)) + 60;

  return { nodes: placed, edges: view.edges, width, height };
}

/**
 * Le layout est calculé **une seule fois, côté job**, puis réutilisé tel quel
 * par l'export DrawIO et par le viewer. Les deux vues sont ainsi rigoureusement
 * superposables, et le viewer n'a pas besoin d'embarquer un moteur de layout.
 */
export async function layoutGraph(map: EventMap, opts: LayoutOptions = {}): Promise<LaidOutGraph> {
  const maxExact = opts.maxExactNodes ?? DEFAULT_MAX_EXACT_NODES;

  const run = async (
    built: { nodes: GraphNode[]; edges: GraphEdge[] },
    label: string,
  ): Promise<GraphView> => {
    const compact = built.nodes.length <= maxExact;
    const started = Date.now();
    const view = await layoutView(built.nodes, built.edges, { compact });
    opts.onProgress?.(
      `${label} : ${built.nodes.length} nœuds, ${built.edges.length} arêtes, ` +
        `${compact ? 'NETWORK_SIMPLEX' : 'BRANDES_KOEPF'} en ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return view;
  };

  // Séquentiel, et pas Promise.all : elkjs est du Java compilé en JS, mono-thread
  // et purement CPU. Les lancer « en parallèle » ne gagne rien et rend les durées
  // mesurées inexploitables — chaque vue se voit imputer le temps de l'autre.
  const service = await run(buildServiceView(map), 'vue services');
  const detailed = await run(buildDetailedView(map), 'vue détaillée');
  return { service, detailed };
}
