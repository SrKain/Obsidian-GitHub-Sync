/* WebView emulation using the production mobile bundle, local Git HTTP
 * remote and no Node globals. No real vault or credentials are accessed.
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
const {pathToFileURL} = require('node:url');
const nodeBuffer = globalThis.Buffer;
const nodeProcess = globalThis.process;
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
    async writeBinary(p,d){return fsp.writeFile(abs(p),nodeBuffer.from(d));},
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
      const body=nodeBuffer.concat(chunks);
      const uri=new URL(req.url,'http://localhost');
      const env={
        ...nodeProcess.env,GIT_PROJECT_ROOT:remoteRoot,GIT_HTTP_EXPORT_ALL:'1',
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
      if(status!==0){res.writeHead(500);res.end(nodeBuffer.concat(chunksErr));return;}
      const buf=nodeBuffer.concat(chunksOut);
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
const nodeBufferModule=sourceLoad.call(Module,'buffer',module,false);
let bufferMode='real';
let bufferRequests=0;
let interceptBuffer=false;
let port=0;
Module._load=function(id,parent,isMain){
  if(id==='buffer' && interceptBuffer) {
    bufferRequests++;
    if (bufferMode==='undefined') return undefined;
    if (bufferMode==='empty') return {};
    if (bufferMode==='throws') throw new Error("Unexpected require('buffer') in the WebView bundle");
    return nodeBufferModule;
  }
  if(id==='obsidian')return{
    TFile,TFolder,
    normalizePath(x){return (x||'').replace(/\\/g,'/').split('/').filter(Boolean).join('/')||'/';},
    async requestUrl({url,method='GET',headers={},body,throw:throwOnError=true}){
      // Node's fetch and git http-backend require the real Node globals.
      // The mobile bundle itself runs without them.
      const oldBuffer=globalThis.Buffer;
      const oldProcess=globalThis.process;
      const oldIntercept=interceptBuffer;
      globalThis.Buffer=nodeBuffer;
      globalThis.process=nodeProcess;
      interceptBuffer=false;
      try {
        const target=url.replace(/^https:\/\/github.com/i,'http://127.0.0.1:'+port);
        const res=await fetch(target,{method,headers,body:body?nodeBuffer.from(body):undefined,redirect:'follow'});
        const arrayBuffer=await res.arrayBuffer();
        if(throwOnError && !res.ok)throw new Error('HTTP '+res.status);
        return {status:res.status,headers:Object.fromEntries(res.headers.entries()),arrayBuffer};
      } finally {
        globalThis.Buffer=oldBuffer;
        globalThis.process=oldProcess;
        interceptBuffer=oldIntercept;
      }
    }
  };
  return sourceLoad.call(this,id,parent,isMain);
};

(async()=>{
  const server=gitServer();
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    port=server.address().port;
    const {mobileSafeBuildOptions}=await import(pathToFileURL(path.resolve('esbuild.shared.mjs')).href);
    const output=path.join(temp,'MobileSync.cjs');
    await esbuild.build({
      ...mobileSafeBuildOptions,
      entryPoints:['src/mobile/MobileSync.ts'],
      outfile:output
    });
    const compiled=fs.readFileSync(output,'utf8');
    assert(!compiled.includes('require("buffer")'),'WebView bundle must not require Node buffer');

    const settings={
      remoteURL:'https://github.com/example/notes.git',
      mobileTokenKey:'',mobileAuthorName:'Mobile Test',mobileAuthorEmail:'mobile@example.com'
    };
    for(const mode of ['real','undefined','empty','throws']) {
      initBare();
      bufferMode=mode;
      bufferRequests=0;
      const root=path.join(temp,'mobile-'+mode);
      fs.mkdirSync(path.join(root,'.obsidian'),{recursive:true});
      const beforeBuffer=globalThis.Buffer;
      const beforeProcess=globalThis.process;
      try {
        globalThis.Buffer=undefined;
        globalThis.process=undefined;
        interceptBuffer=true;
        delete require.cache[require.resolve(output)];
        const {MobileSync}=require(output);
        assert(globalThis.Buffer && typeof globalThis.Buffer.from==='function','MobileSync initializes browser Buffer');
        const mobile=new MobileSync({
          vault:makeVault(root),
          secretStorage:{getSecret:()=>null},
        },()=>settings);
        await mobile.verifyConnection();
        await mobile.sync(); // first sync: no notes, no remote commit
        assert.equal(fs.existsSync(path.join(root,'.git')),true);
        fs.writeFileSync(path.join(root,'notes.md'),'Created in WebView mode '+mode+'\\n');
        await mobile.sync(); // second sync: initial commit and main push
      } finally {
        interceptBuffer=false;
        globalThis.Buffer=beforeBuffer;
        globalThis.process=beforeProcess;
      }
      assert.equal(bufferRequests,0,'No require("buffer") with mode '+mode);
      assert.equal(run('--git-dir',bare,'show','main:notes.md'),'Created in WebView mode '+mode+'\\n');
    }
    console.log('Mobile production-config WebView emulation passed (4 buffer modes)');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    Module._load=sourceLoad;
    await fsp.rm(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
