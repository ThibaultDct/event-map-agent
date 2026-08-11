import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { EgoGraph } from '../core/ego.js';
import type { EventRow } from '../core/eventcatalog.js';
import type { MatrixData } from '../core/matrix.js';
import type { EventMap } from '../model.js';

const require = createRequire(import.meta.url);

/**
 * Cytoscape est inliné dans la page : le viewer doit rester un fichier unique,
 * ouvrable depuis un partage réseau ou un artefact de CI sans serveur ni CDN.
 */
async function inlineCytoscape(): Promise<string> {
  const path = require.resolve('cytoscape/dist/cytoscape.min.js');
  return readFile(path, 'utf8');
}

export interface ViewerInput {
  map: EventMap;
  matrix: MatrixData;
  ego: Record<string, EgoGraph>;
  events: EventRow[];
}

const CLIENT_JS = String.raw`
const D = window.__EVENTMAP__;
let cy = null;
let currentEgo = null;

/* Le langage visuel est unique et partagé par les trois vues : un événement est
   toujours vert et plein, une commande toujours violette et tiretée. */
const PALETTE = {
  event:   { line: '#2f9e6e', fill: 'rgba(47,158,110,.16)' },
  command: { line: '#7c5cbf', fill: 'rgba(124,92,191,.16)' },
  unknown: { line: '#8a94a6', fill: 'rgba(138,148,166,.14)' }
};
const NODE = {
  api:     { bg: '#e3edfb', line: '#5b8fd0' },
  worker:  { bg: '#e3f3e0', line: '#6faa5e' },
  unknown: { bg: '#eef0f3', line: '#98a1ad' }
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
  });
}
function el(id) { return document.getElementById(id); }
function svcName(id) { const s = D.services[id]; return s ? s.name : id; }
function svcNs(id) { const s = D.services[id]; return s ? s.namespace : ''; }
function pill(kind) {
  const t = kind === 'event' ? 'EVT' : kind === 'command' ? 'CMD' : '?';
  return '<span class="pill p-' + esc(kind) + '">' + t + '</span>';
}
function chip(id) {
  return '<a class="chip" data-id="' + esc(id) + '" title="' + esc(id) + '">' + esc(svcName(id)) + '</a>';
}

/* ------------------------------------------------------------------ onglets */

function showTab(name) {
  ['matrix', 'ego', 'events'].forEach(function (t) {
    el('tab-' + t).classList.toggle('active', t === name);
    el('panel-' + t).classList.toggle('hidden', t !== name);
  });
  el('aside').classList.toggle('hidden', name !== 'matrix');
  if (name === 'ego' && cy) { cy.resize(); fitEgo(); }
}

/* ------------------------------------------------------------------ matrice */

function cellIntensity(count) {
  // Échelle logarithmique : sans elle, un hub à 12 clés écrase visuellement
  // toutes les relations à 1-3 clés, qui sont la majorité.
  return Math.min(1, Math.log(1 + count) / Math.log(1 + Math.max(2, D.matrix.max)));
}

function buildMatrix() {
  const order = D.matrix.order;
  const cellBy = {};
  D.matrix.cells.forEach(function (c) { cellBy[c.from + '|' + c.to] = c; });

  let html = '<table id="mtx"><thead><tr><th class="corner"><span>producteur ↓ &nbsp; consommateur →</span></th>';
  order.forEach(function (id, i) {
    const s = D.services[id];
    html += '<th class="colhead" data-col="' + i + '" data-id="' + esc(id) + '" title="' + esc(id) + '">' +
      '<span class="rot k-' + s.kind + '">' + esc(s.name) + '</span></th>';
  });
  html += '</tr></thead><tbody>';

  order.forEach(function (from, r) {
    const s = D.services[from];
    html += '<tr data-row="' + r + '"><th class="rowhead k-' + s.kind + '" data-id="' + esc(from) + '" title="' + esc(from) + '">' +
      esc(s.name) + '</th>';
    order.forEach(function (to, c) {
      const cell = cellBy[from + '|' + to];
      if (from === to) {
        // Un service peut consommer ses propres événements. Sans traitement
        // explicite, l'information tomberait dans la diagonale et disparaîtrait.
        if (cell) {
          html += '<td class="cell selfloop" data-row="' + r + '" data-col="' + c + '" data-key="' + esc(from + '|' + to) + '"' +
            ' title="' + esc(svcName(from) + ' consomme ' + cell.count + ' de ses propres messages') + '">↻</td>';
        } else {
          html += '<td class="diag" data-row="' + r + '" data-col="' + c + '"></td>';
        }
        return;
      }
      if (!cell) { html += '<td class="empty" data-row="' + r + '" data-col="' + c + '"></td>'; return; }
      const p = PALETTE[cell.kind === 'mixed' ? 'unknown' : cell.kind] || PALETTE.unknown;
      const a = 0.18 + 0.82 * cellIntensity(cell.count);
      html += '<td class="cell" data-row="' + r + '" data-col="' + c + '" data-key="' + esc(from + '|' + to) + '"' +
        ' style="--c:' + p.line + ';--a:' + a.toFixed(2) + (cell.stale ? ';opacity:.4' : '') + '"' +
        ' title="' + esc(svcName(from) + ' → ' + svcName(to) + ' : ' + cell.count + ' clé(s)') + '">' +
        (cell.count > 9 ? '9+' : cell.count) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  el('mtx-wrap').innerHTML = html;

  const table = el('mtx');
  table.addEventListener('mouseover', function (e) {
    const td = e.target.closest('td,th');
    if (td) highlight(td.dataset.row, td.dataset.col);
  });
  table.addEventListener('mouseleave', function () { highlight(null, null); });
  table.addEventListener('click', function (e) {
    const head = e.target.closest('.rowhead,.colhead');
    if (head) { openEgo(head.dataset.id); return; }
    const td = e.target.closest('td.cell');
    if (td) showCell(cellBy[td.dataset.key]);
  });
  clearCell();
}

function highlight(row, col) {
  const t = el('mtx');
  if (!t) return;
  t.querySelectorAll('.hl-row,.hl-col').forEach(function (n) { n.classList.remove('hl-row', 'hl-col'); });
  if (row == null) return;
  t.querySelectorAll('[data-row="' + row + '"]').forEach(function (n) { n.classList.add('hl-row'); });
  t.querySelectorAll('[data-col="' + col + '"]').forEach(function (n) { n.classList.add('hl-col'); });
}

function clearCell() {
  el('detail').innerHTML =
    '<p class="hint">Survole pour croiser une ligne et une colonne. Clique une cellule pour ' +
    'lister les messages, ou un nom de service pour l\'explorer.</p>' +
    '<h4>Légende</h4>' +
    '<div class="legend">' +
      '<div>' + pill('event') + ' clé <code>evt.*</code> — un fait diffusé</div>' +
      '<div>' + pill('command') + ' clé <code>cmd.*</code> — un ordre adressé</div>' +
      '<div><span class="sw" style="--c:' + PALETTE.event.line + '"></span> intensité = nombre de clés distinctes</div>' +
      '<div><span class="mono">↻</span> le service consomme ses propres messages</div>' +
    '</div>';
}

function showCell(cell) {
  if (!cell) return;
  const rows = cell.routingKeys.map(function (k) {
    const kind = k.indexOf('cmd.') === 0 ? 'command' : k.indexOf('evt.') === 0 ? 'event' : cell.kind;
    return '<li>' + pill(kind) + '<code>' + esc(k) + '</code></li>';
  }).join('');
  el('detail').innerHTML =
    '<h3>' + esc(svcName(cell.from)) + ' <span class="arrow">→</span> ' + esc(svcName(cell.to)) + '</h3>' +
    '<dl>' +
      '<dt>Messages</dt><dd>' + cell.count + '</dd>' +
      '<dt>Queues</dt><dd>' + cell.queues.map(function (q) { return '<code>' + esc(q) + '</code>'; }).join(' ') + '</dd>' +
    '</dl>' +
    '<h4>Détail</h4><ul class="msglist">' + rows + '</ul>' +
    '<div class="actions">' + chip(cell.from) + chip(cell.to) + '</div>';
}

/* -------------------------------------------------------------- explorateur */

function buildEgoList() {
  const ids = Object.keys(D.ego).sort(function (a, b) { return svcName(a).localeCompare(svcName(b)); });
  el('ego-list').innerHTML = ids.map(function (id) {
    const g = D.ego[id];
    const s = D.services[id];
    return '<li data-id="' + esc(id) + '">' +
      '<span class="dot k-' + esc(s.kind) + '"></span>' +
      '<span class="nm">' + esc(s.name) + '<em>' + esc(s.namespace) + '</em></span>' +
      '<span class="deg" title="' + g.inbound.length + ' entrant(s) · ' + g.outbound.length + ' sortant(s)">' +
        g.inbound.length + '↓ ' + g.outbound.length + '↑</span></li>';
  }).join('');
  el('ego-list').addEventListener('click', function (e) {
    const li = e.target.closest('li');
    if (li) openEgo(li.dataset.id);
  });
  el('ego-filter').addEventListener('input', function (e) {
    const q = e.target.value.trim().toLowerCase();
    Array.prototype.forEach.call(el('ego-list').children, function (li) {
      const s = D.services[li.dataset.id];
      const hit = !q || (s.name + ' ' + s.namespace).toLowerCase().indexOf(q) >= 0;
      li.style.display = hit ? '' : 'none';
    });
  });
  if (ids.length) openEgo(ids[0], true);
}

function msgRow(m, dir) {
  const arrow = dir === 'in' ? '←' : '→';
  const partners = m.partners.length
    ? m.partners.map(chip).join('')
    : (dir === 'out'
        ? '<span class="danger">personne — le broker jette le message</span>'
        : '<span class="danger">aucun producteur connu</span>');
  const meta = [];
  if (m.queues.length) meta.push('via ' + m.queues.map(function (q) { return '<code>' + esc(q) + '</code>'; }).join(', '));
  if (m.payload) meta.push('<code>' + esc(m.payload.split('.').pop()) + '</code>');
  if (m.source) meta.push('<span class="src">' + esc(m.source) + '</span>');
  if (m.confidence === 'observed') meta.push('<span class="tag">observé au runtime</span>');
  return '<li class="msg' + (m.orphan ? ' is-orphan' : '') + '">' +
    '<div class="msg-h">' + pill(m.kind) + '<code class="key">' + esc(m.routingKey) + '</code></div>' +
    '<div class="msg-p"><span class="ar">' + arrow + '</span>' + partners + '</div>' +
    (meta.length ? '<div class="msg-m">' + meta.join(' · ') + '</div>' : '') +
    '</li>';
}

function openEgo(id, quiet) {
  if (!D.ego[id]) return;
  currentEgo = id;
  if (!quiet) showTab('ego');
  Array.prototype.forEach.call(el('ego-list').children, function (li) {
    li.classList.toggle('sel', li.dataset.id === id);
    if (li.dataset.id === id) li.scrollIntoView({ block: 'nearest' });
  });

  const g = D.ego[id];
  const s = D.services[id];

  el('ego-header').innerHTML =
    '<div class="eh-name"><span class="dot k-' + esc(s.kind) + '"></span>' + esc(s.name) + '</div>' +
    '<div class="eh-meta">' + esc(s.namespace) + ' · ' + esc(s.kind) +
      ' · ' + g.inbound.length + ' message(s) en entrée · ' + g.outbound.length + ' en sortie</div>';

  el('ego-in-list').innerHTML = g.inbound.length
    ? g.inbound.map(function (m) { return msgRow(m, 'in'); }).join('')
    : '<li class="none">Ce service ne consomme aucun message.</li>';
  el('ego-out-list').innerHTML = g.outbound.length
    ? g.outbound.map(function (m) { return msgRow(m, 'out'); }).join('')
    : '<li class="none">Ce service ne publie aucun message.</li>';
  el('ego-in-count').textContent = g.inbound.length;
  el('ego-out-count').textContent = g.outbound.length;

  renderEgoGraph(id, g);
}

function renderEgoGraph(id, g) {
  const elements = g.nodes.map(function (n) {
    return {
      data: { id: n.id, label: n.label, variant: n.variant, meta: n.meta,
              w: n.width, h: n.height, center: n.id === id ? 1 : 0 },
      position: { x: n.x + n.width / 2, y: n.y + n.height / 2 }
    };
  }).concat(g.edges.map(function (e) {
    const total = (e.meta && e.meta.total) || 1;
    return { data: { id: e.id, source: e.source, target: e.target, label: e.label, kind: e.kind,
                     routingKeys: e.routingKeys, queues: e.queues, meta: e.meta,
                     w: Math.min(6, 1.6 + total * 0.5),
                     dashed: e.confidence === 'observed' ? 1 : 0 } };
  }));

  if (cy) cy.destroy();
  cy = cytoscape({
    container: el('ego-graph'),
    elements: elements,
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: {
          'shape': 'round-rectangle', 'width': 'data(w)', 'height': 'data(h)',
          'background-color': function (n) { return (NODE[n.data('variant')] || NODE.unknown).bg; },
          'border-color': function (n) { return (NODE[n.data('variant')] || NODE.unknown).line; },
          'border-width': 1.5, 'label': 'data(label)', 'font-size': 13, 'font-weight': 600,
          'color': '#22272e', 'text-valign': 'center', 'text-halign': 'center',
          'text-wrap': 'wrap', 'text-max-width': 'data(w)',
          // En dessous de cette taille rendue, un libellé n'est plus lisible :
          // Cytoscape le masque plutôt que d'afficher une bouillie de pixels.
          'min-zoomed-font-size': 9 } },
      { selector: 'node[center = 1]', style: {
          'border-width': 3, 'border-color': '#d6336c', 'font-size': 15,
          'shadow-blur': 18, 'shadow-color': 'rgba(214,51,108,.35)', 'shadow-opacity': 1 } },
      { selector: 'edge', style: {
          'curve-style': 'bezier', 'width': 'data(w)',
          'line-color': function (e) { return (PALETTE[e.data('kind')] || PALETTE.unknown).line; },
          'target-arrow-color': function (e) { return (PALETTE[e.data('kind')] || PALETTE.unknown).line; },
          'target-arrow-shape': 'triangle', 'arrow-scale': 1.1,
          // Une commande est un ordre adressé, un événement un fait diffusé :
          // le trait tireté marque cette différence sans dépendre de la couleur.
          'line-style': function (e) { return e.data('kind') === 'command' || e.data('dashed') ? 'dashed' : 'solid'; },
          'label': 'data(label)', 'font-size': 11, 'font-weight': 600,
          'color': function (e) { return (PALETTE[e.data('kind')] || PALETTE.unknown).line; },
          'text-background-color': '#ffffff', 'text-background-opacity': 0.92,
          'text-background-padding': 4, 'text-background-shape': 'roundrectangle',
          'min-zoomed-font-size': 8 } },
      { selector: 'edge[kind = "command"]', style: { 'target-arrow-shape': 'vee' } },
      { selector: ':selected', style: { 'line-color': '#d6336c', 'target-arrow-color': '#d6336c', 'z-index': 99 } }
    ]
  });

  cy.on('tap', 'node', function (evt) {
    const n = evt.target;
    if (n.id() !== currentEgo) openEgo(n.id());
  });
  fitEgo();
}

function fitEgo() {
  if (!cy) return;
  cy.fit(undefined, 44);
  // Un service très sollicité empile vingt partenaires : tout faire tenir réduit
  // les nœuds à des rectangles illisibles. On plafonne la réduction et on laisse
  // l'utilisateur naviguer — mieux vaut un graphe lisible qu'on fait défiler
  // qu'un graphe entier qu'on ne peut pas lire.
  const z = cy.zoom();
  const clamped = Math.min(1.15, Math.max(0.5, z));
  if (clamped !== z) {
    cy.zoom({ level: clamped, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    if (clamped > z) cy.center(cy.getElementById(currentEgo));
  }
  el('ego-hint').style.display = clamped > z ? '' : 'none';
}

/* ------------------------------------------------------------- événements */

function buildEvents() {
  render('');
  el('ev-filter').addEventListener('input', function (e) { render(e.target.value.trim().toLowerCase()); });
  ['ev-orphans', 'ev-evt', 'ev-cmd'].forEach(function (id) {
    el(id).addEventListener('change', function () { render(el('ev-filter').value.trim().toLowerCase()); });
  });

  function render(q) {
    const onlyOrphans = el('ev-orphans').checked;
    const showEvt = el('ev-evt').checked;
    const showCmd = el('ev-cmd').checked;
    const rows = D.events.filter(function (e) {
      if (onlyOrphans && !e.orphan) return false;
      if (e.kind === 'event' && !showEvt) return false;
      if (e.kind === 'command' && !showCmd) return false;
      if (!q) return true;
      const hay = (e.routingKey + ' ' + e.payloads.join(' ') + ' ' +
        e.producers.map(function (p) { return svcName(p.service); }).join(' ') + ' ' +
        e.consumers.map(function (c) { return svcName(c.service) + ' ' + c.queue; }).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    el('ev-count').textContent = rows.length + ' / ' + D.events.length;
    el('ev-body').innerHTML = rows.map(function (e) {
      const prod = e.producers.map(function (p) { return chip(p.service); }).join('');
      const cons = e.consumers.length
        ? e.consumers.map(function (c) { return chip(c.service); }).join('')
        : '<span class="danger">personne — message jeté</span>';
      const n = e.schema ? e.schema.length : 0;
      const payloadCell = e.payloads.length
        ? e.payloads.map(function (p) { return '<code>' + esc(p.split('.').pop()) + '</code>'; }).join(' ') +
          (n ? ' <button class="expand" data-key="' + esc(e.exchange + '|' + e.routingKey) + '">' + n + ' champs ▾</button>' : '')
        : '';
      return '<tr' + (e.orphan ? ' class="is-orphan"' : '') + '>' +
        '<td>' + pill(e.kind) + '</td>' +
        '<td><code class="key">' + esc(e.routingKey) + '</code>' +
          (e.observedOnly ? ' <span class="tag">observé</span>' : '') + '</td>' +
        '<td>' + prod + '</td>' +
        '<td>' + cons + '</td>' +
        '<td>' + payloadCell + '</td>' +
        '</tr>' +
        (n ? '<tr class="schema hidden" data-for="' + esc(e.exchange + '|' + e.routingKey) + '">' +
             '<td></td><td colspan="4">' + schemaTable(e.schema) + '</td></tr>' : '');
    }).join('');
  }
}

/* Le schéma du payload : ce qui rend la question « si je change ça, qui casse ? »
   répondable. L'indentation suit la profondeur du chemin aplati. */
function schemaTable(schema) {
  return '<table class="sch">' + schema.map(function (f) {
    const depth = (f.path.match(/\./g) || []).length;
    const leaf = f.path.split('.').pop();
    return '<tr><td class="p" style="padding-left:' + (depth * 14) + 'px">' +
      (depth ? '<span class="tree">└ </span>' : '') + esc(leaf) + '</td>' +
      '<td class="t">' + esc(f.type.startsWith('enum[') || f.type.startsWith('Map<')
        ? f.type : f.type.split('.').pop()) + '</td></tr>';
  }).join('') + '</table>';
}

/* --------------------------------------------------------------- anomalies */

function buildWarnings() {
  const groups = {};
  D.warnings.forEach(function (w) { (groups[w.code] = groups[w.code] || []).push(w); });
  const codes = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; });
  const box = el('warnings');
  if (!codes.length) { box.innerHTML = '<p class="hint">Aucune anomalie détectée.</p>'; return; }
  box.innerHTML = codes.map(function (code) {
    const items = groups[code].map(function (w) { return '<li>' + esc(w.message) + '</li>'; }).join('');
    return '<details><summary><b>' + esc(code) + '</b><span class="badge">' + groups[code].length + '</span></summary><ul>' + items + '</ul></details>';
  }).join('');
}

/* -------------------------------------------------------------------- init */

// Tous les noms de service affichés, où qu'ils soient, ouvrent l'explorateur.
// C'est ce qui permet de remonter une chaîne de proche en proche.
document.addEventListener('click', function (e) {
  const c = e.target.closest('a.chip');
  if (c && c.dataset.id && D.ego[c.dataset.id]) { e.preventDefault(); openEgo(c.dataset.id); }
});

el('ev-body').addEventListener('click', function (e) {
  const b = e.target.closest('button.expand');
  if (!b) return;
  const row = document.querySelector('tr.schema[data-for="' + CSS.escape(b.dataset.key) + '"]');
  if (!row) return;
  const open = row.classList.toggle('hidden');
  b.textContent = b.textContent.replace(open ? '▴' : '▾', open ? '▾' : '▴');
});

el('tab-matrix').addEventListener('click', function () { showTab('matrix'); });
el('tab-ego').addEventListener('click', function () { showTab('ego'); });
el('tab-events').addEventListener('click', function () { showTab('events'); });

let rt = null;
window.addEventListener('resize', function () {
  clearTimeout(rt);
  rt = setTimeout(function () { if (cy && !el('panel-ego').classList.contains('hidden')) { cy.resize(); fitEgo(); } }, 150);
});

buildMatrix();
buildEgoList();
buildEvents();
buildWarnings();
showTab('matrix');
`;

