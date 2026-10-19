/* Integration smoke test for the mobile VaultGitFS and real isomorphic-git.
 * Uses a temporary vault and an Obsidian API shim; no GitHub credentials needed.
 * Run: node tests/mobile-adapter.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const git = require('isomorphic-git');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghsync-mobile-'));
const compiled = path.join(root, 'VaultGitFS.cjs');
const originalLoad = Module._load;
class TFile {}
class TFolder {}
Module._load = function (id, parent, isMain) {
  if (id === 'obsidian') {
    return {
      normalizePath(value) {
        const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts.join('/') || '/';
      },
      TFile, TFolder
    };
  }
  return originalLoad.call(this, id, parent, isMain);
};

function absolute(input) {
  const rel = (input || '').replace(/^\/+/, '');
  const resolved = path.resolve(root, rel);
  assert(resolved === root || resolved.startsWith(root + path.sep));
  return resolved;
}
function rel(abs) { return path.relative(root, abs).replace(/\\/g, '/'); }

const adapter = {
  async exists(p) { try { await fsp.access(absolute(p)); return true; } catch { return false; } },
  async stat(p) {
    try {
      const value = await fsp.stat(absolute(p));
      return { type: value.isDirectory() ? 'folder' : 'file',
        size: value.size, ctime: value.ctimeMs, mtime: value.mtimeMs };
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  },
  async read(p) { return fsp.readFile(absolute(p), 'utf8'); },
  async readBinary(p) {
    const b = await fsp.readFile(absolute(p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async write(p, text) { await fsp.writeFile(absolute(p), text); },
  async writeBinary(p, bytes) { await fsp.writeFile(absolute(p), Buffer.from(bytes)); },
  async mkdir(p) { await fsp.mkdir(absolute(p)); },
  async list(p) {
    const dirs = await fsp.readdir(absolute(p), { withFileTypes: true });
    return { files: dirs.filter(x => x.isFile()).map(x => rel(path.join(absolute(p), x.name))),
      folders: dirs.filter(x => x.isDirectory()).map(x => rel(path.join(absolute(p), x.name))) };
  },
  async rmdir(p, recursive = false) { await fsp.rm(absolute(p), { recursive, force: false }); },
  async remove(p) { await fsp.unlink(absolute(p)); }
};
const vault = {
  adapter, configDir: '.obsidian',
  getAbstractFileByPath: () => null,
  getFolderByPath: () => null,
  async create(p, content) { await adapter.write(p, content); },
  async createBinary(p, content) { await adapter.writeBinary(p, content); },
  async createFolder(p) { await adapter.mkdir(p); }
};

(async function run() {
  try {
    await esbuild.build({
      entryPoints: ['src/mobile/VaultGitFS.ts'], bundle: true, platform: 'node',
      format: 'cjs', external: ['obsidian'], outfile: compiled,
    });
    const { VaultGitFS } = require(compiled);
    const mobileFs = new VaultGitFS(vault);
    await git.init({ fs: mobileFs, dir: '/', defaultBranch: 'main' });
    await mobileFs.promises.writeFile('/notes.md', 'First revision');
    let matrix = await git.statusMatrix({ fs: mobileFs, dir: '/' });
    assert(matrix.some(([p]) => p === 'notes.md'), 'New note should be visible to Git');
    await git.add({ fs: mobileFs, dir: '/', filepath: 'notes.md' });
    await git.commit({ fs: mobileFs, dir: '/', author: { name: 'Mobile', email: 'mobile@example.com' },
      message: 'first revision' });
    await mobileFs.flush();
    const log = await git.log({ fs: mobileFs, dir: '/', depth: 1 });
    assert.equal(log[0].commit.message, 'first revision');
    assert.equal(await mobileFs.promises.readFile('/notes.md', 'utf8'), 'First revision');

    await mobileFs.promises.writeFile('/notes.md', 'Second revision');
    await git.add({ fs: mobileFs, dir: '/', filepath: 'notes.md' });
    await git.commit({ fs: mobileFs, dir: '/', author: { name: 'Mobile', email: 'mobile@example.com' },
      message: 'second revision' });
    await mobileFs.flush();
    matrix = await git.statusMatrix({ fs: mobileFs, dir: '/' });
    assert(matrix.every(([p, a, b, c]) => p !== 'notes.md' || (a === 1 && b === 1 && c === 1)),
      'Committed note should be clean');

    const binary = Uint8Array.from([0, 255, 128, 42]);
    await mobileFs.promises.writeFile('/attachment.bin', binary);
    const readBinary = await mobileFs.promises.readFile('/attachment.bin');
    assert.deepEqual(Array.from(readBinary), Array.from(binary));
    console.log('Mobile filesystem smoke test passed');
  } finally {
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
