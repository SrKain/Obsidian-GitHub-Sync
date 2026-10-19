import type { SimpleGit } from 'simple-git';
import { PLUGIN_SETTINGS_PATH, retryRead, sameRemote, SyncConflictError } from '../core/SyncSafety';

/**
 * Native Git runner, testable independently of Obsidian.
 * The caller already validated the GitHub URL and the vault path.
 */
export async function runDesktopSync(
  git: SimpleGit,
  remote: string,
  settingsPath = PLUGIN_SETTINGS_PATH,
): Promise<void> {
  let status;
  try { status = await git.status(); }
  catch {
    throw new Error('This vault is not a Git repository or Git is unavailable.');
  }

  const branches = await git.branchLocal();
  if (branches.current !== 'main') {
    throw new Error('The current Git branch is not main.');
  }
  if (status.conflicted.length) {
    throw new SyncConflictError(status.conflicted);
  }

  // Never silently redirect notes to another repository.
  const remotes = await git.getRemotes(true);
  const origin = remotes.find(entry => entry.name === 'origin');
  if (!origin) {
    await git.addRemote('origin', remote);
  } else if (!sameRemote(origin.refs.fetch, remote) || !sameRemote(origin.refs.push, remote)) {
    throw new Error('The configured repository differs from this vault origin.');
  }

  // Plugin settings can contain legacy URL-embedded credentials.
  if ((await git.raw(['ls-files', '--', settingsPath])).trim()) {
    throw new Error('Git is tracking plugin settings (data.json). Untrack it and rotate any exposed secrets.');
  }

  if (!status.isClean()) {
    await git.add(['-A', '--', '.', ':!' + settingsPath]);
    const staged = await git.diff(['--cached', '--name-only']);
    if (staged.trim()) await git.commit('Obsidian desktop ' + new Date().toISOString());
  }

  await retryRead(() => git.fetch('origin', 'main'));
  try {
    await git.pull('origin', 'main', { '--no-rebase': null });
  } catch (error) {
    const conflicts = (await git.status()).conflicted;
    if (conflicts.length) throw new SyncConflictError(conflicts);
    throw error;
  }
  const pendingConflicts = (await git.status()).conflicted;
  if (pendingConflicts.length) throw new SyncConflictError(pendingConflicts);
  await git.push('origin', 'main', ['-u']);
}
