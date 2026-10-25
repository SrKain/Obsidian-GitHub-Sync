import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { SimpleGit } from 'simple-git';

export interface ConflictVersions {
  local: string;
  remote: string;
  working: string | null;
}

const MAX_TEXT_LENGTH = 200_000;

/**
 * Only handle Git's unresolved, two-sided Markdown text conflicts.
 * Delete/modify conflicts, binary files and other complex cases remain paused.
 */
export async function readDesktopConflict(
  git: SimpleGit,
  app: App,
  path: string,
): Promise<ConflictVersions | null> {
  if (!path.toLowerCase().endsWith('.md')) return null;
  if (!(await git.status()).conflicted.includes(path)) return null;

  let local: string;
  let remote: string;
  try {
    local = await git.raw(['show', ':2:' + path]);
    remote = await git.raw(['show', ':3:' + path]);
  } catch {
    return null; // Missing stage, e.g. a delete/modify conflict.
  }
  const adapter = app.vault.adapter;
  const working = await adapter.exists(path) ? await adapter.read(path) : null;
  const contents = [local, remote, working ?? ''];
  if (contents.some(value => value.length > MAX_TEXT_LENGTH || value.includes('\0'))) return null;
  return { local, remote, working };
}

function sameSnapshot(a: ConflictVersions, b: ConflictVersions): boolean {
  return a.local === b.local && a.remote === b.remote && a.working === b.working;
}

/** Back up the three versions locally, before changing the working copy. */
async function backupConflict(app: App, path: string, snapshot: ConflictVersions): Promise<void> {
  const adapter = app.vault.adapter;
  const backupDir = '.git/github-sync-backups';
  if (!await adapter.exists(backupDir)) await adapter.mkdir(backupDir);
  const unique = new Date().toISOString().replace(/[:.]/g, '-') +
    '-' + Math.random().toString(36).slice(2, 10);
  await adapter.write(backupDir + '/' + unique + '.json', JSON.stringify({
    path,
    timestamp: new Date().toISOString(),
    ...snapshot,
  }));
}

/**
 * Save explicitly selected resolution, then stage just the selected file.
 * Git is not committed/pushed here. Sync resumes only after all conflicts clear.
 */
export async function applyDesktopResolution(
  git: SimpleGit,
  app: App,
  path: string,
  snapshot: ConflictVersions,
  resolved: string,
): Promise<void> {
  if (!path.toLowerCase().endsWith('.md')) throw new Error('Only Markdown text conflicts can be resolved here.');
  if (/(^|\n)(<{7}|>{7})(?:[^\n]*)/m.test(resolved)) {
    throw new Error('Remove Git conflict markers from the resulting note before applying.');
  }
  const current = await readDesktopConflict(git, app, path);
  if (!current || !sameSnapshot(current, snapshot)) {
    throw new Error('This conflict changed while it was open. Reopen the resolver and compare again.');
  }
  await backupConflict(app, path, snapshot);

  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    await app.vault.process(file, oldText => {
      if (oldText !== snapshot.working) {
        throw new Error('The note changed while it was open. Your resolution was not applied.');
      }
      return resolved;
    });
  } else if (snapshot.working === null && !await app.vault.adapter.exists(path)) {
    await app.vault.create(path, resolved);
  } else {
    throw new Error('The note changed while it was open. Reopen the resolver.');
  }
  await git.raw(['add', '--', path]);
}
