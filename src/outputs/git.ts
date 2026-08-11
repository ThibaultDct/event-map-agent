import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { EventMap } from '../model.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Le token ne doit jamais finir dans un remote persisté (il serait lisible dans
 * .git/config et dans la sortie de `git remote -v`). On l'injecte uniquement au
 * moment du clone et du push, via un header HTTP éphémère.
 */
function authArgs(cfg: Config): string[] {
  if (!cfg.git.token) return [];
  const basic = Buffer.from(`x-access-token:${cfg.git.token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

export async function prepareRepo(cfg: Config): Promise<void> {
  if (existsSync(join(cfg.git.repoDir, '.git'))) {
    await git(cfg.git.repoDir, ...authArgs(cfg), 'fetch', 'origin', cfg.git.baseBranch);
    await git(cfg.git.repoDir, 'checkout', cfg.git.baseBranch);
    await git(cfg.git.repoDir, 'reset', '--hard', `origin/${cfg.git.baseBranch}`);
    return;
  }
  if (!cfg.git.repoUrl) {
    throw new Error(
      `GIT_ENABLED=true mais ${cfg.git.repoDir} n'est pas un dépôt git et GIT_REPO_URL n'est pas défini.`,
    );
  }
  await mkdir(cfg.git.repoDir, { recursive: true });
  await exec('git', [
    ...authArgs(cfg),
    'clone',
    '--depth',
    '1',
    '--branch',
    cfg.git.baseBranch,
    cfg.git.repoUrl,
    cfg.git.repoDir,
  ]);
}

/** Relit la carte du run précédent depuis le dépôt, si elle existe. */
export async function readPreviousMap(cfg: Config): Promise<EventMap | undefined> {
  const path = cfg.git.enabled
    ? join(cfg.git.repoDir, cfg.git.subdir, 'event-map.json')
    : cfg.output.previousPath;
  if (!path || !existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as EventMap;
    // Un changement de schéma rend le merge et le diff ininterprétables :
    // mieux vaut repartir de zéro que produire un diff mensonger.
    if (parsed.schemaVersion !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface CommitResult {
  changed: boolean;
  branch: string;
  prUrl?: string;
}

export async function commitAndPush(
  cfg: Config,
  files: Record<string, string>,
  diffSummary: string,
  map: EventMap,
): Promise<CommitResult> {
  const stamp = map.generatedAt.replace(/[:.]/g, '-').slice(0, 16);
  const branch = `${cfg.git.branchPrefix}${stamp}`;
  const dir = cfg.git.repoDir;

  await git(dir, 'config', 'user.name', cfg.git.authorName);
  await git(dir, 'config', 'user.email', cfg.git.authorEmail);
  await git(dir, 'checkout', '-B', branch);

  const target = join(dir, cfg.git.subdir);
  await mkdir(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(target, name), content, 'utf8');
  }

  await git(dir, 'add', '--all', cfg.git.subdir);
  const staged = await git(dir, 'diff', '--cached', '--name-only');
  if (!staged) return { changed: false, branch };

  const title = `carte des événements — ${map.generatedAt.slice(0, 10)}`;
  await git(dir, 'commit', '-m', title, '-m', diffSummary.slice(0, 60_000));
  await git(dir, ...authArgs(cfg), 'push', '--force-with-lease', 'origin', branch);

  let prUrl: string | undefined;
  if (cfg.git.openPr) prUrl = await openPullRequest(cfg, branch, title, diffSummary);

  return { changed: true, branch, prUrl };
}

async function openPullRequest(
  cfg: Config,
  branch: string,
  title: string,
  body: string,
): Promise<string | undefined> {
  if (!cfg.git.token || !cfg.git.repository) {
    console.warn('[git] GIT_OPEN_PR=true mais GITHUB_TOKEN ou GITHUB_REPOSITORY manque — PR non créée.');
    return undefined;
  }
  const res = await fetch(`https://api.github.com/repos/${cfg.git.repository}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.git.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, head: branch, base: cfg.git.baseBranch, body: body.slice(0, 60_000) }),
  });

  if (res.status === 201) {
    return ((await res.json()) as { html_url: string }).html_url;
  }
  // 422 = une PR ouverte existe déjà pour cette branche : le push l'a mise à jour.
  if (res.status === 422) {
    console.log('[git] PR déjà ouverte pour cette branche, mise à jour par le push.');
    return undefined;
  }
  console.warn(`[git] création de PR échouée : ${res.status} ${await res.text()}`);
  return undefined;
}
