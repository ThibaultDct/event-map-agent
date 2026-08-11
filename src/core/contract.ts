import type { EventMap, Publication, SchemaField } from '../model.js';

/**
 * Détection des ruptures de contrat entre deux scans.
 *
 * C'est ce qui fait passer l'outil de carte à garde-fou. La carte répond « qui
 * consomme `evt.order.created` » ; la comparaison de schémas répond « je viens
 * de retirer un champ, qui casse » — et comme la topologie est déjà résolue, on
 * peut nommer les consommateurs impactés.
 */

export type ChangeKind = 'removed' | 'type-changed' | 'added';

export interface SchemaChange {
  exchange: string;
  routingKey: string;
  producer: string;
  kind: ChangeKind;
  path: string;
  before?: string;
  after?: string;
  /** Services qui consomment ce message aujourd'hui. */
  impacted: string[];
  /** Emplacement Java de la publication. */
  source?: string;
}

export interface ContractDiff {
  /** Champ retiré ou dont le type change : les consommateurs cassent. */
  breaking: SchemaChange[];
  /** Champ ajouté : additif, sans danger pour un consommateur tolérant. */
  additive: SchemaChange[];
  /** Messages dont le schéma apparaît pour la première fois. */
  newlyDescribed: number;
}

const key = (p: { exchange: string; routingKey: string }) => `${p.exchange}|${p.routingKey}`;

function indexSchemas(map: EventMap): Map<string, Publication> {
  const out = new Map<string, Publication>();
  for (const p of map.publishes) {
    if (!p.schema || p.schema.length === 0) continue;
    // Si deux services publient la même clé, on garde le premier par ordre
    // stable : comparer un schéma à celui d'un autre producteur produirait des
    // ruptures fantômes à chaque run.
    const k = key(p);
    const existing = out.get(k);
    if (!existing || p.service.localeCompare(existing.service) < 0) out.set(k, p);
  }
  return out;
}

function asMap(schema: SchemaField[]): Map<string, string> {
  return new Map(schema.map((f) => [f.path, f.type]));
}

export function diffContracts(previous: EventMap | undefined, next: EventMap): ContractDiff {
  const diff: ContractDiff = { breaking: [], additive: [], newlyDescribed: 0 };
  if (!previous) {
    diff.newlyDescribed = indexSchemas(next).size;
    return diff;
  }

  const before = indexSchemas(previous);
  const after = indexSchemas(next);

  // Consommateurs actuels de chaque clé : c'est la liste des impactés.
  const consumers = new Map<string, Set<string>>();
  for (const f of next.flows) {
    const k = `${f.exchange}|${f.routingKey}`;
    if (!consumers.has(k)) consumers.set(k, new Set());
    consumers.get(k)!.add(f.to);
  }

  for (const [k, pub] of after) {
    const old = before.get(k);
    if (!old) {
      diff.newlyDescribed++;
      continue;
    }
    const oldFields = asMap(old.schema!);
    const newFields = asMap(pub.schema!);
    const impacted = [...(consumers.get(k) ?? [])].sort();

    const base = {
      exchange: pub.exchange,
      routingKey: pub.routingKey,
      producer: pub.service,
      impacted,
      source: pub.source,
    };

    for (const [path, type] of oldFields) {
      const now = newFields.get(path);
      if (now === undefined) {
        diff.breaking.push({ ...base, kind: 'removed', path, before: type });
      } else if (now !== type) {
        diff.breaking.push({ ...base, kind: 'type-changed', path, before: type, after: now });
      }
    }
    for (const [path, type] of newFields) {
      if (!oldFields.has(path)) {
        diff.additive.push({ ...base, kind: 'added', path, after: type });
      }
    }
  }

  const order = (c: SchemaChange) => `${c.routingKey}|${c.path}`;
  diff.breaking.sort((a, b) => b.impacted.length - a.impacted.length || order(a).localeCompare(order(b)));
  diff.additive.sort((a, b) => order(a).localeCompare(order(b)));
  return diff;
}

/** Raccourcit un FQN pour l'affichage : `com.acme.OrderLine` → `OrderLine`. */
function short(type: string | undefined): string {
  if (!type) return '?';
  if (type.startsWith('enum[') || type.startsWith('Map<')) return type;
  const last = type.split('.').pop();
  return last ?? type;
}

export function renderContractMarkdown(diff: ContractDiff, maxItems: number): string[] {
  const L: string[] = [];

  if (diff.breaking.length > 0) {
    L.push(`### 🔴 Ruptures de contrat (${diff.breaking.length})`, '');
    L.push(
      '_Champ retiré ou retypé sur un message déjà consommé. Les consommateurs listés ' +
        'lisent ce champ aujourd\'hui._',
      '',
    );
    for (const c of diff.breaking.slice(0, maxItems)) {
      const what =
        c.kind === 'removed'
          ? `champ \`${c.path}\` **supprimé** (était \`${short(c.before)}\`)`
          : `\`${c.path}\` : \`${short(c.before)}\` → \`${short(c.after)}\``;
      L.push(`- **\`${c.routingKey}\`** — ${what}`);
      L.push(
        `  - ${c.impacted.length === 0 ? '_aucun consommateur connu_' : `impacte **${c.impacted.length}** consommateur(s) : ${c.impacted.join(', ')}`}`,
      );
      L.push(`  - publié par ${c.producer}${c.source ? ` — \`${c.source}\`` : ''}`);
    }
    if (diff.breaking.length > maxItems) {
      L.push(`- _… et ${diff.breaking.length - maxItems} autres — détail dans \`event-map.json\`_`);
    }
    L.push('');
  }

  if (diff.additive.length > 0) {
    L.push(`<details><summary>Ajouts de champs (${diff.additive.length}) — sans rupture</summary>`, '');
    for (const c of diff.additive.slice(0, maxItems)) {
      L.push(`- \`${c.routingKey}\` — \`${c.path}\` (\`${short(c.after)}\`)`);
    }
    if (diff.additive.length > maxItems) {
      L.push(`- _… et ${diff.additive.length - maxItems} autres_`);
    }
    L.push('', '</details>', '');
  }

  return L;
}
