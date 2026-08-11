import type { Confidence, EventMap, FlowEdge, MessageKind } from '../model.js';
import { layoutView, type GraphEdge, type GraphNode, type GraphView } from './layout.js';

/**
 * Un message vu depuis un service : la clé, sa nature, et qui est à l'autre bout.
 *
 * C'est la brique de la fiche entrée/sortie. Un graphe oblige à suivre une arête
 * puis à lire une étiquette tronquée pour répondre à « d'où vient ce message ? » ;
 * ici la réponse est sur la ligne.
 */
export interface EgoMessage {
  routingKey: string;
  kind: MessageKind;
  /** Producteurs pour un entrant, consommateurs pour un sortant. */
  partners: string[];
  queues: string[];
  payload?: string;
  /** Emplacement Java de la publication, pour les sortants. */
  source?: string;
  confidence: Confidence;
  /** Sortant publié que personne ne consomme — le broker jette le message. */
  orphan?: boolean;
}

export interface EgoGraph extends GraphView {
  service: string;
  upstream: number;
  downstream: number;
  inbound: EgoMessage[];
  outbound: EgoMessage[];
}

const NODE_W = 190;
// Volontairement compact : un service très sollicité empile vingt partenaires
// dans une seule colonne, et chaque pixel de hauteur se paie en zoom perdu.
const NODE_H = 50;

/**
 * Voisinage à un saut d'un service : ses producteurs à gauche, lui au centre,
 * ses consommateurs à droite.
 *
 * C'est la réponse au vrai problème du graphe global : à degré moyen 9, un
 * service *isolé* reste parfaitement lisible — c'est uniquement leur
 * superposition qui produit le plat de nouilles. On ne change donc pas la
 * donnée, on change la portée de ce qu'on affiche à la fois.
 *
 * Les queues ne sont volontairement pas représentées ici : la page ego répond à
 * « qui me parle et à qui je parle ». La topologie des queues a sa propre vue.
 */
function buildEgo(
  map: EventMap,
  serviceId: string,
): { nodes: GraphNode[]; edges: GraphEdge[]; inbound: EgoMessage[]; outbound: EgoMessage[] } {
  const byId = new Map(map.services.map((s) => [s.id, s]));
  const center = byId.get(serviceId);
  if (!center) return { nodes: [], edges: [], inbound: [], outbound: [] };

  const inbound = new Map<string, FlowEdge[]>();
  const outbound = new Map<string, FlowEdge[]>();
  /** Le service consomme ses propres événements : boucle sur lui-même. */
  const selfLoop: FlowEdge[] = [];
  for (const f of map.flows) {
    if (f.from === serviceId && f.to === serviceId) {
      selfLoop.push(f);
      continue;
    }
    if (f.to === serviceId) {
      if (!inbound.has(f.from)) inbound.set(f.from, []);
      inbound.get(f.from)!.push(f);
    }
    if (f.from === serviceId) {
      if (!outbound.has(f.to)) outbound.set(f.to, []);
      outbound.get(f.to)!.push(f);
    }
  }

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  const addService = (id: string, role: 'center' | 'upstream' | 'downstream') => {
    if (seen.has(id)) return;
    seen.add(id);
    const s = byId.get(id);
    if (!s) return;
    nodes.push({
      id,
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
        role,
        stale: (s.missingRuns ?? 0) > 0,
      },
    });
  };

  for (const id of inbound.keys()) addService(id, 'upstream');
  addService(serviceId, 'center');
  for (const id of outbound.keys()) addService(id, 'downstream');

  /**
   * L'étiquette d'arête donne les **volumes par nature**, pas la liste des clés.
   * Empiler quatre routing keys sur une arête produisait un pavé illisible dès
   * qu'un couple de services échange plus de deux ou trois messages ; le détail
   * exhaustif vit dans la fiche entrée/sortie, où il a la place de respirer.
   */
  const summarize = (flows: FlowEdge[]) => {
    const keys = new Map<string, MessageKind>();
    for (const f of flows) keys.set(f.routingKey, f.kind);
    let evt = 0;
    let cmd = 0;
    let other = 0;
    for (const k of keys.values()) {
      if (k === 'event') evt++;
      else if (k === 'command') cmd++;
      else other++;
    }
    const parts: string[] = [];
    if (evt) parts.push(`${evt} evt`);
    if (cmd) parts.push(`${cmd} cmd`);
    if (other) parts.push(`${other} ?`);
    return { label: parts.join(' · '), total: keys.size, evt, cmd };
  };

  const edges: GraphEdge[] = [];
  const push = (from: string, to: string, flows: FlowEdge[]) => {
    const kinds = new Set(flows.map((f) => f.kind));
    const s = summarize(flows);
    edges.push({
      id: `${from}→${to}`,
      source: from,
      target: to,
      label: s.label,
      kind: kinds.size === 1 ? flows[0]!.kind : 'unknown',
      confidence: flows.some((f) => f.confidence === 'observed') ? 'observed' : 'declared',
      routingKeys: [...new Set(flows.map((f) => f.routingKey))].sort(),
      queues: [...new Set(flows.map((f) => f.queue))].sort(),
      meta: {
        payloads: [...new Set(flows.map((f) => f.payload).filter(Boolean))],
        sources: [...new Set(flows.map((f) => f.source).filter(Boolean))],
        total: s.total,
        evt: s.evt,
        cmd: s.cmd,
      },
    });
  };

  for (const [from, flows] of inbound) push(from, serviceId, flows);
  for (const [to, flows] of outbound) push(serviceId, to, flows);
  if (selfLoop.length > 0) push(serviceId, serviceId, selfLoop);

  return { nodes, edges, ...buildMessages(map, serviceId) };
}

