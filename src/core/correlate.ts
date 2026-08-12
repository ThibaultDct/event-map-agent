import { classifyKey, classifyQueue, type Config } from '../config.js';
import type { K8sSnapshot } from '../collectors/kubernetes.js';
import type { RabbitSnapshot } from '../collectors/rabbitmq.js';
import type { ServiceManifest } from '../model.js';
import {
  emptyMap,
  type BindingEdge,
  type EventMap,
  type FlowEdge,
  type Publication,
  type Subscription,
  type Warning,
} from '../model.js';
import { amqpMatch, isPattern } from './amqp.js';
import { isEmptyDelta, schemaDelta } from './contract.js';

export interface CorrelateInput {
  k8s: K8sSnapshot;
  rabbit: RabbitSnapshot;
  manifests: Map<string, ServiceManifest>;
  warnings: Warning[];
  cfg: Config;
}

function bindingKey(exchange: string, queue: string, pattern: string): string {
  return `${exchange}|${queue}|${pattern}`;
}

/**
 * Assemble l'IR à partir des trois collecteurs.
 *
 * Ordre de construction volontaire : on part de ce qui est certain (topologie
 * broker), on y greffe ce qui est déclaré (manifestes), et on ne résout les
 * arêtes producteur→consommateur qu'en dernier, une fois les deux moitiés en place.
 */
