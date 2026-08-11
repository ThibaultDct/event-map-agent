#!/usr/bin/env node
/**
 * `npm run setup` — génère les manifestes Kubernetes à partir de quelques
 * réponses, au lieu de faire éditer un YAML de cent lignes à la main.
 *
 * Les mots de passe et jetons ne sont **jamais** écrits sur disque : le script
 * imprime les commandes `kubectl create secret` à exécuter, et les manifestes
 * ne contiennent que des références `secretKeyRef`.
 */
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m' };

/**
 * Mode non-interactif : `npm run setup -- --yes`. Chaque réponse peut être
 * fournie par la variable d'environnement correspondante, dont le nom est
 * volontairement le même qu'à l'exécution du job. Rend le script utilisable
 * depuis un pipeline, et permet de régénérer les manifestes à l'identique.
 */
const AUTO = process.argv.includes('--yes') || process.argv.includes('-y');

const rl = AUTO ? null : createInterface({ input: process.stdin, output: process.stdout });

/**
 * Si stdin se ferme avant la fin du questionnaire — Ctrl-D, ou des réponses
 * pipées en nombre insuffisant — `rl.question()` ne se résout jamais et le
 * process se fige sur un avertissement obscur. On transforme ça en échec net.
 */
let inputClosed = false;
const onClose = rl
  ? new Promise((resolve) => rl.once('close', () => { inputClosed = true; resolve(null); }))
  : Promise.resolve(null);

const ask = async (envKey, q, def) => {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (AUTO) return def ?? '';
  const answer = await Promise.race([rl.question(`${q}${def ? ` ${C.dim}[${def}]${C.r}` : ''} : `), onClose]);
  if (answer === null || inputClosed) {
    console.error(`\n${C.y}Entrée interrompue avant la fin du questionnaire — rien n'a été écrit.${C.r}`);
    process.exit(1);
  }
  return answer.trim() || def || '';
};

const truthy = (s) => ['o', 'y', 'oui', 'yes', 'true', '1'].includes(String(s).toLowerCase());
const askYes = async (envKey, q, def = true) => {
  const a = await ask(envKey, `${q} ${def ? '(O/n)' : '(o/N)'}`, def ? 'o' : 'n');
  return truthy(a);
};

console.log(`\n${C.b}Configuration du job de découverte${C.r}`);
console.log(`${C.dim}Aucun secret ne sera écrit sur disque.${C.r}\n`);

console.log(`${C.c}— Cluster —${C.r}`);
const platformNs = await ask('PLATFORM_NAMESPACE', 'Namespace où déployer le job', 'platform');
const clusterName = await ask('CLUSTER_NAME', 'Nom du cluster (affiché sur la carte)', 'production');
const appNs = await ask('K8S_NAMESPACES', 'Namespaces applicatifs à scanner, séparés par des virgules (vide = tous)', '');

console.log(`\n${C.c}— RabbitMQ —${C.r}`);
const rabbitNs = await ask('RABBIT_NAMESPACE', 'Namespace de RabbitMQ', 'messaging');
const rabbitSvc = await ask('RABBIT_SERVICE', 'Nom du Service RabbitMQ', 'rabbitmq');
const rabbitPort = await ask('RABBIT_PORT', "Port de l'API management", '15672');
const rabbitUser = await ask('RABBIT_USER', "Utilisateur RabbitMQ (tag 'monitoring')", 'eventmap');
const vhost = await ask('RABBIT_VHOST', 'vhost', '/');

console.log(`\n${C.c}— Image —${C.r}`);
const image = await ask('IMAGE', 'Image du job', 'registry.internal/event-system-visualizer:1.0.0');

console.log(`\n${C.c}— Conventions de nommage —${C.r}`);
const eventPrefixes = await ask('EVENT_PREFIXES', 'Préfixes des événements', 'evt,event');
const commandPrefixes = await ask('COMMAND_PREFIXES', 'Préfixes des commandes', 'cmd,command');

