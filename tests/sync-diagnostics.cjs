const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'ghsync-diagnostics-'));
  try {
    const compiled=path.join(temp,'diagnostics.cjs');
    await esbuild.build({
      entryPoints:['src/core/SyncDiagnostics.ts'],bundle:true,platform:'node',
      format:'cjs',target:'es2018',outfile:compiled
    });
    const {captureSyncError,formatLastSyncError}=require(compiled);
    const error=new Error('Request to https://user:password@github.com/owner/private?token=secret failed; '+
      'Bearer abc123 ghp_sensitive github_pat_private token=unmasked access_token=secret');
    error.name='TypeError';
    error.stack='TypeError: secret\n'+[
      '    at StreamReader (/home/user/workspace/node_modules/isomorphic-git/main.js:21:44)',
      '    at MobileSync.sync (file:///data/user/0/obsidian/plugins/main.js:145:22)',
      '    at unsafeName (https://host.example.com/path/main.js:5:77)',
      '    at another (/private/path/git.js:73:9)',
      '    at git (/srv/project/app.js:99:2)',
      '    at sixth (/srv/project/other.js:500:2)'
    ].join('\n');
    const captured=captureSyncError(error);
    const report=formatLastSyncError(captured);
    assert.equal(captured.name,'TypeError');
    assert.equal(captured.frames.length,5);
    assert.match(report,/StreamReader \(main.js:21\)/);
    assert.match(report,/MobileSync.sync \(main.js:145\)/);
    for (const secret of ['https://','github.com','ghp_sensitive','github_pat_private',
      'Bearer abc123','token=unmasked','access_token=secret','/home/','/data/','/srv/','/private/','sixth']) {
      assert(!report.includes(secret), 'must not leak '+secret);
    }
    assert(captured.message.length<=300);
    const invalid=new Error('github_pat_leak');
    invalid.name='HttpError token=secret';
    const sanitized=captureSyncError(invalid);
    assert.equal(sanitized.name,'Error');
    assert(!formatLastSyncError(sanitized).includes('github_pat_'));
    assert.equal(formatLastSyncError(null),'');
    const tampered=formatLastSyncError({
      at:'malicious',name:'token=secret',message:'Bearer verysecret https://foo.bar',
      frames:['sensitive (/users/private/path.js:33)','clean (main.js:23)']
    });
    assert(!tampered.includes('verysecret') && !tampered.includes('foo.bar'));
    assert(!tampered.includes('/users/private/'));
    assert.match(tampered,/clean \(main.js:23\)/);
    console.log('Sync diagnostics redaction and frame tests passed');
  }finally{
    await fsp.rm(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