export function correlate(input: CorrelateInput): EventMap {
  const { k8s, rabbit, manifests, cfg } = input;
  const map = emptyMap();
  const now = map.generatedAt;

  map.cluster = cfg.clusterName;
  map.warnings = [...input.warnings];
  map.services = k8s.services.map((s) => ({
    ...s,
    manifestOk: manifests.has(s.id),
    firstSeen: now,
    lastSeen: now,
    missingRuns: 0,
  }));

  // ---------------------------------------------------------------- exchanges
  map.exchanges = rabbit.exchanges.map((e) => ({
    name: e.name,
    type: e.type,
    vhost: e.vhost,
    durable: e.durable,
    internal: e.internal,
  }));

  const topicExchanges = map.exchanges.filter((e) => e.type === 'topic');
  /** Utilisé quand un manifeste déclare une publication sans nommer l'exchange. */
  const defaultExchange = topicExchanges.length === 1 ? topicExchanges[0]!.name : undefined;

  // ------------------------------------------------------------------- queues
  map.queues = rabbit.queues.map((q) => ({
    name: q.name,
    vhost: q.vhost,
    durable: q.durable,
    autoDelete: q.auto_delete,
    exclusive: q.exclusive,
    messages: q.messages ?? 0,
    consumerCount: q.consumers ?? 0,
    role: classifyQueue(q.name, cfg),
  }));

  // ----------------------------------------------------------------- bindings
  // Le broker fait foi ; les manifestes servent à détecter la dérive.
  const bindings = new Map<string, BindingEdge>();
  for (const b of rabbit.bindings) {
    const k = bindingKey(b.source, b.destination, b.routing_key);
    bindings.set(k, {
      exchange: b.source,
      queue: b.destination,
      pattern: b.routing_key,
      origin: 'broker',
    });
  }

  for (const [svcId, m] of manifests) {
    for (const c of m.consumes ?? []) {
      const k = bindingKey(c.exchange, c.queue, c.pattern);
      const existing = bindings.get(k);
      if (existing) {
        existing.origin = 'both';
      } else {
        bindings.set(k, {
          exchange: c.exchange,
          queue: c.queue,
          pattern: c.pattern,
          origin: 'code',
        });
        map.warnings.push({
          level: 'warn',
          code: 'binding-drift',
          message:
            `${svcId} déclare le binding ${c.exchange} --[${c.pattern}]--> ${c.queue} ` +
            `mais il est absent du broker. Déploiement incomplet, ou binding créé à la première connexion ?`,
          ref: k,
        });
      }
    }
  }
  map.bindings = [...bindings.values()];

  // -------------------------------------------------------------- subscribers
  // Source primaire : les consommateurs réellement connectés, corrélés par IP.
  const subs = new Map<string, Subscription>();
  const subsByQueue = new Map<string, Set<string>>();

  // Ce que chaque handler sait lire, indexé par (service, queue) : c'est ce qui
  // permettra de confronter le contrat au producteur.
  const expectations = new Map<string, { payload: string; schema?: typeof map.publishes[0]['schema']; handler: string }>();
  for (const [svcId, m] of manifests) {
    for (const e of m.expects ?? []) {
      for (const q of e.queues ?? []) {
        expectations.set(`${svcId}|${q}`, { payload: e.payload, schema: e.schema, handler: e.handler });
      }
    }
  }

  const addSub = (service: string, queue: string, confidence: Subscription['confidence']) => {
    const k = `${service}|${queue}`;
    if (!subs.has(k)) {
      const expected = expectations.get(k);
      subs.set(k, {
        service,
        queue,
        confidence,
        payload: expected?.payload,
        handler: expected?.handler,
        schema: expected?.schema
          ? [...expected.schema].sort((a, b) => a.path.localeCompare(b.path))
          : undefined,
      });
    }
    if (!subsByQueue.has(queue)) subsByQueue.set(queue, new Set());
    subsByQueue.get(queue)!.add(service);
  };

  for (const c of rabbit.consumers) {
    const ip = c.channel_details?.peer_host;
    const pod = ip ? k8s.byIp.get(ip) : undefined;
    if (!pod) {
      map.warnings.push({
        level: 'warn',
        code: 'unknown-consumer',
        message:
          `La queue ${c.queue.name} est consommée depuis ${ip ?? 'une IP inconnue'}, ` +
          `qui ne correspond à aucun pod scanné (hors namespace, hors cluster, ou port-forward ?).`,
        ref: c.queue.name,
      });
      continue;
    }
    addSub(`${pod.namespace}/${pod.workload}`, c.queue.name, 'declared');
  }

  // Source secondaire : les queues écoutées d'après le contexte Spring. Rattrape
  // les workers scale-to-zero ou déconnectés au moment du scan.
  for (const [svcId, m] of manifests) {
    for (const q of m.listening ?? []) addSub(svcId, q, 'declared');
  }
  map.subscribes = [...subs.values()];

  // --------------------------------------------------------------- publishers
  const publishes: Publication[] = [];
  for (const [svcId, m] of manifests) {
    for (const p of m.publishes ?? []) {
      const exchange = p.exchange ?? defaultExchange;
      if (!exchange) {
        map.warnings.push({
          level: 'warn',
          code: 'dynamic-key',
          message:
            `${svcId} publie "${p.routingKey}" sans exchange identifiable et le cluster expose ` +
            `${topicExchanges.length} exchanges topic : impossible de trancher.`,
          ref: `${svcId}|${p.routingKey}`,
        });
        continue;
      }
      if (isPattern(p.routingKey)) {
        map.warnings.push({
          level: 'warn',
          code: 'dynamic-key',
          message:
            `${svcId} déclare publier "${p.routingKey}", qui contient un joker AMQP. ` +
            `Une publication porte une clé concrète — vérifie l'annotation @PublishesEvent.`,
          ref: `${svcId}|${p.routingKey}`,
        });
      }
      publishes.push({
        service: svcId,
        exchange,
        routingKey: p.routingKey,
        payload: p.payload,
        kind: p.kind ?? classifyKey(p.routingKey, cfg),
        confidence: 'declared',
        source: p.source,
        // Trié pour que deux runs identiques produisent un JSON identique :
        // sinon le diff git se remplirait de réordonnancements.
        schema: p.schema
          ? [...p.schema].sort((a, b) => a.path.localeCompare(b.path))
          : undefined,
      });
    }

    // Les clés vues au runtime mais non déclarées comblent les trous laissés par
    // les routing keys construites dynamiquement.
    for (const o of m.observed ?? []) {
      const already = publishes.some(
        (p) => p.service === svcId && p.exchange === o.exchange && p.routingKey === o.routingKey,
      );
      if (already) continue;
      publishes.push({
        service: svcId,
        exchange: o.exchange,
        routingKey: o.routingKey,
        payload: o.payload,
        kind: classifyKey(o.routingKey, cfg),
        confidence: 'observed',
      });
    }
  }
  map.publishes = publishes;

  // -------------------------------------------------------------------- flows
  const bindingsByExchange = new Map<string, BindingEdge[]>();
  for (const b of map.bindings) {
    if (!bindingsByExchange.has(b.exchange)) bindingsByExchange.set(b.exchange, []);
    bindingsByExchange.get(b.exchange)!.push(b);
  }

  const flows: FlowEdge[] = [];
  const seenFlow = new Set<string>();
  /** Queues alimentées mais sans consommateur : queue → producteurs concernés. */
  const ghostFeeders = new Map<string, Set<string>>();

  for (const p of map.publishes) {
    const candidates = bindingsByExchange.get(p.exchange) ?? [];
    const matched = candidates.filter((b) => amqpMatch(b.pattern, p.routingKey));

    if (matched.length === 0) {
      map.warnings.push({
        level: 'warn',
        code: 'orphan-event',
        message:
          `${p.service} publie ${p.routingKey} sur ${p.exchange}, mais aucun binding ne matche : ` +
          `le message est jeté par le broker.`,
        ref: `${p.service}|${p.routingKey}`,
      });
      continue;
    }

    for (const b of matched) {
      const consumers = subsByQueue.get(b.queue);
      if (!consumers || consumers.size === 0) {
        // Pas de cible : on ne peut pas créer d'arête. On mémorise le producteur
        // pour n'émettre qu'une alerte par queue, et non une par routing key.
        if (!ghostFeeders.has(b.queue)) ghostFeeders.set(b.queue, new Set());
        ghostFeeders.get(b.queue)!.add(p.service);
        continue;
      }
      for (const to of consumers) {
        const id = `${p.service}→${to}|${p.exchange}|${p.routingKey}|${b.queue}`;
        if (seenFlow.has(id)) continue;
        seenFlow.add(id);
        flows.push({
          id,
          from: p.service,
          to,
          exchange: p.exchange,
          routingKey: p.routingKey,
          queue: b.queue,
          pattern: b.pattern,
          kind: p.kind,
          payload: p.payload,
          confidence: p.confidence,
          source: p.source,
          firstSeen: now,
          lastSeen: now,
          missingRuns: 0,
        });
      }
    }
  }
  map.flows = flows;

  // ------------------------------------------------ queues sans consommateur
  // On balaie **toutes** les queues bindées, pas seulement celles atteintes par
  // un producteur connu : une queue bindée que personne n'alimente et que
  // personne ne consomme est invisible dans le graphe alors qu'elle peut
  // accumuler des messages depuis des mois. C'est exactement ce qu'on veut voir.
  const queueByName = new Map(map.queues.map((q) => [q.name, q]));
  for (const queue of new Set(map.bindings.map((b) => b.queue))) {
    const q = queueByName.get(queue);
    // Queue absente du broker : elle ne peut rien accumuler, et le binding-drift
    // correspondant dit déjà tout. Une seconde alerte serait du bruit.
    if (!q) continue;
    // Une DLQ ou une queue de retry sans consommateur est un état normal.
    if (q.role !== 'main') continue;
    // Le broker voit des consommateurs mais on n'a pas su les rattacher à un pod :
    // c'est un unknown-consumer, déjà signalé — pas un fantôme.
    if (q.consumerCount > 0) continue;
    if ((subsByQueue.get(queue)?.size ?? 0) > 0) continue;

    const feeders = ghostFeeders.get(queue);
    const backlog = q.messages;
    const suffix = backlog > 0 ? ` ${backlog} message(s) en attente.` : '';
    map.warnings.push({
      level: backlog > 0 ? 'error' : 'warn',
      code: 'ghost-queue',
      message: feeders
        ? `${queue} est alimentée par ${[...feeders].sort().join(', ')} mais n'a aucun consommateur.${suffix}`
        : `${queue} est bindée mais n'a ni producteur connu ni consommateur.${suffix}`,
      ref: queue,
    });
  }

  // ---------------------------------------------------- queues jamais alimentées
  // L'inverse de l'événement orphelin : quelqu'un écoute, personne n'émet.
  const fedQueues = new Set(flows.map((f) => f.queue));
  for (const [queue, consumers] of subsByQueue) {
    if (fedQueues.has(queue)) continue;
    const role = map.queues.find((q) => q.name === queue)?.role ?? 'main';
    if (role !== 'main') continue; // DLQ et retry sont alimentées par le broker
    map.warnings.push({
      level: 'info',
      code: 'starved-queue',
      message:
        `${queue} est consommée par ${[...consumers].join(', ')} mais aucun producteur connu ne l'alimente. ` +
        `Producteur hors périmètre, ou routing key non déclarée ?`,
      ref: queue,
    });
  }

  detectSchemaDivergence(map);
  detectContractMismatch(map, subs);

  return map;
}