/**
 * La fiche entrée/sortie du service.
 *
 * Les sortants partent de `publishes` et non des flux : un message publié que
 * personne ne consomme n'a aucun flux associé, et disparaîtrait de la fiche
 * alors que c'est précisément ce qu'on veut voir — le broker le jette.
 */
function buildMessages(map: EventMap, serviceId: string): { inbound: EgoMessage[]; outbound: EgoMessage[] } {
  const inGroups = new Map<string, EgoMessage>();
  for (const f of map.flows) {
    if (f.to !== serviceId) continue;
    let m = inGroups.get(f.routingKey);
    if (!m) {
      m = {
        routingKey: f.routingKey,
        kind: f.kind,
        partners: [],
        queues: [],
        payload: f.payload,
        confidence: f.confidence,
      };
      inGroups.set(f.routingKey, m);
    }
    if (!m.partners.includes(f.from)) m.partners.push(f.from);
    if (!m.queues.includes(f.queue)) m.queues.push(f.queue);
    if (!m.payload && f.payload) m.payload = f.payload;
  }

  const outGroups = new Map<string, EgoMessage>();
  for (const p of map.publishes) {
    if (p.service !== serviceId) continue;
    outGroups.set(p.routingKey, {
      routingKey: p.routingKey,
      kind: p.kind,
      partners: [],
      queues: [],
      payload: p.payload,
      source: p.source,
      confidence: p.confidence,
      orphan: true,
    });
  }
  for (const f of map.flows) {
    if (f.from !== serviceId) continue;
    const m = outGroups.get(f.routingKey);
    if (!m) continue;
    m.orphan = false;
    if (!m.partners.includes(f.to)) m.partners.push(f.to);
    if (!m.queues.includes(f.queue)) m.queues.push(f.queue);
  }

  // Tri par clé : la convention `evt.` / `cmd.` regroupe naturellement les
  // messages de même nature, sans qu'on ait à trier sur le champ `kind`.
  const finish = (groups: Map<string, EgoMessage>) =>
    [...groups.values()]
      .map((m) => ({ ...m, partners: m.partners.sort(), queues: m.queues.sort() }))
      .sort((a, b) => a.routingKey.localeCompare(b.routingKey));

  return { inbound: finish(inGroups), outbound: finish(outGroups) };
}

/**
 * Calcule une vue ego par service. Chaque graphe est minuscule (une vingtaine de
 * nœuds au plus), donc on garde le placement compact partout — mesuré à quelques
 * millisecondes par service.
 */
export async function buildEgoGraphs(map: EventMap): Promise<Record<string, EgoGraph>> {
  const out: Record<string, EgoGraph> = {};
  for (const s of map.services) {
    const built = buildEgo(map, s.id);
    if (built.nodes.length === 0) continue;
    const view = await layoutView(built.nodes, built.edges, {
      compact: true,
      spacing: 280,
      nodeSpacing: 22,
    });
    out[s.id] = {
      ...view,
      service: s.id,
      upstream: built.edges.filter((e) => e.target === s.id && e.source !== s.id).length,
      downstream: built.edges.filter((e) => e.source === s.id && e.target !== s.id).length,
      inbound: built.inbound,
      outbound: built.outbound,
    };
  }
  return out;
}
