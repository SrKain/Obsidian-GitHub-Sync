/* Actual desktop Git integration test; no user files or external network.
 * Local bare repository stands in for GitHub.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const esbuild = require('esbuild');
const simpleGit = require('simple-git').simpleGit;
const run=(...args)=>execFileSync('git',args,{encoding:'utf8'});
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'});
(async()=>{
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'ghsync-desktop-'));
  try{
    const bare=path.join(temp,'remote.git');
    const seed=path.join(temp,'seed');
    const vault=path.join(temp,'vault');
    run('init','--bare',bare);
    run('clone',bare,seed);
    git(seed,'config','user.name','Desktop Test');
    git(seed,'config','user.email','test@example.com');
    await fsp.writeFile(path.join(seed,'note.md'),'from remote\n');
    git(seed,'add','.');git(seed,'commit','-m','initial');
    git(seed,'branch','-M','main');git(seed,'push','-u','origin','main');
    run('--git-dir',bare,'symbolic-ref','HEAD','refs/heads/main');
    run('clone',bare,vault);
    git(vault,'config','user.name','Desktop Test');
    git(vault,'config','user.email','test@example.com');
    const target=path.join(temp,'DesktopSync.cjs');
    await esbuild.build({
      entryPoints:['src/desktop/DesktopSync.ts'],outfile:target,bundle:true,
      platform:'node',format:'cjs',target:'es2020',
    });
    const {runDesktopSync}=require(target);
    const client=simpleGit(vault);
    const secretPath='.obsidian/plugins/github-sync/data.json';
    await fsp.mkdir(path.join(vault,'.obsidian','plugins','github-sync'),{recursive:true});
    await fsp.writeFile(path.join(vault,secretPath),'{"mobileTokenKey":"test-secret-id"}\n');
    await fsp.writeFile(path.join(vault,'note.md'),'from desktop\n');
    await runDesktopSync(client,bare);
    assert.equal(git(vault,'ls-files','--',secretPath).trim(),'','do not commit private config');
    assert.equal(run('--git-dir',bare,'show','main:note.md'),'from desktop\n','push note update');

    // Locally ignore the sensitive settings for a clean-worktree scenario.
    await fsp.appendFile(path.join(vault,'.git','info','exclude'),'\n/.obsidian/plugins/github-sync/data.json\n');
    // A clean worktree may still contain commits that need pushing.
    await fsp.writeFile(path.join(vault,'another.md'),'pending committed note\n');
    git(vault,'add','another.md');git(vault,'commit','-m','local pending');
    assert.equal((await client.status()).isClean(),true);
    await runDesktopSync(client,bare);
    assert.equal(run('--git-dir',bare,'show','main:another.md'),'pending committed note\n');

    // Never redirect a vault, even when an edit exists.
    await assert.rejects(()=>runDesktopSync(client,path.join(temp,'wrong.git')),/differs/);
    assert.equal(git(vault,'remote','get-url','origin').trim(),bare);

    // Old tracked plugin config is a hard stop.
    git(vault,'add','-f','--',secretPath);
    git(vault,'commit','-m','accidental sensitive config');
    await assert.rejects(()=>runDesktopSync(client,bare),/tracking plugin settings/);
    assert.notEqual(run('--git-dir',bare,'rev-parse','main'),git(vault,'rev-parse','HEAD'));

    // Conflicting edits must not be pushed; the local revision stays in Git.
    git(vault,'rm','--cached','--',secretPath);
    git(vault,'commit','-m','untrack plugin settings');
    await runDesktopSync(client,bare);
    git(seed,'pull','--ff-only','origin','main');
    await fsp.writeFile(path.join(seed,'note.md'),'competing remote edit\n');
    git(seed,'add','note.md');git(seed,'commit','-m','concurrent desktop edit');
    git(seed,'push','origin','main');
    await fsp.writeFile(path.join(vault,'note.md'),'my conflicting local edit\n');
    await assert.rejects(() => runDesktopSync(client,bare),error => {
      assert.equal(error.name,'SyncConflictError');
      assert(error.files.includes('note.md'));
      return true;
    });
    assert.equal(git(vault,'show','HEAD:note.md'),'my conflicting local edit\n');
    assert.equal(run('--git-dir',bare,'show','main:note.md'),'competing remote edit\n');
    console.log('Desktop end-to-end Git regression test passed');
  }finally{
    await fsp.rm(temp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1});