/** Résumé lisible d'un écart de schéma, tronqué pour rester dans un message. */
function summarizeDelta(delta: ReturnType<typeof schemaDelta>, leftLabel: string, rightLabel: string): string {
  const parts: string[] = [];
  const list = (fields: { path: string }[]) => fields.slice(0, 4).map((f) => f.path).join(', ')
    + (fields.length > 4 ? `, +${fields.length - 4}` : '');
  if (delta.onlyInLeft.length) parts.push(`absents chez ${rightLabel} : ${list(delta.onlyInLeft)}`);
  if (delta.onlyInRight.length) parts.push(`absents chez ${leftLabel} : ${list(delta.onlyInRight)}`);
  if (delta.typeMismatch.length) {
    parts.push(
      'types divergents : ' +
        delta.typeMismatch
          .slice(0, 3)
          .map((m) => `${m.path} (${short(m.left.type)} / ${short(m.right.type)})`)
          .join(', ') +
        (delta.typeMismatch.length > 3 ? `, +${delta.typeMismatch.length - 3}` : ''),
    );
  }
  return parts.join(' · ');
}

function short(type: string): string {
  if (type.startsWith('enum[') || type.startsWith('Map<')) return type;
  return type.split('.').pop() ?? type;
}

/**
 * Deux services publiant la même clé doivent publier la même chose.
 *
 * Sans ce contrôle, `indexSchemas` en retenait un arbitrairement pour la
 * comparaison temporelle : la divergence passait inaperçue, et le diff de
 * contrat se mettait à osciller selon lequel des deux gagnait.
 */
