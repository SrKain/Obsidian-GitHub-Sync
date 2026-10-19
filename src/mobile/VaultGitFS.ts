import { normalizePath, TFile, TFolder, Vault } from 'obsidian';

/**
 * A Promise-based filesystem for isomorphic-git backed by Obsidian's Vault
 * and DataAdapter. Hidden files (.git) MUST be accessed via the adapter.
 * All paths passed by isomorphic-git are rooted at '/'.
 */
export class VaultGitFS {
  readonly promises: {
    readFile: typeof this.readFile;
    writeFile: typeof this.writeFile;
    readdir: typeof this.readdir;
    mkdir: typeof this.mkdir;
    rmdir: typeof this.rmdir;
    stat: typeof this.stat;
    lstat: typeof this.lstat;
    unlink: typeof this.unlink;
    readlink: typeof this.readlink;
    symlink: typeof this.symlink;
  };

  private index?: ArrayBuffer;
  private indexMtime?: number;
  private indexCtime?: number;

  constructor(private readonly vault: Vault) {
    this.promises = {
      readFile: this.readFile.bind(this),
      writeFile: this.writeFile.bind(this),
      readdir: this.readdir.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      stat: this.stat.bind(this),
      lstat: this.lstat.bind(this),
      unlink: this.unlink.bind(this),
      readlink: this.readlink.bind(this),
      symlink: this.symlink.bind(this),
    };
  }

  private path(value: string): string {
    if (value === '/' || value === '.' || value === '') return '/';
    // normalizePath strips leading slashes; isomorphic-git needs '/' as dir.
    return normalizePath(value.replace(/^\/+/, ''));
  }

  private hidden(path: string): boolean {
    return path.split('/').some(part => part.startsWith('.') && part !== '.' && part !== '..');
  }

  private missing(path: string): Error {
    return Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT' });
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop();
    let parent = '';
    for (const part of parts) {
      if (!part) continue;
      parent = parent ? parent + '/' + part : part;
      if (!await this.vault.adapter.exists(parent)) {
        await this.vault.adapter.mkdir(parent);
      }
    }
  }

  async readFile(input: string, opts?: string | { encoding?: string }): Promise<string | Uint8Array> {
    const path = this.path(input);
    if (path === '.git/index' && this.index) {
      return new Uint8Array(this.index);
    }
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return this.vault.adapter.read(path);
    }
    return new Uint8Array(await this.vault.adapter.readBinary(path));
  }

  async writeFile(input: string, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const path = this.path(input);
    const binary = typeof data !== 'string';
    const buffer: ArrayBuffer = !binary ? new ArrayBuffer(0)
      : data instanceof ArrayBuffer ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;

    if (path === '.git/index' && binary) {
      this.index = buffer;
      this.indexMtime = Date.now();
      this.indexCtime ??= this.indexMtime;
      return;
    }

    await this.ensureParent(path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (!this.hidden(path) && existing instanceof TFile) {
      if (typeof data === 'string') await this.vault.modify(existing, data);
      else await this.vault.modifyBinary(existing, buffer);
    } else if (!this.hidden(path) && !existing) {
      if (typeof data === 'string') await this.vault.create(path, data);
      else await this.vault.createBinary(path, buffer);
    } else if (typeof data === 'string') {
      await this.vault.adapter.write(path, data);
    } else {
      await this.vault.adapter.writeBinary(path, buffer);
    }
  }

  async readdir(input: string): Promise<string[]> {
    const path = this.path(input);
    const listing = await this.vault.adapter.list(path);
    return [...listing.folders, ...listing.files].map(name => name.split('/').pop() || '').filter(Boolean);
  }

  async mkdir(input: string): Promise<void> {
    const path = this.path(input);
    if (path === '/') return;
    if (await this.vault.adapter.exists(path)) return;
    await this.ensureParent(path);
    if (!this.hidden(path)) {
      await this.vault.createFolder(path);
    } else {
      await this.vault.adapter.mkdir(path);
    }
  }

  async rmdir(input: string, opts?: { recursive?: boolean }): Promise<void> {
    const path = this.path(input);
    if (path === '/') throw new Error('Cannot remove vault root');
    const file = this.vault.getAbstractFileByPath(path);
    if (!this.hidden(path) && file instanceof TFolder) {
      await this.vault.delete(file, opts?.recursive ?? false);
    } else {
      await this.vault.adapter.rmdir(path, opts?.recursive ?? false);
    }
  }

  async stat(input: string) {
    const path = this.path(input);
    if (path === '/') return this.asStat('folder', 0, Date.now(), Date.now());
    if (path === '.git/index' && this.index !== undefined) {
      return this.asStat('file', this.index.byteLength, this.indexCtime || Date.now(), this.indexMtime || Date.now());
    }
    const data = await this.vault.adapter.stat(path);
    if (!data) throw this.missing(path);
    return this.asStat(data.type, data.size, data.ctime, data.mtime);
  }

  private asStat(type: string, size: number, ctime: number, mtime: number) {
    const dir = type === 'folder' || type === 'directory';
    return {
      uid: 0, gid: 0, ino: 0, dev: 0,
      mode: dir ? 16877 : 33188, size, ctimeMs: ctime, mtimeMs: mtime,
      isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false,
    };
  }

  lstat(input: string) { return this.stat(input); }

  async unlink(input: string): Promise<void> {
    const path = this.path(input);
    const existing = this.vault.getAbstractFileByPath(path);
    if (!this.hidden(path) && existing instanceof TFile) await this.vault.delete(existing);
    else await this.vault.adapter.remove(path);
  }

  async readlink(): Promise<string> {
    throw Object.assign(new Error('Symbolic links not supported in mobile vaults'), { code: 'ENOSYS' });
  }

  async symlink(): Promise<void> {
    throw Object.assign(new Error('Symbolic links not supported in mobile vaults'), { code: 'ENOSYS' });
  }

  async flush(): Promise<void> {
    if (this.index) {
      await this.vault.adapter.writeBinary('.git/index', this.index, {
        ctime: this.indexCtime,
        mtime: this.indexMtime,
      });
      this.index = undefined;
      this.indexCtime = undefined;
      this.indexMtime = undefined;
    }
  }
}
