/** A conflict is not an ordinary network error and cannot be retried automatically. */
export class SyncConflictError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super('Merge conflict requires manual resolution');
    this.name = 'SyncConflictError';
    this.files = files;
  }
}

/** A remote with other branches but no main must not be implicitly retargeted. */
export class RemoteMainMissingError extends Error {
  constructor() {
    super('Remote repository has no main branch.');
    this.name = 'RemoteMainMissingError';
  }
}

/**
 * Shared safety checks. These functions deliberately have no Obsidian, Git,
 * Electron, or filesystem dependencies so they work on phones and desktops.
 */
export const PLUGIN_SETTINGS_PATH = '.obsidian/plugins/github-sync/data.json';

export type SyncErrorKind =
  'auth' | 'permission' | 'network' | 'conflict' | 'remote' | 'unknown';

export function validateRemote(raw: string, mobile: boolean): string {
  const value = raw.trim();
  if (!value) throw new Error('Configure your GitHub repository before syncing.');
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('Repository URL is invalid. Copy its HTTPS clone URL from GitHub.'); }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('Remove credentials and query parameters from the repository URL. Store your token in Obsidian SecretStorage.');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port) {
      throw new Error('Only GitHub HTTPS clone URLs are supported.');
    }
    if (!/^\/[a-z\d_.-]+\/[a-z\d_.-]+(?:\.git)?\/?$/i.test(url.pathname)) {
      throw new Error('Repository URL must look like https://github.com/owner/repo.git');
    }
    return 'https://github.com' + url.pathname.replace(/\/$/, '');
  }
  if (!mobile && /^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/i.test(value)) return value;
  throw new Error(mobile
    ? 'On phones and tablets use an HTTPS GitHub repository URL, not SSH.'
    : 'Use a GitHub HTTPS or SSH clone URL.');
}

export function sameRemote(a: string, b: string): boolean {
  function canonical(value: string): string {
    const clean = value.trim().replace(/\/$/, '');
    const ssh = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(clean);
    if (ssh) return ssh[1].toLowerCase();
    const https = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(clean);
    return https ? https[1].toLowerCase() : clean.toLowerCase();
  }
  return canonical(a) === canonical(b);
}

export function classifySyncError(error: unknown): SyncErrorKind {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/conflict|unmerged|not possible to fast-forward|merge abort/.test(message)) return 'conflict';
  if (/authentication|invalid credentials|401|bad credentials|authentication failed/.test(message)) return 'auth';
  if (/403|permission denied|access denied|read-only|protected branch|not allowed to push/.test(message)) return 'permission';
  if (/timeout|timed out|econnreset|enotfound|network|eai_again|offline|failed to fetch|socket hang up|connection reset|502|503|504/.test(message)) return 'network';
  if (/404|repository not found|could not read from remote|not found/.test(message)) return 'remote';
  return 'unknown';
}

/** Never print full remote URLs, authorization headers or raw errors containing tokens. */
export function publicErrorMessage(error: unknown): string {
  const kind = classifySyncError(error);
  const detail = String(error instanceof Error ? error.message : error).toLowerCase();
  // These are fixed guidance strings, never forwarded input from Git, GitHub,
  // command-line output, or an untrusted URL. Only sanitized error names
  // may be added to the unknown fallback.
  if (error instanceof RemoteMainMissingError || detail.includes('remote repository has no main branch')) {
    return 'The remote repository has no main branch. The plugin syncs only main; create or rename main on GitHub.';
  }
  if (detail.includes('tracking plugin') || detail.includes('contains plugin data.json')) {
    return 'Your vault is tracking GitHub Sync data.json. Remove it from Git tracking and rotate previously exposed credentials.';
  }
  if (detail.includes('origin') && (detail.includes('differs') || detail.includes('does not match'))) {
    return 'The vault repository differs from the configured GitHub address. Verify both before syncing.';
  }
  if (detail.includes('not a git repository') || detail.includes('git is unavailable')) {
    return 'This vault has no usable Git repository. Initialize it or connect an existing cloned vault.';
  }
  if (detail.includes('branch is not main') || detail.includes('only the main branch')) {
    return 'Your vault is not on the main branch. Select or create main on desktop before syncing.';
  }
  if (detail.includes('selected secret is unavailable')) {
    return 'The saved GitHub token is unavailable on this device. Select a valid token in Obsidian settings.';
  }
  if (detail.includes('configure your github repository')) {
    return 'Enter your repository URL in the GitHub Sync settings.';
  }
  if (detail.includes('remove credentials') || detail.includes('query parameters')) {
    return 'The repository URL includes credentials or extra parameters. Remove them and use SecretStorage for tokens.';
  }
  if (detail.includes('repository url') || detail.includes('clone url') || detail.includes('github https')) {
    return 'Check the repository URL. Use https://github.com/owner/repo.git on mobile.';
  }
  switch (kind) {
    case 'auth': return 'GitHub authentication failed. Check the selected token and reconnect.';
    case 'permission': return 'GitHub rejected this operation. Check repository write permissions and branch protection.';
    case 'network': return 'Network connection failed. Your notes remain local; retry after reconnecting.';
    case 'conflict': return 'These notes have conflicting changes. Sync is paused; resolve the conflicts before retrying.';
    case 'remote': return 'Repository not found. Check its address and whether the token can access it.';
    default: {
      const name = error instanceof Error && /^[A-Za-z]{3,40}$/.test(error.name)
        ? ' (' + error.name + ')' : '';
      return 'Sync could not finish. No automatic reset or force-push was performed. Check the plugin settings.' + name;
    }
  }
}

/**
 * Retry read-only/idempotent remote operations only (fetch, ls-remote).
 * Never wrap commit, merge, checkout or push in this helper.
 */
export async function retryRead<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 3
): Promise<T> {
  let attempt = 0;
  while (true) {
    try { return await operation(); }
    catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || classifySyncError(error) !== 'network') throw error;
      await sleep(Math.min(4000, 500 * 2 ** (attempt - 1)));
    }
  }
}