function detectSchemaDivergence(map: EventMap): void {
  const byKey = new Map<string, Publication[]>();
  for (const p of map.publishes) {
    if (!p.schema || p.schema.length === 0) continue;
    const k = `${p.exchange}|${p.routingKey}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(p);
  }

  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    const [reference, ...others] = list;
    for (const other of others) {
      const delta = schemaDelta(reference!.schema!, other.schema!);
      if (isEmptyDelta(delta)) continue;
      map.warnings.push({
        level: 'error',
        code: 'schema-divergence',
        message:
          `${reference!.service} et ${other.service} publient tous deux ${reference!.routingKey} ` +
          `avec des payloads différents — ${summarizeDelta(delta, reference!.service, other.service)}. ` +
          `Les consommateurs ne peuvent pas lire les deux.`,
        ref: k,
      });
    }
  }
}

/**
 * Confronte ce qu'un producteur envoie à ce que ses consommateurs savent lire.
 *
 * C'est le seul défaut qu'aucun test unitaire ne rattrape : il vit dans
 * l'intervalle entre deux services, et ne se manifeste qu'en production. Un
 * champ que le consommateur attend et que le producteur n'envoie pas casse la
 * désérialisation ou produit un `null` silencieux ; l'inverse est bénin, un
 * lecteur tolérant ignore ce qu'il ne connaît pas.
 */
function detectContractMismatch(map: EventMap, subs: Map<string, Subscription>): void {
  const seen = new Set<string>();

  for (const f of map.flows) {
    const producer = map.publishes.find(
      (p) => p.service === f.from && p.exchange === f.exchange && p.routingKey === f.routingKey,
    );
    const consumer = subs.get(`${f.to}|${f.queue}`);
    if (!producer?.schema?.length || !consumer?.schema?.length) continue;

    const id = `${f.routingKey}|${f.to}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const delta = schemaDelta(producer.schema, consumer.schema);
    // `onlyInRight` = attendu par le consommateur, jamais envoyé : c'est ce qui
    // casse. `onlyInLeft` = envoyé sans être lu, sans conséquence.
    const missing = delta.onlyInRight;
    if (missing.length === 0 && delta.typeMismatch.length === 0) continue;

    const details: string[] = [];
    if (missing.length) {
      details.push(`champs attendus jamais envoyés : ${missing.slice(0, 4).map((m) => m.path).join(', ')}`
        + (missing.length > 4 ? `, +${missing.length - 4}` : ''));
    }
    if (delta.typeMismatch.length) {
      details.push('types incompatibles : ' + delta.typeMismatch.slice(0, 3)
        .map((m) => `${m.path} envoyé ${short(m.left.type)}, attendu ${short(m.right.type)}`).join(' · '));
    }

    map.warnings.push({
      level: 'error',
      code: 'contract-mismatch',
      message:
        `${f.to} attend de ${f.from} un ${consumer.payload ?? 'payload'} incompatible sur ${f.routingKey} — ` +
        `${details.join(' ; ')}.` +
        (consumer.handler ? ` Handler : ${consumer.handler}.` : ''),
      ref: id,
    });
  }
}
