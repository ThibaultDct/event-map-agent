#!/usr/bin/env node
/**
 * `npm run try` — essai en une commande, sans rien installer dans le cluster.
 *
 * Ouvre lui-même le tunnel vers l'API management, lance la découverte, referme
 * le tunnel, et ouvre le viewer. L'objectif est qu'on puisse juger l'outil avant
 * d'avoir à construire une image, créer un utilisateur ou toucher au code Java.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m' };
const ok = (m) => console.log(`${C.g}✓${C.r} ${m}`);
const info = (m) => console.log(`${C.dim}  ${m}${C.r}`);
const fail = (m) => { console.error(`${C.red}✗ ${m}${C.r}`); process.exit(1); };

function has(cmd) {
  try {
    execFileSync(cmd, ['version', '--client'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await portFree(port);
    if (!free) return true; // quelqu'un écoute : le tunnel est prêt
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Voir setup.mjs : sans ça, un stdin fermé trop tôt fige le process au lieu
// d'échouer proprement.
let inputClosed = false;
const onClose = new Promise((res) => rl.once('close', () => { inputClosed = true; res(null); }));
const ask = async (q, def) => {
  const a = await Promise.race([rl.question(`${q}${def ? ` ${C.dim}[${def}]${C.r}` : ''} : `), onClose]);
  if (a === null || inputClosed) fail("Entrée interrompue avant la fin du questionnaire.");
  return a.trim() || def || '';
};

console.log(`\n${C.b}Essai local de event-system-visualizer${C.r}`);
console.log(`${C.dim}Aucune modification du cluster ni de vos services.${C.r}\n`);

if (!has('kubectl')) fail("kubectl est introuvable dans le PATH.");
ok('kubectl trouvé');

if (!existsSync(resolve('dist/index.js'))) {
  info('dist/ absent — compilation…');
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
}
ok('outil compilé');

const ns = await ask('Namespace de RabbitMQ', 'messaging');
const svc = await ask('Nom du Service RabbitMQ', 'rabbitmq');
const port = await ask("Port de l'API management", '15672');
const user = await ask('Utilisateur RabbitMQ', 'guest');
const pass = await ask('Mot de passe', 'guest');
const vhost = await ask('vhost', '/');
rl.removeAllListeners('close');
rl.close();

const local = 15672;
if (!(await portFree(local))) {
  fail(`Le port ${local} est déjà occupé en local. Ferme le processus qui l'utilise et relance.`);
}

console.log(`\n${C.dim}Ouverture du tunnel vers ${ns}/${svc}:${port}…${C.r}`);
const pf = spawn('kubectl', ['port-forward', '-n', ns, `svc/${svc}`, `${local}:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let pfError = '';
pf.stderr.on('data', (d) => { pfError += d.toString(); });

const cleanup = () => { if (!pf.killed) pf.kill(); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

if (!(await waitForPort(local, 10_000))) {
  cleanup();
  fail(`Le tunnel ne s'est pas ouvert.\n${pfError.trim() || 'Vérifie le namespace et le nom du Service.'}`);
}
ok(`tunnel ouvert sur localhost:${local}`);

console.log('');
let code = 0;
try {
  execFileSync('node', ['dist/index.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      RABBIT_MGMT_URL: `http://localhost:${local}`,
      RABBIT_USER: user,
      RABBIT_PASS: pass,
      RABBIT_VHOST: vhost,
      // Depuis un poste de travail, les IP de pods ne sont pas routables :
      // interroger les manifestes n'aboutirait qu'à une série de timeouts.
      COLLECT_MANIFESTS: 'false',
      GIT_ENABLED: 'false',
      OUTPUT_DIR: './out',
    },
  });
} catch {
  code = 1;
} finally {
  cleanup();
}

if (code !== 0) fail('La découverte a échoué — voir le message ci-dessus.');

const page = resolve('out/event-map.html');
console.log(`\n${C.g}${C.b}Terminé.${C.r} Ouvre ${C.b}${page}${C.r}`);
console.log(
  `${C.y}Note${C.r} : la colonne « producteurs » est vide, c'est normal à ce stade.\n` +
    `     Elle se remplit quand l'agent est déployé dans les services (partie 3 du README).`,
);

try {
  const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [page], { detached: true, stdio: 'ignore' }).unref();
} catch {
  /* l'ouverture automatique est un confort, pas une étape nécessaire */
}