console.log(`\n${C.c}— Publication de la carte —${C.r}`);
const gitEnabled = await askYes('GIT_ENABLED', 'Commiter la carte dans un dépôt git ?', false);
let gitRepoUrl = '';
let gitRepository = '';
let gitBranch = 'main';
let gitSubdir = 'docs/event-map';
let openPr = false;
if (gitEnabled) {
  gitRepoUrl = await ask('GIT_REPO_URL', 'URL de clonage', 'https://github.com/acme/platform-docs.git');
  gitRepository = await ask('GITHUB_REPOSITORY', 'Dépôt GitHub (org/nom)', 'acme/platform-docs');
  gitBranch = await ask('GIT_BASE_BRANCH', 'Branche de base', 'main');
  gitSubdir = await ask('GIT_SUBDIR', 'Sous-dossier de dépôt', 'docs/event-map');
  openPr = await askYes('GIT_OPEN_PR', 'Ouvrir une PR automatiquement ?', true);
}
if (rl) {
  rl.removeAllListeners('close');
  rl.close();
}

const mgmtUrl = `http://${rabbitSvc}.${rabbitNs}.svc.cluster.local:${rabbitPort}`;

const env = [
  ['CLUSTER_NAME', clusterName],
  ['RABBIT_MGMT_URL', mgmtUrl],
  ['RABBIT_VHOST', vhost],
  ...(appNs ? [['K8S_NAMESPACES', appNs]] : []),
  ['EVENT_PREFIXES', eventPrefixes],
  ['COMMAND_PREFIXES', commandPrefixes],
  ['OUTPUT_DIR', '/tmp/out'],
  ['STALE_AFTER_RUNS', '3'],
  ['GIT_ENABLED', String(gitEnabled)],
  ...(gitEnabled
    ? [
        ['GIT_REPO_URL', gitRepoUrl],
        ['GIT_REPO_DIR', '/tmp/repo'],
        ['GIT_SUBDIR', gitSubdir],
        ['GIT_BASE_BRANCH', gitBranch],
        ['GIT_OPEN_PR', String(openPr)],
        ['GITHUB_REPOSITORY', gitRepository],
      ]
    : []),
];

const envYaml = (indent) =>
  env
    .map(([k, v]) => `${indent}- name: ${k}\n${indent}  value: ${JSON.stringify(v)}`)
    .concat([
      `${indent}- name: RABBIT_USER`,
      `${indent}  valueFrom:`,
      `${indent}    secretKeyRef: { name: rabbit-monitoring, key: username }`,
      `${indent}- name: RABBIT_PASS`,
      `${indent}  valueFrom:`,
      `${indent}    secretKeyRef: { name: rabbit-monitoring, key: password }`,
      ...(gitEnabled
        ? [
            `${indent}- name: GITHUB_TOKEN`,
            `${indent}  valueFrom:`,
            `${indent}    secretKeyRef: { name: event-map-git, key: token }`,
          ]
        : []),
    ])
    .join('\n');

/** Le corps du pod est identique pour le Job et la CronJob : on le factorise. */
const podSpec = (indent) => `${indent}serviceAccountName: event-map-discovery
${indent}restartPolicy: Never
${indent}securityContext:
${indent}  runAsNonRoot: true
${indent}  seccompProfile: { type: RuntimeDefault }
${indent}containers:
${indent}  - name: discovery
${indent}    image: ${image}
${indent}    imagePullPolicy: IfNotPresent
${indent}    securityContext:
${indent}      allowPrivilegeEscalation: false
${indent}      readOnlyRootFilesystem: true
${indent}      capabilities: { drop: ["ALL"] }
${indent}    env:
${envYaml(`${indent}      `)}
${indent}    volumeMounts:
${indent}      - name: work
${indent}        mountPath: /tmp
${indent}    resources:
${indent}      requests: { cpu: 100m, memory: 256Mi }
${indent}      limits: { memory: 768Mi }
${indent}volumes:
${indent}  # readOnlyRootFilesystem impose un volume inscriptible pour le clone
${indent}  # git, les artefacts et les fichiers temporaires de node.
${indent}  - name: work
${indent}    emptyDir: { sizeLimit: 512Mi }`;

