import type { Confidence, EventMap, MessageKind, SchemaField } from '../model.js';

export interface EventProducer {
  service: string;
  confidence: Confidence;
  source?: string;
  payload?: string;
}

export interface EventConsumer {
  service: string;
  queue: string;
  pattern: string;
}

export interface EventRow {
  routingKey: string;
  exchange: string;
  kind: MessageKind;
  producers: EventProducer[];
  consumers: EventConsumer[];
  payloads: string[];
  /** Schéma aplati du payload, quand l'agent a pu l'extraire. */
  schema?: SchemaField[];
  /** Publié mais consommé par personne : le broker jette le message. */
  orphan: boolean;
  /** Au moins un producteur n'est connu que par observation runtime. */
  observedOnly: boolean;
}

/**
 * Bascule le point de vue : l'événement devient l'objet de premier plan, les
 * services deviennent ses attributs.
 *
 * C'est la vue qui répond aux deux questions qu'on se pose réellement au
 * quotidien — « qui consomme `evt.order.created` ? » et « si je change ce
 * payload, qui casse ? » — auxquelles un graphe de services répond très mal :
 * il faut y suivre une arête, lire une étiquette tronquée, et deviner.
 */
export function buildEventCatalog(map: EventMap): EventRow[] {
  const rows = new Map<string, EventRow>();
  const keyOf = (exchange: string, routingKey: string) => `${exchange}|${routingKey}`;

  for (const p of map.publishes) {
    const k = keyOf(p.exchange, p.routingKey);
    let row = rows.get(k);
    if (!row) {
      row = {
        routingKey: p.routingKey,
        exchange: p.exchange,
        kind: p.kind,
        producers: [],
        consumers: [],
        payloads: [],
        orphan: true,
        observedOnly: false,
      };
      rows.set(k, row);
    }
    row.producers.push({
      service: p.service,
      confidence: p.confidence,
      source: p.source,
      payload: p.payload,
    });
    if (p.payload && !row.payloads.includes(p.payload)) row.payloads.push(p.payload);
    if (row.kind === 'unknown' && p.kind !== 'unknown') row.kind = p.kind;
    if (!row.schema && p.schema && p.schema.length > 0) row.schema = p.schema;
  }

  for (const f of map.flows) {
    const row = rows.get(keyOf(f.exchange, f.routingKey));
    // Un flux sans publication déclarée ne devrait pas exister : `correlate` les
    // dérive toutes de `publishes`. On ignore par prudence plutôt que de créer
    // une ligne fantôme sans producteur.
    if (!row) continue;
    row.orphan = false;
    const already = row.consumers.some((c) => c.service === f.to && c.queue === f.queue);
    if (!already) row.consumers.push({ service: f.to, queue: f.queue, pattern: f.pattern });
  }

  for (const row of rows.values()) {
    row.producers.sort((a, b) => a.service.localeCompare(b.service));
    row.consumers.sort((a, b) => a.service.localeCompare(b.service) || a.queue.localeCompare(b.queue));
    row.payloads.sort();
    row.observedOnly =
      row.producers.length > 0 && row.producers.every((p) => p.confidence === 'observed');
  }

  return [...rows.values()].sort(
    (a, b) => a.exchange.localeCompare(b.exchange) || a.routingKey.localeCompare(b.routingKey),
  );
}
