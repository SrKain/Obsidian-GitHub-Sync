import { App, requestUrl } from 'obsidian';
import { PLUGIN_SETTINGS_PATH, classifySyncError, retryRead, sameRemote, RemoteMainMissingError, SyncConflictError, validateRemote } from '../core/SyncSafety';
import { VaultGitFS } from './VaultGitFS';

/**
 * Only loaded on mobile. Never imports child_process, fs, or Electron.
 * The same local .git history can be used by desktop Git.
 */
export class MobileSync {
  private readonly fs: VaultGitFS;
  private readonly dir = '/';
  private readonly bootstrapMarker = '.git/github-sync-bootstrap';

  constructor(
    private readonly app: App,
    private readonly getSettings: () => {
      remoteURL: string; mobileTokenKey: string;
      mobileAuthorName: string; mobileAuthorEmail: string;
    }
  ) {
    this.fs = new VaultGitFS(app.vault);
  }

  private get fsClient(): any {
    // isomorphic-git exposes the Node fs subset, bridged by VaultGitFS.
    return this.fs;
  }

  private get remote(): string {
    return validateRemote(this.getSettings().remoteURL, true);
  }

  private get author() {
    const settings = this.getSettings();
    return {
      name: settings.mobileAuthorName.trim() || 'Obsidian Mobile',
      email: settings.mobileAuthorEmail.trim() || 'obsidian-mobile@users.noreply.github.com',
    };
  }

  private get onAuth() {
    const settings = this.getSettings();
    const token = settings.mobileTokenKey ? this.app.secretStorage.getSecret(settings.mobileTokenKey) : null;
    if (settings.mobileTokenKey && !token) {
      throw new Error('GitHub authentication failed: the selected secret is unavailable on this device.');
    }
    return () => token ? { username: 'x-access-token', password: token } : {};
  }

