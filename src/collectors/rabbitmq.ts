import type { Config } from '../config.js';
import { encodeVhost } from '../core/amqp.js';

export interface RawExchange {
  name: string;
  vhost: string;
  type: string;
  durable: boolean;
  internal: boolean;
}

export interface RawQueue {
  name: string;
  vhost: string;
  durable: boolean;
  auto_delete: boolean;
  exclusive: boolean;
  messages?: number;
  consumers?: number;
}

export interface RawBinding {
  source: string;
  vhost: string;
  destination: string;
  destination_type: 'queue' | 'exchange';
  routing_key: string;
}

export interface RawConsumer {
  queue: { name: string; vhost: string };
  consumer_tag: string;
  channel_details?: {
    connection_name?: string;
    peer_host?: string;
    peer_port?: number;
    name?: string;
  };
}

export interface RabbitSnapshot {
  exchanges: RawExchange[];
  queues: RawQueue[];
  bindings: RawBinding[];
  consumers: RawConsumer[];
}

async function mgmt<T>(cfg: Config, path: string): Promise<T> {
  const auth = Buffer.from(`${cfg.rabbit.user}:${cfg.rabbit.pass}`).toString('base64');
  const res = await fetch(`${cfg.rabbit.url}${path}`, {
    headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      `API management RabbitMQ ${path} → ${res.status} ${res.statusText}. ` +
        `Vérifie que le plugin rabbitmq_management est actif et que l'utilisateur porte le tag "monitoring".`,
    );
  }
  return (await res.json()) as T;
}

export async function collectRabbitMq(cfg: Config): Promise<RabbitSnapshot> {
  const v = encodeVhost(cfg.rabbit.vhost);

  // /api/consumers n'est pas filtrable par vhost sur toutes les versions : on
  // récupère tout et on filtre côté client pour rester compatible.
  const [exchanges, queues, bindings, consumers] = await Promise.all([
    mgmt<RawExchange[]>(cfg, `/api/exchanges/${v}`),
    mgmt<RawQueue[]>(cfg, `/api/queues/${v}`),
    mgmt<RawBinding[]>(cfg, `/api/bindings/${v}`),
    mgmt<RawConsumer[]>(cfg, `/api/consumers`),
  ]);

  const ignored = new Set(cfg.conventions.ignoreExchanges);

  return {
    exchanges: exchanges.filter((e) => e.name !== '' && !ignored.has(e.name)),
    queues,
    // Les bindings depuis l'exchange par défaut (source vide) et les bindings
    // exchange→exchange ne participent pas au graphe producteur/consommateur.
    bindings: bindings.filter(
      (b) => b.source !== '' && b.destination_type === 'queue' && !ignored.has(b.source),
    ),
    consumers: consumers.filter((c) => c.queue?.vhost === cfg.rabbit.vhost),
  };
}
