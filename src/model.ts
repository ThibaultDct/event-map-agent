/**
 * Représentation intermédiaire (IR) de la topologie événementielle.
 *
 * C'est le contrat entre les collecteurs (K8s, RabbitMQ, manifestes de service)
 * et les renderers (drawio, viewer, diff). Tout ce qui est ajouté ici doit rester
 * sérialisable en JSON stable : le fichier est commité et diffé d'un run à l'autre.
 */

/** D'où vient l'information, et à quel point on lui fait confiance. */
export type Confidence =
  /** Déclaré explicitement (binding broker, @RabbitListener, @PublishesEvent). */
  | 'declared'
  /** Chaîne littérale trouvée à l'appel. */
  | 'literal'
  /** Constante `static final` résolue par le scanner. */
  | 'resolved'
  /** Routing key construite dynamiquement : arête approximative. */
  | 'dynamic'
  /** Vue passer au runtime, mais pas déclarée : preuve d'existence, pas d'exhaustivité. */
  | 'observed';

export type MessageKind = 'event' | 'command' | 'unknown';

/** Rôle inféré d'une queue d'après sa convention de nommage. */
export type QueueRole = 'main' | 'dlq' | 'retry';

export interface ServiceNode {
  /** Clé canonique `namespace/workload` — unique à l'échelle du cluster. */
  id: string;
  /** Nom du Deployment / StatefulSet, ou label app.kubernetes.io/name. Affichage. */
  name: string;
  namespace: string;
  kind: 'api' | 'worker' | 'unknown';
  replicas: number;
  image?: string;
  /** true si /internal/event-manifest a répondu sur au moins un pod. */
  manifestOk: boolean;
  /** Runs consécutifs sans avoir été vu (0 = vu à ce run). */
  missingRuns?: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface ExchangeNode {
  name: string;
  type: string;
  vhost: string;
  durable: boolean;
  internal: boolean;
}

export interface QueueNode {
  name: string;
  vhost: string;
  durable: boolean;
  autoDelete: boolean;
  exclusive: boolean;
  messages: number;
  consumerCount: number;
  role: QueueRole;
}

export interface BindingEdge {
  exchange: string;
  queue: string;
  pattern: string;
  /**
   * `broker` : présent dans RabbitMQ uniquement.
   * `code`   : déclaré dans le contexte Spring mais absent du broker (drift).
   * `both`   : cohérent.
   */
  origin: 'broker' | 'code' | 'both';
}

/**
 * Un champ du payload, chemin aplati depuis la racine.
 *
 * Plat et non arborescent parce que la comparaison de deux versions se réduit
 * alors à une différence d'ensembles, et que le message d'alerte se lit tel quel
 * (« champ `lines[].sku` supprimé »).
 */
export interface SchemaField {
  /** Ex. `customer.address.city`, `lines[].sku`, `attributes{}`. */
  path: string;
  /** FQN, type primitif, `enum[A,B]` ou `Map<K,V>`. */
  type: string;
}

export interface Publication {
  service: string;
  exchange: string;
  routingKey: string;
  payload?: string;
  kind: MessageKind;
  confidence: Confidence;
  /** Ex. `src/main/java/com/acme/OrderService.java:42`. */
  source?: string;
  /** Schéma aplati du payload, extrait à la compilation par l'agent. */
  schema?: SchemaField[];
}

export interface Subscription {
  service: string;
  queue: string;
  handler?: string;
  confidence: Confidence;
}

/** Arête résolue : un producteur atteint un consommateur via un binding. */
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  exchange: string;
  routingKey: string;
  queue: string;
  pattern: string;
  kind: MessageKind;
  payload?: string;
  confidence: Confidence;
  source?: string;
  firstSeen?: string;
  lastSeen?: string;
  /** Runs consécutifs sans avoir été observée. Sert au TTL de suppression. */
  missingRuns?: number;
}

export type WarningCode =
  /** Événement publié que personne ne consomme. */
  | 'orphan-event'
  /** Queue bindée sans aucun consommateur connecté. */
  | 'ghost-queue'
  /** Consommateur dont l'IP ne correspond à aucun pod connu. */
  | 'unknown-consumer'
  /** Pod injoignable ou sans endpoint de manifeste. */
  | 'manifest-unreachable'
  /** Binding déclaré dans le code mais absent du broker (ou l'inverse). */
  | 'binding-drift'
  /** Routing key non résolue statiquement. */
  | 'dynamic-key'
  /** Consommateur d'une queue qu'aucun producteur connu n'alimente. */
  | 'starved-queue';

export interface Warning {
  level: 'error' | 'warn' | 'info';
  code: WarningCode;
  message: string;
  ref?: string;
}

export interface EventMap {
  /** Version du schéma de l'IR — bump en cas de changement cassant. */
  schemaVersion: 1;
  generatedAt: string;
  cluster?: string;
  services: ServiceNode[];
  exchanges: ExchangeNode[];
  queues: QueueNode[];
  bindings: BindingEdge[];
  publishes: Publication[];
  subscribes: Subscription[];
  flows: FlowEdge[];
  warnings: Warning[];
}

/** Payload servi par /internal/event-manifest (agent Java). */
export interface ServiceManifest {
  service: string;
  consumes: Array<{ exchange: string; queue: string; pattern: string }>;
  listening: string[];
  publishes: Array<{
    exchange?: string;
    routingKey: string;
    payload?: string;
    kind?: MessageKind;
    source?: string;
    schema?: SchemaField[];
  }>;
  observed?: Array<{ exchange: string; routingKey: string; payload?: string }>;
}

export function emptyMap(): EventMap {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    services: [],
    exchanges: [],
    queues: [],
    bindings: [],
    publishes: [],
    subscribes: [],
    flows: [],
    warnings: [],
  };
}