function escapeForScript(json: string): string {
  // Empêche une séquence </script> présente dans une donnée de casser la page.
  return json.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

export async function renderViewer(input: ViewerInput): Promise<string> {
  const { map, matrix, ego, events } = input;
  const cytoscapeSrc = await inlineCytoscape();

  // On n'embarque que ce que les trois vues consomment. Les flux bruts sont déjà
  // représentés par la matrice et le catalogue : les réexpédier doublerait le
  // poids de la page pour rien.
  const payload = escapeForScript(
    JSON.stringify({
      generatedAt: map.generatedAt,
      cluster: map.cluster,
      services: matrix.services,
      warnings: map.warnings,
      matrix,
      ego,
      events,
    }),
  );
  const when = map.generatedAt.slice(0, 19).replace('T', ' ');
  const nEvt = events.filter((e) => e.kind === 'event').length;
  const nCmd = events.filter((e) => e.kind === 'command').length;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Carte des événements${map.cluster ? ' — ' + map.cluster : ''}</title>
<style>
  :root {
    --bg:#fbfcfd; --surface:#fff; --panel:#f4f6f8; --border:#e3e7ec; --border-soft:#eef1f4;
    --text:#22272e; --muted:#6b7684; --accent:#d6336c;
    --evt:#2f9e6e; --cmd:#7c5cbf; --danger:#c0392b;
    --hl:rgba(214,51,108,.08); --shadow:0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#12151a; --surface:#181c22; --panel:#1b1f26; --border:#2a3038; --border-soft:#222831;
      --text:#e4e8ee; --muted:#98a2b0; --evt:#4ecb8f; --cmd:#a98ae0; --danger:#f07167;
      --hl:rgba(214,51,108,.16); --shadow:0 1px 3px rgba(0,0,0,.4);
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
         background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column;
         -webkit-font-smoothing:antialiased; }

  /* ---------- en-tête ---------- */
  header { padding:11px 18px; background:var(--surface); border-bottom:1px solid var(--border);
           display:flex; align-items:center; gap:16px; flex-wrap:wrap; flex:none; box-shadow:var(--shadow); z-index:5; }
  h1 { font-size:15px; margin:0; font-weight:700; letter-spacing:-.01em; }
  .stats { color:var(--muted); font-size:12px; }
  .stats b { color:var(--text); font-weight:600; }
  .tabs { display:flex; gap:2px; margin-left:auto; background:var(--panel); padding:3px; border-radius:9px; }
  .tabs button { font:inherit; font-size:13px; font-weight:600; padding:6px 15px; border:0;
                 background:transparent; color:var(--muted); border-radius:7px; cursor:pointer; transition:.12s; }
  .tabs button:hover { color:var(--text); }
  .tabs button.active { background:var(--surface); color:var(--accent); box-shadow:var(--shadow); }

  main { flex:1; display:flex; min-height:0; }
  .panel { flex:1; min-width:0; display:flex; flex-direction:column; }
  .panel.hidden, aside.hidden { display:none; }
  aside { width:clamp(280px,29%,400px); border-left:1px solid var(--border); background:var(--surface);
          overflow-y:auto; padding:16px; flex:none; }

  /* ---------- matrice ---------- */
  #mtx-wrap { overflow:auto; padding:16px 16px 48px; flex:1; }
  #mtx { border-collapse:separate; border-spacing:0; font-size:11px; }
  #mtx th, #mtx td { padding:0; }
  #mtx .corner { position:sticky; left:0; top:0; z-index:4; background:var(--bg);
                 vertical-align:bottom; text-align:right; padding-right:10px; }
  #mtx .corner span { font-size:10px; color:var(--muted); font-weight:500; white-space:nowrap; }
  #mtx .colhead { position:sticky; top:0; z-index:3; background:var(--bg); height:120px;
                  vertical-align:bottom; cursor:pointer; }
  #mtx .colhead .rot { writing-mode:vertical-rl; transform:rotate(180deg); display:inline-block;
                       white-space:nowrap; padding-bottom:6px; font-weight:600; }
  #mtx .rowhead { position:sticky; left:0; z-index:2; background:var(--bg); text-align:right;
                  padding:0 10px 0 4px; white-space:nowrap; font-weight:600; cursor:pointer; height:22px; }
  #mtx .rowhead:hover, #mtx .colhead:hover { color:var(--accent); }
  #mtx .k-api { color:#4a7ab8; } #mtx .k-worker { color:#5d9150; }
  @media (prefers-color-scheme: dark) { #mtx .k-api { color:#7cabe0; } #mtx .k-worker { color:#8dc47c; } }
  #mtx td { width:22px; height:22px; min-width:22px; text-align:center; font-size:9.5px;
            border-right:1px solid var(--border-soft); border-bottom:1px solid var(--border-soft); }
  #mtx td.cell { cursor:pointer; font-weight:700; color:#fff;
                 background:color-mix(in srgb, var(--c) calc(var(--a) * 100%), transparent); }
  #mtx td.cell:hover { outline:2px solid var(--accent); outline-offset:-2px; }
  #mtx td.selfloop { background:var(--hl); color:var(--accent); font-size:12px; }
  #mtx td.diag { background:repeating-linear-gradient(45deg,transparent,transparent 3px,var(--border) 3px,var(--border) 4px); }
  #mtx .hl-row, #mtx .hl-col { background-image:linear-gradient(var(--hl),var(--hl)); }

  /* ---------- explorateur ---------- */
  #panel-ego { flex-direction:row; overflow:hidden; }
  #ego-side { width:236px; flex:none; display:flex; flex-direction:column;
              border-right:1px solid var(--border); background:var(--surface); }
  #ego-filter { margin:10px; }
  #ego-list { margin:0; padding:0 0 10px; list-style:none; overflow-y:auto; flex:1; }
  #ego-list li { padding:7px 12px; cursor:pointer; display:flex; align-items:center; gap:8px;
                 font-size:12.5px; border-left:3px solid transparent; transition:.1s; }
  #ego-list li:hover { background:var(--panel); }
  #ego-list li.sel { background:var(--hl); border-left-color:var(--accent); }
  #ego-list .nm { flex:1; min-width:0; font-weight:600; display:flex; flex-direction:column; line-height:1.25; }
  #ego-list .nm em { font-style:normal; font-weight:400; font-size:10.5px; color:var(--muted); }
  #ego-list .deg { color:var(--muted); font-size:10.5px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .dot.k-api { background:#5b8fd0; } .dot.k-worker { background:#6faa5e; } .dot.k-unknown { background:#98a1ad; }

  #ego-main { flex:1; min-width:0; display:flex; flex-direction:column; }
  #ego-header { padding:14px 18px 12px; border-bottom:1px solid var(--border); background:var(--surface); }
  .eh-name { font-size:17px; font-weight:700; display:flex; align-items:center; gap:9px; letter-spacing:-.01em; }
  .eh-meta { color:var(--muted); font-size:12px; margin-top:2px; }
  #ego-canvas { flex:1; min-height:240px; position:relative; }
  #ego-graph { position:absolute; inset:0; background:var(--bg);
               background-image:radial-gradient(var(--border) 1px, transparent 1px); background-size:22px 22px; }
  #ego-hint { position:absolute; right:10px; bottom:9px; font-size:10.5px; color:var(--muted);
              background:var(--surface); border:1px solid var(--border); border-radius:6px;
              padding:3px 8px; pointer-events:none; opacity:.9; }
  #ego-io { height:40%; min-height:170px; max-height:52%; display:flex;
            border-top:1px solid var(--border); background:var(--surface); }
  #ego-io section { flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
  #ego-io section + section { border-left:1px solid var(--border); }
  .io-h { padding:9px 14px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em;
          color:var(--muted); border-bottom:1px solid var(--border-soft); display:flex; align-items:center; gap:7px; }
  .io-h .badge { background:var(--panel); color:var(--muted); }
  .io-list { margin:0; padding:6px; list-style:none; overflow-y:auto; flex:1; }
  li.msg { padding:8px 10px; border-radius:8px; margin-bottom:4px; background:var(--panel); }
  li.msg:hover { background:var(--hl); }
  li.msg.is-orphan { background:color-mix(in srgb, var(--danger) 12%, transparent); }
  .msg-h { display:flex; align-items:center; gap:7px; }
  .msg-h .key { font-size:12px; font-weight:600; background:none; padding:0; }
  .msg-p { margin-top:4px; display:flex; align-items:center; gap:5px; flex-wrap:wrap; font-size:12px; }
  .msg-p .ar { color:var(--muted); font-weight:700; }
  .msg-m { margin-top:3px; font-size:11px; color:var(--muted); }
  .msg-m .src { font-family:ui-monospace,Consolas,monospace; font-size:10.5px; }
  li.none { padding:14px; color:var(--muted); font-size:12.5px; font-style:italic; }

  /* ---------- événements ---------- */
  #panel-events { overflow:hidden; }
  .ev-bar { padding:11px 16px; background:var(--surface); border-bottom:1px solid var(--border);
            display:flex; gap:14px; align-items:center; flex-wrap:wrap; flex:none; }
  .ev-scroll { overflow:auto; flex:1; }
  table.ev { width:100%; border-collapse:collapse; font-size:12.5px; }
  table.ev th { text-align:left; padding:8px 12px; color:var(--muted); font-size:10.5px;
                text-transform:uppercase; letter-spacing:.05em; position:sticky; top:0;
                background:var(--bg); border-bottom:1px solid var(--border); z-index:1; }
  table.ev td { padding:7px 12px; border-bottom:1px solid var(--border-soft); vertical-align:top; }
  table.ev tr:hover td { background:var(--panel); }
  table.ev tr.is-orphan td { background:color-mix(in srgb, var(--danger) 9%, transparent); }
  table.ev .key { background:none; padding:0; font-size:12px; font-weight:600; }
  table.ev tr.hidden { display:none; }
  button.expand { font:inherit; font-size:10.5px; padding:1px 7px; border:1px solid var(--border);
                  background:var(--surface); color:var(--muted); border-radius:5px; cursor:pointer; }
  button.expand:hover { border-color:var(--accent); color:var(--accent); }
  tr.schema > td { background:var(--panel); }
  table.sch { border-collapse:collapse; font-size:11.5px; margin:2px 0 4px; }
  table.sch td { padding:1.5px 14px 1.5px 0; border:0; vertical-align:top; }
  table.sch .p { font-family:ui-monospace,Consolas,monospace; white-space:nowrap; }
  table.sch .t { color:var(--muted); font-family:ui-monospace,Consolas,monospace; }
  table.sch .tree { color:var(--border); }

  /* ---------- éléments communs ---------- */
  .pill { font:700 9.5px/1 ui-monospace,Consolas,monospace; padding:3px 5px; border-radius:4px;
          letter-spacing:.05em; flex:none; }
  .p-event { background:color-mix(in srgb,var(--evt) 20%,transparent); color:var(--evt); }
  .p-command { background:color-mix(in srgb,var(--cmd) 20%,transparent); color:var(--cmd); }
  .p-unknown { background:var(--panel); color:var(--muted); }
  a.chip { display:inline-flex; align-items:center; padding:1.5px 8px; margin:1px 3px 1px 0; border-radius:11px;
           background:var(--surface); border:1px solid var(--border); font-size:11.5px; font-weight:600;
           color:var(--text); cursor:pointer; text-decoration:none; transition:.1s; }
  a.chip:hover { border-color:var(--accent); color:var(--accent); }
  input[type=search] { font:inherit; font-size:12.5px; padding:6px 11px; border:1px solid var(--border);
                       border-radius:7px; background:var(--bg); color:var(--text); min-width:230px; }
  input[type=search]:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent; }
  label { font-size:12px; color:var(--muted); display:inline-flex; align-items:center; gap:5px; cursor:pointer; }
  h3 { margin:0 0 10px; font-size:14.5px; font-weight:700; }
  h3 .arrow { color:var(--muted); margin:0 2px; }
  h4 { margin:16px 0 7px; font-size:10.5px; text-transform:uppercase; color:var(--muted); letter-spacing:.06em; font-weight:700; }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12.5px; }
  dt { color:var(--muted); } dd { margin:0; word-break:break-word; }
  code { font:11.5px/1.45 ui-monospace,"Cascadia Code",Consolas,monospace;
         background:var(--panel); padding:1px 5px; border-radius:4px; }
  ul.msglist { margin:0; padding:0; list-style:none; }
  ul.msglist li { display:flex; align-items:center; gap:7px; padding:3px 0; }
  .legend { display:flex; flex-direction:column; gap:7px; font-size:12px; color:var(--muted); }
  .legend > div { display:flex; align-items:center; gap:8px; }
  .legend .sw { width:32px; height:11px; border-radius:3px; flex:none;
                background:linear-gradient(90deg,color-mix(in srgb,var(--c) 18%,transparent),var(--c)); }
  .legend .mono { font-family:ui-monospace,Consolas,monospace; color:var(--accent); font-weight:700; }
  .hint { color:var(--muted); font-size:12.5px; margin:0 0 4px; }
  .danger { color:var(--danger); font-weight:600; font-size:11.5px; }
  .tag { background:var(--panel); border-radius:4px; padding:1px 5px; font-size:10px; color:var(--muted); }
  .badge { background:var(--accent); color:#fff; border-radius:10px; padding:1px 7px; font-size:10.5px; font-weight:700; }
  .actions { margin-top:14px; padding-top:12px; border-top:1px solid var(--border-soft); }
  details { border-top:1px solid var(--border-soft); padding:8px 0; }
  details summary { cursor:pointer; font-size:12.5px; display:flex; align-items:center; gap:8px; }
  details ul { margin:7px 0 0; padding-left:18px; font-size:11.5px; color:var(--muted); }
  details li { margin:3px 0; }
  hr { border:0; border-top:1px solid var(--border); margin:18px 0; }
  ::-webkit-scrollbar { width:11px; height:11px; }
  ::-webkit-scrollbar-thumb { background:var(--border); border-radius:6px; border:3px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Carte des événements</h1>
  <span class="stats"><b>${map.services.length}</b> services · <b>${nEvt}</b> évts · <b>${nCmd}</b> cmds · <b>${map.flows.length}</b> flux · ${when} UTC${map.cluster ? ' · ' + map.cluster : ''}</span>
  <div class="tabs">
    <button id="tab-matrix">Matrice</button>
    <button id="tab-ego">Explorateur</button>
    <button id="tab-events">Messages</button>
  </div>
</header>
<main>
  <div class="panel" id="panel-matrix"><div id="mtx-wrap"></div></div>

  <div class="panel hidden" id="panel-ego">
    <div id="ego-side">
      <input type="search" id="ego-filter" placeholder="Filtrer les services…">
      <ul id="ego-list"></ul>
    </div>
    <div id="ego-main">
      <div id="ego-header"></div>
      <div id="ego-canvas">
        <div id="ego-graph"></div>
        <div id="ego-hint">glisser pour naviguer · molette pour zoomer</div>
      </div>
      <div id="ego-io">
        <section>
          <div class="io-h">↓ Entrée <span class="badge" id="ego-in-count">0</span> <span style="font-weight:400;text-transform:none;letter-spacing:0">ce que le service consomme, et de qui</span></div>
          <ul class="io-list" id="ego-in-list"></ul>
        </section>
        <section>
          <div class="io-h">↑ Sortie <span class="badge" id="ego-out-count">0</span> <span style="font-weight:400;text-transform:none;letter-spacing:0">ce qu'il publie, et vers qui</span></div>
          <ul class="io-list" id="ego-out-list"></ul>
        </section>
      </div>
    </div>
  </div>

  <div class="panel hidden" id="panel-events">
    <div class="ev-bar">
      <input type="search" id="ev-filter" placeholder="Filtrer par clé, service, payload…">
      <label><input type="checkbox" id="ev-evt" checked> événements</label>
      <label><input type="checkbox" id="ev-cmd" checked> commandes</label>
      <label><input type="checkbox" id="ev-orphans"> orphelins seulement</label>
      <span class="stats" id="ev-count"></span>
    </div>
    <div class="ev-scroll">
      <table class="ev">
        <thead><tr><th></th><th>Routing key</th><th>Producteurs</th><th>Consommateurs</th><th>Payload</th></tr></thead>
        <tbody id="ev-body"></tbody>
      </table>
    </div>
  </div>

  <aside id="aside">
    <div id="detail"></div>
    <hr>
    <h4>Anomalies</h4>
    <div id="warnings"></div>
  </aside>
</main>
<script>${cytoscapeSrc}</script>
<script>window.__EVENTMAP__ = ${payload};</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}
