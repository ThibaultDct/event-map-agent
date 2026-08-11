import type { EgoGraph } from '../core/ego.js';
import type { GraphEdge, GraphNode, GraphView, LaidOutGraph } from '../core/layout.js';
import type { EventMap } from '../model.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Les identifiants métier contiennent `/`, `|`, `→`… que draw.io tolère mal
 * comme ids de cellule. On mappe vers des ids opaques stables.
 */
function idMapper() {
  const seen = new Map<string, string>();
  return (raw: string) => {
    let id = seen.get(raw);
    if (!id) {
      id = `c${seen.size + 2}`; // 0 et 1 sont réservés par mxGraphModel
      seen.set(raw, id);
    }
    return id;
  };
}

const NODE_STYLE: Record<string, string> = {
  api: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;verticalAlign=middle;',
  worker:
    'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=12;verticalAlign=middle;',
  unknown:
    'rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontSize=12;verticalAlign=middle;',
  main: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;',
  dlq: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=11;',
  retry:
    'shape=cylinder3;boundedLbl=1;backgroundOutline=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=11;',
};

function nodeStyle(n: GraphNode): string {
  const base = NODE_STYLE[n.variant] ?? NODE_STYLE.unknown!;
  const isolated = n.meta.isolated === true ? 'dashed=1;opacity=60;' : '';
  const stale = n.meta.stale === true ? 'opacity=50;' : '';
  return base + isolated + stale;
}

function edgeStyle(e: GraphEdge): string {
  let s = 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=10;jumpStyle=arc;';
  s += e.kind === 'command' ? 'strokeColor=#9673a6;endArrow=blockThin;' : 'strokeColor=#4d4d4d;';
  // Une clé de routage non résolue statiquement ne mérite pas un trait plein.
  if (e.confidence === 'dynamic' || e.confidence === 'observed') s += 'dashed=1;';
  if (e.meta.stale === true) s += 'opacity=50;';
  return s;
}

function renderView(view: GraphView, name: string, pageId: string, caption?: string): string {
  const mapId = idMapper();
  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];

  if (caption) {
    cells.push(
      `<mxCell id="caption" value="${esc(caption)}" ` +
        `style="text;html=1;align=left;verticalAlign=middle;fontSize=15;fontStyle=1" vertex="1" parent="1">` +
        `<mxGeometry x="20" y="-50" width="900" height="30" as="geometry" /></mxCell>`,
    );
  }

  for (const n of view.nodes) {
    const label = n.sublabel
      ? `<b>${esc(n.label)}</b><br><font style="font-size:9px;color:#666">${esc(n.sublabel)}</font>`
      : `<b>${esc(n.label)}</b>`;
    cells.push(
      `<mxCell id="${mapId(n.id)}" value="${esc(label)}" style="${nodeStyle(n)}" vertex="1" parent="1">` +
        `<mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${n.width}" height="${n.height}" as="geometry" />` +
        `</mxCell>`,
    );
  }

  for (const e of view.edges) {
    const label = esc(e.label.replace(/\n/g, '<br>'));
    cells.push(
      `<mxCell id="${mapId('edge:' + e.id)}" value="${label}" style="${edgeStyle(e)}" ` +
        `edge="1" parent="1" source="${mapId(e.source)}" target="${mapId(e.target)}">` +
        `<mxGeometry relative="1" as="geometry" />` +
        `</mxCell>`,
    );
  }

  return (
    `<diagram id="${pageId}" name="${esc(name)}">` +
    `<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" ` +
    `connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
    `pageWidth="${Math.max(1169, view.width)}" pageHeight="${Math.max(826, view.height)}" math="0" shadow="0">` +
    `<root>${cells.join('')}</root>` +
    `</mxGraphModel>` +
    `</diagram>`
  );
}

/** Une page de légende : sans elle, le code couleur se perd d'un run à l'autre. */
function legendPage(map: EventMap): string {
  const items: Array<[string, string]> = [
    ['API (expose des ports)', NODE_STYLE.api!],
    ['Worker', NODE_STYLE.worker!],
    ['Queue', NODE_STYLE.main!],
    ['Dead letter queue', NODE_STYLE.dlq!],
    ['Queue de retry', NODE_STYLE.retry!],
  ];
  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  items.forEach(([label, style], i) => {
    cells.push(
      `<mxCell id="lg${i}" value="${esc(label)}" style="${style}" vertex="1" parent="1">` +
        `<mxGeometry x="40" y="${40 + i * 80}" width="200" height="50" as="geometry" /></mxCell>`,
    );
  });
  cells.push(
    `<mxCell id="lgtxt" value="${esc(
      `<b>Carte générée le ${map.generatedAt.slice(0, 19).replace('T', ' ')} UTC</b><br>` +
        `Trait plein : routing key déclarée · Trait pointillé : clé dynamique ou simplement observée<br>` +
        `Violet : commande · Gris : événement<br>` +
        `Nœud estompé : non revu au dernier scan (en sursis)`,
    )}" style="text;html=1;align=left;verticalAlign=top;fontSize=12;" vertex="1" parent="1">` +
      `<mxGeometry x="300" y="40" width="520" height="140" as="geometry" /></mxCell>`,
  );
  return (
    `<diagram id="legend" name="Légende">` +
    `<mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="1169" pageHeight="826">` +
    `<root>${cells.join('')}</root></mxGraphModel></diagram>`
  );
}

/** Nom de page sûr pour draw.io : les `/` y créent une hiérarchie parasite. */
function pageName(id: string, map: EventMap): string {
  return map.services.find((s) => s.id === id)?.name ?? id.replace(/\//g, '·');
}

/**
 * Produit un `.drawio` multi-pages, XML non compressé — draw.io l'ouvre tel quel
 * et le re-sauvegarde compressé si l'utilisateur le souhaite.
 *
 * La structure — une vue d'ensemble, puis **une page par service** — vient d'un
 * constat mesuré : la page globale fait plus de 5 000 px de large, avec un degré
 * moyen de 9 et 46 % des arêtes passant par deux consommateurs transverses. Elle
 * garde sa valeur d'inventaire, mais personne ne l'ouvre deux fois. Les pages ego,
 * elles, tiennent dans un écran et se collent dans une doc d'équipe.
 */
export function renderDrawio(
  graph: LaidOutGraph,
  ego: Record<string, EgoGraph>,
  map: EventMap,
): string {
  const egoIds = Object.keys(ego).sort((a, b) => pageName(a, map).localeCompare(pageName(b, map)));

  const egoPages = egoIds
    .map((id) => {
      const g = ego[id]!;
      return renderView(
        g,
        pageName(id, map),
        `ego-${id.replace(/[^a-zA-Z0-9]/g, '-')}`,
        `${pageName(id, map)} — ${g.upstream} producteur(s) en amont, ${g.downstream} consommateur(s) en aval`,
      );
    })
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="event-system-visualizer" modified="${map.generatedAt}" agent="event-map-discovery" type="device">` +
    renderView(graph.service, "Vue d'ensemble", 'overview') +
    renderView(graph.detailed, 'Topologie (queues)', 'detailed') +
    egoPages +
    legendPage(map) +
    `</mxfile>\n`
  );
}