  private readonly http = {
    request: async ({ url, method, headers, body }: {
      url: string; method?: string;
      headers?: Record<string, string>;
      body?: AsyncIterable<Uint8Array>;
    }) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (body) for await (const chunk of body) { chunks.push(chunk); total += chunk.byteLength; }
      const payload = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
      const response = await requestUrl({
        url,
        method: method || 'GET',
        headers: { 'Accept-Encoding': 'identity', ...headers },
        body: body ? payload.buffer : undefined,
        throw: false,
      });
      const bytes = new Uint8Array(response.arrayBuffer);
      // Obsidian's requestUrl returns an ArrayBuffer, which satisfies the
      // async iterable response shape required by isomorphic-git.
      return {
        url, method: method || 'GET', headers: response.headers,
        body: (async function* () { yield bytes; })(),
        statusCode: response.status, statusMessage: String(response.status),
      };
    },
  };

  private async git() {
    // Dynamic import keeps the mobile Git runtime out of desktop execution.
    return import('isomorphic-git');
  }

  /** Inspect advertised branches without changing local refs or files. */
  private async remoteHeads(): Promise<Record<string, string>> {
    const git = await this.git();
    const info = await retryRead(() => git.getRemoteInfo({
      http: this.http as any, url: this.remote, onAuth: this.onAuth,
    }));
    return info.refs?.heads ?? {};
  }

  /** An unborn main has a HEAD symref but no resolvable branch commit. */
  private async hasLocalMain(git: any): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fsClient, dir: this.dir, ref: 'refs/heads/main' });
      return true;
    } catch (error) {
      if ((error as { name?: string })?.name === 'NotFoundError') return false;
      throw error;
    }
  }

  private async prepare() {
    const git = await this.git();
    const remote = this.remote;
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists('.git')) {
      const existing = this.app.vault.getFiles().filter(f =>
        !f.path.startsWith(this.app.vault.configDir + '/')
      );
      if (existing.length) {
        throw new Error('This vault already contains notes. To prevent data loss, connect an empty mobile vault or import a vault containing its .git history.');
      }
      const heads = await this.remoteHeads();
      if (!('main' in heads)) {
        if (Object.keys(heads).length) throw new RemoteMainMissingError();
        // Empty remote: initialize an unborn main instead of cloning an absent ref.
        await git.init({ fs: this.fsClient, dir: this.dir, defaultBranch: 'main' });
        await git.addRemote({ fs: this.fsClient, dir: this.dir, remote: 'origin', url: remote });
      } else {
        // Never checkout before checking for file collisions (especially .obsidian).
        await git.clone({
          fs: this.fsClient, http: this.http as any, dir: this.dir,
          url: remote, ref: 'main', singleBranch: true, noCheckout: true,
          onAuth: this.onAuth,
        });
        await adapter.write(this.bootstrapMarker, 'pending');
      }
    }

    if (await adapter.exists(this.bootstrapMarker)) {
      const heads = await this.remoteHeads();
      if (!('main' in heads)) {
        if (Object.keys(heads).length) throw new RemoteMainMissingError();
        // Recover clones of an empty remote, without deleting .git or vault files.
        const head = (await adapter.read('.git/HEAD')).trim();
        if (head !== 'ref: refs/heads/main') {
          throw new Error('Mobile bootstrap HEAD is not on main. Inspect Git history on desktop before syncing.');
        }
        await adapter.remove(this.bootstrapMarker);
      } else {
        const paths = await git.listFiles({ fs: this.fsClient, dir: this.dir, ref: 'main' });
        if (paths.includes(PLUGIN_SETTINGS_PATH)) {
          throw new Error('The GitHub repository contains plugin data.json, which may expose credentials. Remove this file from Git history before continuing.');
        }
        const collisions: string[] = [];
        for (const path of paths) if (await adapter.exists(path)) collisions.push(path);
        if (collisions.length) {
          throw new Error('Mobile setup paused: existing files would be overwritten (' +
            collisions.slice(0, 5).join(', ') + '). Move or back up conflicting files before retrying.');
        }
        await git.checkout({
          fs: this.fsClient, dir: this.dir, ref: 'main',
          filepaths: paths, noUpdateHead: true, force: false,
          nonBlocking: true, batchSize: 30,
        });
        await adapter.remove(this.bootstrapMarker);
      }
    }

    // Refuse to upload a tracked settings file, including repositories that
    // were initialized before this plugin version.
    const trackedFiles = await this.hasLocalMain(git)
      ? await git.listFiles({ fs: this.fsClient, dir: this.dir })
      : [];
    if (trackedFiles.includes(PLUGIN_SETTINGS_PATH)) {
      throw new Error('Git is tracking plugin data.json. Untrack it on desktop and rotate any exposed token before syncing.');
    }
    // Checking the HEAD symref also handles unborn main, for which
    // currentBranch can return undefined or throw in some isomorphic-git builds.
    const head = (await adapter.read('.git/HEAD')).trim();
    if (head !== 'ref: refs/heads/main') {
      throw new Error('Mobile sync currently supports only the main branch.');
    }

    const remotes = await git.listRemotes({ fs: this.fsClient, dir: this.dir });
    const origin = remotes.find(entry => entry.remote === 'origin');
    if (!origin) {
      await git.addRemote({ fs: this.fsClient, dir: this.dir, remote: 'origin', url: remote });
    } else if (!origin.url.startsWith('https://') || !sameRemote(origin.url, remote)) {
      // No silent re-targeting, nor SSH URLs that fail on mobile.
      throw new Error('Vault origin does not match the configured HTTPS repository. Resolve this mismatch on desktop first.');
    }
    return git;
  }

  /** Read-only connection test used by the setup assistant. */
  async verifyConnection(): Promise<void> {
    const git = await this.git();
    await retryRead(() => git.getRemoteInfo({
      http: this.http as any, url: this.remote, onAuth: this.onAuth,
    }));
  }

  async checkRemote(): Promise<boolean> {
    try {
      if (!await this.app.vault.adapter.exists('.git')) return false;
      if (await this.app.vault.adapter.exists(this.bootstrapMarker)) return false;
      if (!('main' in await this.remoteHeads())) return false;
      const git = await this.prepare();
      await retryRead(() => git.fetch({
        fs: this.fsClient, http: this.http as any, dir: this.dir,
        remote: 'origin', ref: 'main', singleBranch: true, onAuth: this.onAuth,
      }));
      if (!await this.hasLocalMain(git)) return true;
      const local = await git.resolveRef({ fs: this.fsClient, dir: this.dir, ref: 'refs/heads/main' });
      const remote = await git.resolveRef({ fs: this.fsClient, dir: this.dir, ref: 'refs/remotes/origin/main' });
      if (local === remote) return false;
      // A divergence is also relevant, since remote contains unseen commits.
      return !(await git.isDescendent({ fs: this.fsClient, dir: this.dir, oid: local, ancestor: remote }));
    } finally {
      await this.fs.flush();
    }
  }

  async sync(): Promise<void> {
    try {
      const git = await this.prepare();
      const fs = this.fsClient;
      const dir = this.dir;
      const author = this.author;
      const status = await git.statusMatrix({ fs, dir });
      let changed = false;
      for (const [filepath, head, workdir, stage] of status) {
        // A plugin must never accidentally commit its own configuration.
        if (filepath === PLUGIN_SETTINGS_PATH) continue;
        if (workdir === 0 && head !== 0) {
          await git.remove({ fs, dir, filepath }); changed = true;
        } else if (workdir !== 0 && (head !== workdir || workdir !== stage)) {
          await git.add({ fs, dir, filepath }); changed = true;
        }
      }
      if (changed) {
        await git.commit({
          fs, dir, author, committer: author,
          message: 'Obsidian mobile ' + new Date().toISOString(),
        });
      }
      const heads = await this.remoteHeads();
      const remoteHasMain = 'main' in heads;
      if (!remoteHasMain && Object.keys(heads).length) throw new RemoteMainMissingError();
      if (remoteHasMain) {
        await retryRead(() => git.fetch({
          fs, http: this.http as any, dir, remote: 'origin',
          ref: 'main', singleBranch: true, onAuth: this.onAuth,
        }));
        const local = await git.resolveRef({ fs, dir, ref: 'refs/heads/main' });
        const remote = await git.resolveRef({ fs, dir, ref: 'refs/remotes/origin/main' });
        if (local !== remote) {
          try {
            await git.pull({
              fs, http: this.http as any, dir, remote: 'origin', ref: 'main',
              author, committer: author, onAuth: this.onAuth,
            });
          } catch (error) {
            const data = (error as { data?: { filepaths?: string[] } })?.data;
            const files = Array.isArray(data?.filepaths) ? data.filepaths : [];
            if (files.length || classifySyncError(error) === 'conflict') {
              throw new SyncConflictError(files);
            }
            // Propagate errors for classification, never put raw Git text in notices.
            throw error;
          }
        }
      }
      // An unborn local main cannot be pushed. Empty vault + empty remote is OK.
      if (!await this.hasLocalMain(git)) return;
      try {
        const result = await git.push({
          fs, http: this.http as any, dir, remote: 'origin', ref: 'main',
          onAuth: this.onAuth,
        });
        if (!result.ok) {
          const errors = [result.error, ...Object.values(result.refs ?? {}).map(
            (ref: any) => ref.error
          )].filter(Boolean).join(' ');
          if (/non.fast.forward|fetch first|stale info/i.test(errors)) {
            throw new SyncConflictError([]);
          }
          throw new Error('GitHub rejected the push. Check repository write permissions or branch protection.');
        }
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error);
        if (/non.fast.forward|fetch first|stale info/i.test(detail)) {
          throw new SyncConflictError([]);
        }
        throw error;
      }
    } finally {
      await this.fs.flush();
    }
  }
}
