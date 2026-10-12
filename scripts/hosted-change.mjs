// The existing change controller owns source formation and test semantics. This
// adapter owns the hosted process boundary; no candidate code runs in preparation.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,realpathSync,readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const SHA=/^[a-f0-9]{40}$/u, DIGEST=/^[a-f0-9]{64}$/u;
const closedEnvironment=()=>({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'file'});
export function admitSourceController(helper,commit){
  if(!SHA.test(commit))throw new Error('reviewed immutable source controller required');
  const allowed=JSON.parse(readFileSync(join(helper,'reviewed-source-controllers.json'),'utf8'));
  if(allowed.kind!=='guix.reviewed-source-controllers.v1'||!Array.isArray(allowed.commits)||!allowed.commits.includes(commit))
    throw new Error('source controller is not reviewed by this immutable delivery helper');
  return commit;
}
export function runtimeBinding(helper,commit){
  if(!SHA.test(commit))throw new Error('reviewed controller commit required');
  const file=join(helper,'runtime-bindings',commit+'.json');
  if(!existsSync(file))throw new Error('hosted runtime not admitted: reviewed delivery helper has no runtime binding for this controller');
  const binding=JSON.parse(readFileSync(file,'utf8'));
  if(binding.kind!=='guix.hosted-runtime.v1'||binding.controllerCommit!==commit||binding.sourceContract!=='guix.change-source-carriers.v1'
    ||!/^ghcr\.io\/red-cup-engineering\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(binding.image)
    ||!DIGEST.test(binding.qualificationSha256)||!Number.isSafeInteger(binding.uid)||binding.uid<1||!Number.isSafeInteger(binding.gid)||binding.gid<1)
    throw new Error('hosted runtime admission must bind controller, immutable owner image, qualification and non-root identity');
  return binding;
}
function directory(value){const path=realpathSync(value);if(!lstatSync(path).isDirectory()||path.includes(','))throw new Error('invalid hosted mount directory');return path;}
function invoke(program,args,options,execute=spawnSync){
  const result=execute(program,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:120*60*1000,...options});
  if(result.error||result.signal)throw result.error??new Error(`hosted command terminated: ${result.signal}`);
  if(result.status!==0)throw new Error(`hosted command failed (${result.status}): ${String(result.stderr).slice(-4000)}`);
  return result.stdout;
}
export function containerCommand({controller,carriers,output,helper,commit,digest,binding}){
  if(!SHA.test(commit)||!DIGEST.test(digest))throw new Error('independently retained controller and source identities required');
  const paths=[controller,carriers,output,helper].map(directory);
  if(new Set(paths).size!==4||paths.some((a,i)=>paths.some((b,j)=>i!==j&&(a.startsWith(b+'/')||b.startsWith(a+'/')))))throw new Error('hosted mounts must be separate custody roots');
  return ['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--user',`${binding.uid}:${binding.gid}`,'--pids-limit=256','--memory=4g','--memory-swap=4g','--cpus=2',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=256m','--workdir=/result','--env','HOME=/tmp','--env','LANG=C.UTF-8',
    ...paths.flatMap((path,index)=>['--mount',`type=bind,src=${path},dst=${['/controller','/carriers','/result','/helper'][index]}${index===2?'':',readonly'}`]),
    '--entrypoint','node',binding.image,'/helper/hosted-change.mjs','--worker',digest];
}
export function checkControllerConfig(text){
  const allowed={
    'core.repositoryformatversion':['0'],'core.filemode':['true'],'core.bare':['false'],'core.logallrefupdates':['true'],
    'remote.origin.url':['https://github.com/red-cup-engineering/guix-machine-release-service.git'],
    'remote.origin.fetch':['+refs/heads/*:refs/remotes/origin/*']};
  for(const row of text.split('\0').filter(Boolean)){
    const at=row.indexOf('\n'),key=row.slice(0,at),value=row.slice(at+1);
    if(at<0||!allowed[key]?.includes(value))throw new Error('controller checkout carries unadmitted local Git configuration');
  }
}
export function runHosted({controller,carriers,output,helper,commit,digest,execute=spawnSync}){
  controller=directory(controller);
  // Refuse before creating a container or running any unadmitted image. The image
  // must already be present; this adapter neither provisions nor pulls capacity.
  const binding=runtimeBinding(helper,commit);
  if(binding.uid!==process.getuid?.()||binding.gid!==process.getgid?.())throw new Error('admitted non-root runtime identity differs from runner output custody');
  const head=invoke('git',['-C',controller,'rev-parse','HEAD'],{env:closedEnvironment()},execute).trim();
  if(head!==commit)throw new Error('hosted controller differs from reviewed commit');
  checkControllerConfig(invoke('git',['-C',controller,'config','--null','--list','--local'],{env:closedEnvironment()},execute));
  if(invoke('git',['-C',controller,'status','--porcelain','--untracked-files=all'],{env:closedEnvironment()},execute).trim())throw new Error('hosted controller checkout differs from reviewed source');
  if(existsSync(output))throw new Error('hosted comparison requires fresh output custody');
  mkdirSync(output,{recursive:true});
  const args=containerCommand({controller,carriers,output,helper,commit,digest,binding});
  const name='change-test-'+randomUUID();args.splice(1,0,'--name',name);
  let result;
  try{result=execute('docker',args,{encoding:'utf8',env:closedEnvironment(),timeout:120*60*1000,maxBuffer:64*1024*1024});}
  finally{execute('docker',['rm','--force',name],{encoding:'utf8',env:closedEnvironment(),timeout:30000,maxBuffer:1024*1024});}
  // Docker enforces PID/memory/CPU/network boundaries. GitHub's job timeout owns
  // orphan cleanup if the engine hangs; no token or Docker socket is mounted.
  if(result.error||result.signal)throw result.error??new Error(`hosted worker terminated: ${result.signal}`);
  if(!Number.isInteger(result.status))throw new Error('hosted worker returned no exit status');
  return result;
}
export async function worker({controller='/controller',carriers='/carriers',output='/result',digest,execute=spawnSync}={}){
  if(!DIGEST.test(digest))throw new Error('independently retained source digest required');
  const {prepareExportedComparison,verifyChangeSources}=await import(pathToFileURL(join(controller,'scripts/materialize-sources.mjs')));
  const receipt=verifyChangeSources(carriers,digest);
  const inputs=prepareExportedComparison(carriers,digest,join(output,'comparison'));
  const args=[join(controller,'scripts/test-change.mjs'),inputs.snapshot,join(output,'work'),
    `--local-sources=${join(output,'comparison/local-sources.json')}`,
    ...inputs.changes.map(change=>`${change.repository}=${change.directory}`)];
  const result=execute(process.execPath,args,{env:closedEnvironment(),encoding:'utf8',timeout:115*60*1000,maxBuffer:64*1024*1024});
  writeFileSync(join(output,'test-change.log'),String(result.stderr??''));
  if(result.error||result.signal)throw result.error??new Error(`change comparison terminated: ${result.signal}`);
  let verdict;try{verdict=JSON.parse(result.stdout);}catch{throw new Error('change controller produced no complete verdict');}
  const expected=inputs.changes.map(({repository,commit})=>({repository,commit}));
  if(verdict.kind!=='change-test'||verdict.snapshot!==receipt.snapshot.commit||!Array.isArray(verdict.changes)
    ||JSON.stringify(verdict.changes.map(({repository,commit})=>({repository,commit})))!==JSON.stringify(expected))throw new Error('change verdict differs from prepared source identities');
  verifyChangeSources(carriers,digest);
  writeFileSync(join(output,'verdict.json'),JSON.stringify(verdict)+'\n');
  writeFileSync(join(output,'source-receipt.json'),JSON.stringify({sourceSha256:digest,snapshot:receipt.snapshot,changes:expected,comparisonPassed:verdict.verdict==='no-regression'&&result.status===0,deployedRuntimeAcceptance:false})+'\n');
  return {status:result.status===0&&verdict.verdict==='no-regression'?0:1,verdict};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{
    const [mode,...args]=process.argv.slice(2);
    if(mode==='--admit-source-controller'&&args.length===1){admitSourceController(new URL('.',import.meta.url).pathname,args[0]);}
    else if(mode==='--worker'&&args.length===1){const result=await worker({digest:args[0]});process.stdout.write(JSON.stringify(result.verdict)+'\n');process.exitCode=result.status;}
    else if(mode==='--run'&&args.length===7){const [controller,carriers,output,helper,commit,digest,preparation]=args;
      const supplied=JSON.parse(readFileSync(preparation,'utf8'));if(supplied.sha256!==digest)throw new Error('source digest differs from retained preparation result');
      const result=runHosted({controller,carriers,output,helper,commit,digest});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exitCode=result.status;
    }else throw new Error('usage: hosted-change.mjs --run CONTROLLER CARRIERS OUTPUT HELPER CONTROLLER_COMMIT SOURCE_SHA256 PREPARATION_JSON');
  }catch(error){console.error(`hosted-change: ${error.message}`);process.exitCode=1;}
}
