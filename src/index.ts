#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { collectKubernetes } from './collectors/kubernetes.js';
import { collectRabbitMq } from './collectors/rabbitmq.js';
import { collectManifests } from './collectors/manifest.js';
import { correlate } from './core/correlate.js';
import { mergeWithPrevious, stabilize } from './core/merge.js';
import { diffMaps, renderDiffMarkdown } from './core/diff.js';
import { diffContracts } from './core/contract.js';
import { layoutGraph } from './core/layout.js';
import { buildEgoGraphs } from './core/ego.js';
import { buildMatrix } from './core/matrix.js';
import { buildEventCatalog } from './core/eventcatalog.js';
import { renderDrawio } from './renderers/drawio.js';
import { renderViewer } from './renderers/viewer.js';
import { commitAndPush, prepareRepo, readPreviousMap } from './outputs/git.js';

function step(n: number, msg: string): void {
  console.log(`[${n}/8] ${msg}`);
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const started = Date.now();

  // On récupère la carte précédente AVANT toute collecte : elle sert à la fois
  // au merge (TTL des arêtes disparues) et au diff.
  step(1, 'Préparation du dépôt et lecture de la carte précédente');
  if (cfg.git.enabled) await prepareRepo(cfg);
  const previous = await readPreviousMap(cfg);
  console.log(
    previous
      ? `      carte précédente du ${previous.generatedAt} (${previous.flows.length} flux)`
      : '      aucune carte précédente — premier run',
  );

  step(2, 'Inventaire Kubernetes (pods, deployments)');
  const k8s = await collectKubernetes(cfg);
  console.log(`      ${k8s.services.length} workloads, ${k8s.byIp.size} pods indexés par IP`);

  step(3, 'Topologie RabbitMQ (exchanges, queues, bindings, consumers)');
  const rabbit = await collectRabbitMq(cfg);
  console.log(
    `      ${rabbit.exchanges.length} exchanges, ${rabbit.queues.length} queues, ` +
      `${rabbit.bindings.length} bindings, ${rabbit.consumers.length} consumers`,
  );

  step(4, 'Collecte des manifestes de service');
  const { manifests, warnings } = await collectManifests(k8s.representatives, cfg);
  console.log(`      ${manifests.size}/${k8s.representatives.size} manifestes récupérés`);

  step(5, 'Corrélation et résolution des flux');
  let map = correlate({ k8s, rabbit, manifests, warnings, cfg });
  map = stabilize(mergeWithPrevious(map, previous, cfg));
  console.log(`      ${map.flows.length} flux, ${map.warnings.length} anomalies`);

  step(6, 'Calcul des vues et du layout');
  const matrix = buildMatrix(map);
  const events = buildEventCatalog(map);
  const graph = await layoutGraph(map, {
    maxExactNodes: cfg.layout.maxExactNodes,
    onProgress: (m) => console.log(`      ${m}`),
  });
  const ego = await buildEgoGraphs(map);
  console.log(
    `      matrice ${matrix.order.length}² (${Math.round(matrix.density * 100)} % remplie) · ` +
      `${events.length} événements · ${Object.keys(ego).length} vues ego`,
  );

  step(7, 'Rendu (json, drawio, viewer, rapport)');
  const diff = diffMaps(previous, map);
  const contract = diffContracts(previous, map);
  if (contract.breaking.length > 0 || contract.additive.length > 0) {
    console.log(
      `      contrats : ${contract.breaking.length} rupture(s), ${contract.additive.length} ajout(s)`,
    );
  }
  const report = renderDiffMarkdown(diff, map, contract);
  const files: Record<string, string> = {
    'event-map.json': JSON.stringify(map, null, 2) + '\n',
    'event-map.drawio': renderDrawio(graph, ego, map),
    'event-map.html': await renderViewer({ map, matrix, ego, events }),
    'REPORT.md': report + '\n',
  };

  await mkdir(cfg.output.dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(cfg.output.dir, name), content, 'utf8');
  }
  console.log(`      écrits dans ${cfg.output.dir}`);

  step(8, cfg.git.enabled ? 'Commit et publication' : 'Publication git désactivée');
  if (cfg.git.enabled) {
    const res = await commitAndPush(cfg, files, report, map);
    console.log(
      res.changed
        ? `      poussé sur ${res.branch}${res.prUrl ? ` — PR : ${res.prUrl}` : ''}`
        : '      topologie inchangée, rien à commiter',
    );
  }

  console.log(`\n${report}\n`);
  console.log(`Terminé en ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (cfg.failOnBreakingSchema && contract.breaking.length > 0) {
    const impacted = new Set(contract.breaking.flatMap((c) => c.impacted));
    console.error(
      `${contract.breaking.length} rupture(s) de contrat touchant ${impacted.size} consommateur(s) ` +
        `— sortie en échec (FAIL_ON_BREAKING_SCHEMA).`,
    );
    return 1;
  }

  const newErrors = diff.newWarnings.filter((w) => w.level !== 'info');
  if (cfg.failOnNewWarnings && newErrors.length > 0) {
    console.error(`${newErrors.length} nouvelle(s) anomalie(s) — sortie en échec (FAIL_ON_NEW_WARNINGS).`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Échec de la découverte :', err instanceof Error ? err.stack : err);
    process.exit(2);
  });
