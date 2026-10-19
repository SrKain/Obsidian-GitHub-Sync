const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

(async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ghsync-safety-'));
  try {
    const compiled = path.join(temp, 'safety.cjs');
    await esbuild.build({
      entryPoints: ['src/core/SyncSafety.ts'], outfile: compiled, bundle: true,
      platform: 'node', format: 'cjs', target: 'es2020',
    });
    const {validateRemote,sameRemote,classifySyncError,publicErrorMessage,retryRead} = require(compiled);

    assert.equal(validateRemote('  https://github.com/SrKain/Notes.git  ', true),
      'https://github.com/SrKain/Notes.git');
    assert.equal(validateRemote('git@github.com:SrKain/Notes.git',false),
      'git@github.com:SrKain/Notes.git');
    assert.throws(() => validateRemote('git@github.com:SrKain/Notes.git',true),/HTTPS/);
    assert.throws(() => validateRemote('https://someone:secret@github.com/SrKain/Notes.git',true),/credentials/);
    assert.throws(() => validateRemote('https://github.com/SrKain/Notes.git?token=secret',true),/query/);
    assert.throws(() => validateRemote('https://evil.example.com/SrKain/Notes.git',true),/GitHub/);
    assert.throws(() => validateRemote('http://github.com/SrKain/Notes',true),/GitHub HTTPS/);
    assert.equal(sameRemote('git@github.com:SrKain/Notes.git','https://github.com/srkain/notes'),true);
    assert.equal(sameRemote('https://github.com/A/notes','https://github.com/B/notes'),false);
    assert.equal(classifySyncError(new Error('connect ECONNRESET')), 'network');
    assert.equal(classifySyncError(new Error('HTTP 401 Invalid credentials')), 'auth');
    assert.equal(classifySyncError(new Error('403 permission denied')), 'permission');
    assert.equal(classifySyncError(new Error('Merge conflict')), 'conflict');
    const conflict = new (require(compiled).SyncConflictError)(['note.md']);
    assert.equal(classifySyncError(conflict), 'conflict');
    assert.deepEqual(conflict.files, ['note.md']);

    const leaked = publicErrorMessage(new Error('unknown: github_pat_dont_echo_private_123'));
    assert(!leaked.includes('github_pat_'), 'never forward unsafe raw error data');

    let tries=0;
    const sleeps=[];
    const value=await retryRead(async () => {
      tries++;
      if(tries<3)throw new Error('connect ECONNRESET');
      return 23;
    }, ms=>{sleeps.push(ms);return Promise.resolve()});
    assert.equal(value,23);
    assert.equal(tries,3);
    assert.deepEqual(sleeps,[500,1000]);

    tries=0;
    await assert.rejects(()=>retryRead(async()=>{
      tries++;
      throw new Error('401 Invalid credentials');
    },()=>Promise.resolve()),/credentials/);
    assert.equal(tries,1,'authentication failures are not retried');
    console.log('Sync safety and retry tests passed');
  } finally {
    await fsp.rm(temp, {recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1});
