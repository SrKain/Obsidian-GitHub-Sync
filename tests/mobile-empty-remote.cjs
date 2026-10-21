/* Empty Git remote and stuck bootstrap regression test with local Git HTTP backend.
 * No user vault and no GitHub credentials are used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-mobile-e2e-'));
const remoteRoot = path.join(temp, 'remote');
const bare = path.join(remoteRoot, 'example', 'notes.git');
const desktop = path.join(temp, 'desktop');
const mobileDir = path.join(temp, 'mobile');
fs.mkdirSync(path.dirname(bare), {recursive:true});
fs.mkdirSync(mobileDir, {recursive:true});
fs.mkdirSync(path.join(mobileDir,'.obsidian'), {recursive:true});
const run=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
function initBare() {
  fs.rmSync(bare, {recursive:true, force:true});
  run('init','--bare',bare);
  run('--git-dir',bare,'symbolic-ref','HEAD','refs/heads/main');
  run('--git-dir',bare,'config','http.receivepack','true');
}
initBare();

function fromRoot(root,input) {
  const relative=(input||'').replace(/^\/+/,'');
  const value=path.resolve(root,relative);
  assert(value===root || value.startsWith(root+path.sep), 'path stays in vault');
  return value;
}
function makeVault(root) {
  const abs=(p)=>fromRoot(root,p);
  const rel=(p)=>path.relative(root,p).replace(/\\/g,'/');
  const adapter={
    async exists(p) {try {await fsp.access(abs(p));return true;}catch{return false;}},
    async stat(p){try {const s=await fsp.stat(abs(p));return {type:s.isDirectory()?'folder':'file',size:s.size,ctime:s.ctimeMs,mtime:s.mtimeMs};}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    async read(p){return fsp.readFile(abs(p),'utf8');},
    async readBinary(p){const b=await fsp.readFile(abs(p));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},
    async write(p,d){return fsp.writeFile(abs(p),d);},
    async writeBinary(p,d){return fsp.writeFile(abs(p),Buffer.from(d));},
    async mkdir(p){return fsp.mkdir(abs(p));},
    async list(p){const x=await fsp.readdir(abs(p),{withFileTypes:true});return {files:x.filter(e=>e.isFile()).map(e=>rel(path.join(abs(p),e.name))),folders:x.filter(e=>e.isDirectory()).map(e=>rel(path.join(abs(p),e.name)))};},
    async rmdir(p,recursive=false){return fsp.rm(abs(p),{recursive});},
    async remove(p){return fsp.unlink(abs(p));}
  };
  return {
    adapter,configDir:'.obsidian',
    getAbstractFileByPath:()=>null, getFolderByPath:()=>null,
    async create(p,d){return adapter.write(p,d);},
    async createBinary(p,d){return adapter.writeBinary(p,d);},
    async createFolder(p){return adapter.mkdir(p);},
    getFiles() {
      const walk=(dir)=>{
        return fs.readdirSync(abs(dir),{withFileTypes:true}).flatMap(item=>{
          const p=(dir?dir+'/':'')+item.name;
          if (p==='.git')return [];
          return item.isDirectory()?walk(p):[{path:p}];
        });
      };
      return walk('');
    }
  };
}

function gitServer(){
  return http.createServer(async(req,res)=>{
    try {
      const chunks=[];
      for await (const chunk of req) chunks.push(chunk);
      const body=Buffer.concat(chunks);
      const uri=new URL(req.url,'http://localhost');
      const env={
        ...process.env,GIT_PROJECT_ROOT:remoteRoot,GIT_HTTP_EXPORT_ALL:'1',
        PATH_INFO:uri.pathname,QUERY_STRING:uri.search.slice(1),
        REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',
        CONTENT_LENGTH:String(body.length),REMOTE_USER:'',REMOTE_ADDR:'127.0.0.1',
      };
      const proc=spawn('git',['http-backend'],{env,stdio:['pipe','pipe','pipe']});
      proc.stdin.end(body);
      const chunksOut=[];
      const chunksErr=[];
      proc.stdout.on('data',x=>chunksOut.push(x));
      proc.stderr.on('data',x=>chunksErr.push(x));
      const status=await new Promise((resolve,reject)=>{
        proc.once('error',reject);
        proc.once('close',resolve);
      });
      if(status!==0){res.writeHead(500);res.end(Buffer.concat(chunksErr));return;}
      const buf=Buffer.concat(chunksOut);
      const index=buf.indexOf('\r\n\r\n')>=0?buf.indexOf('\r\n\r\n'):buf.indexOf('\n\n');
      const width=buf.indexOf('\r\n\r\n')>=0?4:2;
      if(index<0){res.writeHead(500);res.end(buf);return;}
      const raw=buf.subarray(0,index).toString('utf8');
      const headers={};let code=200;
      for(const line of raw.split(/\r?\n/)){
        const sep=line.indexOf(':');if(sep<0)continue;
        const key=line.slice(0,sep).trim().toLowerCase();
        const value=line.slice(sep+1).trim();
        if(key==='status')code=Number(value.slice(0,3));
        else headers[key]=value;
      }
      res.writeHead(code,headers);res.end(buf.subarray(index+width));
    } catch(e){res.writeHead(500);res.end(String(e));}
  });
}
class TFile{}
class TFolder{}
const sourceLoad=Module._load;
let port=0;
Module._load=function(id,parent,isMain){
  if(id==='obsidian')return{
    TFile,TFolder,
    normalizePath(x){return (x||'').replace(/\\/g,'/').split('/').filter(Boolean).join('/')||'/';},
    async requestUrl({url,method='GET',headers={},body,throw:throwOnError=true}){
      const target=url.replace(/^https:\/\/github.com/i,'http://127.0.0.1:'+port);
      const res=await fetch(target,{method,headers,body:body?Buffer.from(body):undefined,redirect:'follow'});
      const arrayBuffer=await res.arrayBuffer();
      if(throwOnError && !res.ok)throw new Error('HTTP '+res.status);
      return {status:res.status,headers:Object.fromEntries(res.headers.entries()),arrayBuffer};
    }
  };
  return sourceLoad.call(this,id,parent,isMain);
};

(async()=>{
  const server=gitServer();
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    port=server.address().port;
    const output=path.join(temp,'MobileSync.cjs');
    await esbuild.build({entryPoints:['src/mobile/MobileSync.ts'],bundle:true,platform:'node',format:'cjs',target:'es2020',external:['obsidian'],outfile:output});
    const {MobileSync}=require(output);
    const settings={
      remoteURL:'https://github.com/example/notes.git',
      mobileTokenKey:'',mobileAuthorName:'Mobile Test',mobileAuthorEmail:'mobile@example.com'
    };
    const createMobile=(root)=>{
      fs.mkdirSync(path.join(root,'.obsidian'),{recursive:true});
      return new MobileSync({vault:makeVault(root),secretStorage:{getSecret:()=>null}},()=>settings);
    };
    const hasMain=()=>{
      try {run('--git-dir',bare,'rev-parse','--verify','refs/heads/main');return true;}
      catch {return false;}
    };

    // (a) An empty vault and empty remote have nothing to upload.
    const mobile=createMobile(mobileDir);
    await mobile.verifyConnection();
    await mobile.sync();
    assert.equal(hasMain(),false,'empty sync does not create main');
    assert.equal(fs.existsSync(path.join(mobileDir,'.git/github-sync-bootstrap')),false);
    assert.equal(fs.readFileSync(path.join(mobileDir,'.git/HEAD'),'utf8').trim(),'ref: refs/heads/main');

    // (e) Startup remote check is safe on an unborn main.
    assert.equal(await mobile.checkRemote(),false);

    // (b) A later note causes the first commit and push.
    fs.writeFileSync(path.join(mobileDir,'notes.md'),'Created on tablet\\n');
    await mobile.sync();
    assert.equal(hasMain(),true,'first note creates main on remote');
    assert.equal(run('--git-dir',bare,'show','main:notes.md'),'Created on tablet\\n');

    // (c) Reproduce the older noCheckout + pending marker bootstrap.
    initBare();
    const stuckDir=path.join(temp,'stuck');
    fs.mkdirSync(stuckDir,{recursive:true});
    const gitIso=require('isomorphic-git');
    const gitHttp=require('isomorphic-git/http/node');
    await gitIso.clone({
      fs,http:gitHttp,dir:stuckDir,
      url:'http://127.0.0.1:'+port+'/example/notes.git',
      ref:'main',singleBranch:true,noCheckout:true,
    });
    git(stuckDir,'remote','set-url','origin','https://github.com/example/notes.git');
    assert.equal(fs.readFileSync(path.join(stuckDir,'.git/HEAD'),'utf8').trim(),'ref: refs/heads/main');
    fs.writeFileSync(path.join(stuckDir,'.git/github-sync-bootstrap'),'pending');
    fs.writeFileSync(path.join(stuckDir,'kept.md'),'Keep this local note\\n');
    const stuck=createMobile(stuckDir);
    await stuck.sync();
    assert.equal(fs.existsSync(path.join(stuckDir,'.git')),true,'git metadata preserved');
    assert.equal(fs.existsSync(path.join(stuckDir,'.git/github-sync-bootstrap')),false,'pending marker removed');
    assert.equal(fs.readFileSync(path.join(stuckDir,'kept.md'),'utf8'),'Keep this local note\\n');
    assert.equal(run('--git-dir',bare,'show','main:kept.md'),'Keep this local note\\n');

    // (d) An existing master-only remote must not be overwritten or cloned.
    initBare();
    const masterDir=path.join(temp,'master-desktop');
    run('clone',bare,masterDir);
    git(masterDir,'config','user.name','Master Test');
    git(masterDir,'config','user.email','master@example.com');
    fs.writeFileSync(path.join(masterDir,'master.md'),'Existing master\\n');
    git(masterDir,'add','.');
    git(masterDir,'commit','-m','master first');
    git(masterDir,'branch','-M','master');
    git(masterDir,'push','origin','master');
    run('--git-dir',bare,'symbolic-ref','HEAD','refs/heads/master');
    const otherDir=path.join(temp,'other-mobile');
    const other=createMobile(otherDir);
    await assert.rejects(()=>other.sync(),error=>{
      assert.match(error.message,/remote repository has no main branch/i);
      return true;
    });
    assert.equal(fs.existsSync(path.join(otherDir,'.git')),false,'wrong branch does not initialize vault');
    assert.equal(fs.existsSync(path.join(otherDir,'.obsidian')),true,'existing vault data preserved');
    assert.equal(run('--git-dir',bare,'show','master:master.md'),'Existing master\\n');
    assert.equal(hasMain(),false);

    // (f) Only a sanitized error name reaches the public fallback.
    const compiledSafety=path.join(temp,'SyncSafety.cjs');
    await esbuild.build({entryPoints:['src/core/SyncSafety.ts'],bundle:true,platform:'node',format:'cjs',outfile:compiledSafety});
    const {publicErrorMessage,classifySyncError}=require(compiledSafety);
    const error=new Error('Could not find https://github.com/example/repo?token=github_pat_sensitive');
    error.name='NotFoundError';
    assert.equal(classifySyncError(error),'unknown');
    const notice=publicErrorMessage(error);
    assert.match(notice,/NotFoundError/);
    assert(!notice.includes('Could not find') && !notice.includes('https://') && !notice.includes('github_pat_'));
    console.log('Mobile empty-remote, recovery and branch-safety tests passed');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    Module._load=sourceLoad;
    await fsp.rm(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