const rbac = `---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: event-map-discovery
  namespace: ${platformNs}
---
# Lecture seule, à l'échelle du cluster : la découverte doit voir les pods de
# tous les namespaces applicatifs pour corréler les IP des consommateurs AMQP.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: event-map-discovery
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "replicasets"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: event-map-discovery
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: event-map-discovery
subjects:
  - kind: ServiceAccount
    name: event-map-discovery
    namespace: ${platformNs}
`;

// Job à usage unique : c'est ce qu'on lance en premier, pour voir le résultat
// sans avoir à comprendre le mécanisme `kubectl create job --from=cronjob`.
const job = `---
apiVersion: batch/v1
kind: Job
metadata:
  name: event-map-discovery-run
  namespace: ${platformNs}
spec:
  backoffLimit: 1
  # Un scan qui traîne capture une topologie incohérente : mieux vaut échouer
  # et relancer que produire une carte à moitié vraie.
  activeDeadlineSeconds: 900
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        app.kubernetes.io/name: event-map-discovery
    spec:
${podSpec('      ')}
`;

const cronjob = `---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: event-map-discovery
  namespace: ${platformNs}
spec:
  # Gabarit pour les lancements manuels ou pilotés par la CI. \`suspend: true\`
  # neutralise la planification tant qu'on ne l'active pas explicitement.
  schedule: "0 3 * * *"
  suspend: true
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      activeDeadlineSeconds: 900
      ttlSecondsAfterFinished: 86400
      template:
        metadata:
          labels:
            app.kubernetes.io/name: event-map-discovery
        spec:
${podSpec('          ')}
`;

const dir = resolve('deploy/generated');
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/rbac.yaml`, rbac, 'utf8');
await writeFile(`${dir}/job.yaml`, job, 'utf8');
await writeFile(`${dir}/cronjob.yaml`, cronjob, 'utf8');

console.log(`\n${C.g}✓${C.r} Manifestes écrits dans ${C.b}deploy/generated/${C.r}`);
console.log(`${C.dim}  rbac.yaml · job.yaml (usage unique) · cronjob.yaml (gabarit)${C.r}`);

console.log(`\n${C.b}Il reste 3 commandes.${C.r}\n`);

console.log(`${C.c}1.${C.r} Créer le secret RabbitMQ (remplace le mot de passe) :\n`);
console.log(
  `   kubectl create secret generic rabbit-monitoring -n ${platformNs} \\\n` +
    `     --from-literal=username=${rabbitUser} \\\n` +
    `     --from-literal=password='VOTRE_MOT_DE_PASSE'\n`,
);
if (gitEnabled) {
  console.log(`${C.c} ${C.r}  Et le jeton git :\n`);
  console.log(
    `   kubectl create secret generic event-map-git -n ${platformNs} \\\n` +
      `     --from-literal=token='VOTRE_JETON'\n`,
  );
}

console.log(`${C.c}2.${C.r} Déployer les droits et lancer un premier scan :\n`);
console.log(`   kubectl apply -f deploy/generated/rbac.yaml -f deploy/generated/job.yaml\n`);

console.log(`${C.c}3.${C.r} Suivre l'exécution :\n`);
console.log(`   kubectl logs -n ${platformNs} -f job/event-map-discovery-run\n`);

console.log(
  `${C.y}Ensuite${C.r} : \`kubectl apply -f deploy/generated/cronjob.yaml\` installe le gabarit,\n` +
    `          pour relancer à la demande après chaque déploiement :\n\n` +
    `   kubectl create job --from=cronjob/event-map-discovery eventmap-$(date +%s) -n ${platformNs}\n`,
);
