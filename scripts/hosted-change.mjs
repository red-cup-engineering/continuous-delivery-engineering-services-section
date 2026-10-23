// The existing change controller owns source formation and test semantics. This
// adapter owns the hosted process boundary; no candidate code runs in preparation.
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,realpathSync,readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {SOURCE_CONTRACT,sourceExpectation,validateExpectation,verdictSourceError,receivingError} from './change-source-evidence.mjs';

const SHA=/^[a-f0-9]{40}(?![\s\S])/u, DIGEST=/^[a-f0-9]{64}(?![\s\S])/u;
const closedEnvironment=()=>({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:'file'});
/** 
 * Source-owned controller roster is a bounded immutable Git-object declaration.
 * Revision v3 names the actual SHA-1 Git blob object; earlier retained v2
 * helper snapshots are readable but cannot manufacture v3 source authority.
 * Git commit, tree and blob OIDs are source identities, not Work or grant receipts.
 */
export function admitSourceController(helper,commit){
  const refused=()=>{throw new Error('source controller is not reviewed by this immutable delivery helper');};
  if(!SHA.test(commit))refused();
  const file=join(helper,'reviewed-source-controllers.json');
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>8192)refused();
  const allowed=JSON.parse(readFileSync(file,'utf8'));
  const exactKeys=(item,fields)=>item!==null&&typeof item==='object'&&!Array.isArray(item)
    &&Object.keys(item).length===fields.length&&fields.every(key=>Object.hasOwn(item,key));
  if(!exactKeys(allowed,['kind','controllers'])||
    !['guix.reviewed-source-controllers.v2','guix.reviewed-source-controllers.v3'].includes(allowed.kind)||
    !Array.isArray(allowed.controllers)||allowed.controllers.length<1||allowed.controllers.length>64)refused();
  const legacy=allowed.kind==='guix.reviewed-source-controllers.v2';
  const fields=legacy?['commit','tree','verifierBlob']:['commit','tree','sourceVerifierGitBlobSha1'];
  const seen=new Set();
  let selected=null;
  for(const row of allowed.controllers){
    const verifier=legacy?row?.verifierBlob:row?.sourceVerifierGitBlobSha1;
    if(!exactKeys(row,fields)||!SHA.test(row.commit)||!SHA.test(row.tree)||
      !SHA.test(verifier)||seen.has(row.commit))refused();
    seen.add(row.commit);
    if(row.commit===commit)selected=Object.freeze({
      commit:row.commit,tree:row.tree,sourceVerifierGitBlobSha1:verifier,
    });
  }
  if(!selected)refused();
  return selected;
}
export async function verifyController(controller,helper,commit,execute=spawnSync){
  const entry=admitSourceController(helper,commit);controller=directory(controller);
  const env=closedEnvironment();
  checkControllerConfig(invoke('git',['-C',controller,'config','--null','--list','--local'],{env},execute));
  // No selected module is imported until this complete blob matches the helper's
  // independently reviewed immutable owner identity. The exact bytes are then
  // imported without resolving any unchecked checkout dependencies.
  const file=join(controller,'scripts/verify-release-source.mjs'),stat=lstatSync(file),bytes=readFileSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(file)!==file
    ||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==entry.sourceVerifierGitBlobSha1)
    throw new Error('trusted controller verifier bytes differ');
  const {verifyCommittedSource}=await import('data:text/javascript;base64,'+bytes.toString('base64'));
  const gitExecutable=invoke('which',['git'],{env},execute).trim();
  invoke(gitExecutable,['-C',controller,'fsck','--strict','--no-reflogs'],{env},execute);
  verifyCommittedSource({directory:controller,commit,tree:entry.tree,gitExecutable},
    {readFileSync,readdirSync,lstatSync,realpathSync,resolve,join,spawnSync:execute,createHash,environmentPath:env.PATH});
  return entry;
}
export async function prepareExpectation({controller,helper,commit,carriers,preparation,machine,machineCommit,repository,head,output}){
  await verifyController(controller,helper,commit);
  const supplied=JSON.parse(readFileSync(preparation,'utf8'));
  if(supplied.kind!==SOURCE_CONTRACT||!DIGEST.test(supplied.sha256))throw new Error('complete v2 preparation result required');
  const {verifyChangeSources}=await import(pathToFileURL(join(controller,'scripts/materialize-sources.mjs')));
  const receipt=verifyChangeSources(carriers,supplied.sha256);
  const expected=sourceExpectation(receipt,supplied.sha256,{machine,machineCommit,repository,commit:head,controllerCommit:commit});
  if(existsSync(output))throw new Error('preparation expectation requires fresh custody');
  const destination=resolve(output);
  for(const source of [controller,helper,carriers].map(directory))if(destination===source||destination.startsWith(source+'/')||source.startsWith(destination+'/'))
    throw new Error('preparation expectation must be outside source custody');
  mkdirSync(destination,{recursive:true});if(realpathSync(destination)!==destination)throw new Error('preparation expectation is redirected');
  writeFileSync(join(destination,'expectation.json'),JSON.stringify(expected)+'\n',{flag:'wx'});
  return expected;
}
export function runtimeBinding(helper,commit){
  if(!SHA.test(commit))throw new Error('reviewed controller commit required');
  const file=join(helper,'runtime-bindings',commit+'.json');
  if(!existsSync(file))throw new Error('hosted runtime not admitted: reviewed delivery helper has no runtime binding for this controller');
  const binding=JSON.parse(readFileSync(file,'utf8'));
  if(binding.kind!=='guix.hosted-runtime.v1'||binding.controllerCommit!==commit||binding.sourceContract!==SOURCE_CONTRACT
    ||!/^ghcr\.io\/red-cup-engineering\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}(?![\s\S])/u.test(binding.image)
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
export function containerCommand({controller,carriers,output,helper,preparation,commit,digest,binding}){
  if(!SHA.test(commit)||!DIGEST.test(digest))throw new Error('independently retained controller and source identities required');
  const paths=[controller,carriers,output,helper,preparation].map(directory);
  if(new Set(paths).size!==5||paths.some((a,i)=>paths.some((b,j)=>i!==j&&(a.startsWith(b+'/')||b.startsWith(a+'/')))))throw new Error('hosted mounts must be separate custody roots');
  return ['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--user',`${binding.uid}:${binding.gid}`,'--pids-limit=256','--memory=4g','--memory-swap=4g','--cpus=2',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=256m','--workdir=/result','--env','HOME=/tmp','--env','LANG=C.UTF-8',
    ...paths.flatMap((path,index)=>['--mount',`type=bind,src=${path},dst=${['/controller','/carriers','/result','/helper','/preparation'][index]}${index===2?'':',readonly'}`]),
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
export async function runHosted({controller,carriers,output,helper,preparation,commit,digest,execute=spawnSync}){
  controller=directory(controller);
  // Refuse before creating a container or running any unadmitted image. The image
  // must already be present; this adapter neither provisions nor pulls capacity.
  const binding=runtimeBinding(helper,commit);
  if(binding.uid!==process.getuid?.()||binding.gid!==process.getgid?.())throw new Error('admitted non-root runtime identity differs from runner output custody');
  await verifyController(controller,helper,commit,execute);
  const expected=validateExpectation(JSON.parse(readFileSync(join(preparation,'expectation.json'),'utf8')));
  if(expected.controllerCommit!==commit||expected.sourceSha256!==digest)throw new Error('hosted identities differ from independent preparation');
  if(existsSync(output))throw new Error('hosted comparison requires fresh output custody');
  mkdirSync(output,{recursive:true});
  const args=containerCommand({controller,carriers,output,helper,preparation,commit,digest,binding});
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
export async function worker({controller='/controller',carriers='/carriers',output='/result',preparation='/preparation',helper=new URL('.',import.meta.url).pathname,digest,execute=spawnSync}={}){
  if(!DIGEST.test(digest))throw new Error('independently retained source digest required');
  const expected=validateExpectation(JSON.parse(readFileSync(join(preparation,'expectation.json'),'utf8')));
  if(expected.sourceSha256!==digest)throw new Error('source digest differs from independent preparation');
  await verifyController(controller,helper,expected.controllerCommit);
  const {prepareExportedComparison,verifyChangeSources}=await import(pathToFileURL(join(controller,'scripts/materialize-sources.mjs')));
  const receipt=verifyChangeSources(carriers,digest);
  if(expected.sourceSha256!==digest||JSON.stringify(sourceExpectation(receipt,digest,{...expected,...expected.requestedPR}))!==JSON.stringify(expected))
    throw new Error('source carriers differ from independent preparation');
  const inputs=prepareExportedComparison(carriers,digest,join(output,'comparison'));
  const args=[join(controller,'scripts/test-change.mjs'),inputs.snapshot,join(output,'work'),
    `--local-sources=${join(output,'comparison/local-sources.json')}`,
    `--candidate-snapshot=${inputs.candidateSnapshot}`,
    ...inputs.changes.map(change=>`${change.repository}=${change.directory}`)];
  const result=execute(process.execPath,args,{env:closedEnvironment(),encoding:'utf8',timeout:115*60*1000,maxBuffer:64*1024*1024});
  writeFileSync(join(output,'test-change.log'),String(result.stderr??''));
  if(result.error||result.signal)throw result.error??new Error(`change comparison terminated: ${result.signal}`);
  let verdict;try{verdict=JSON.parse(result.stdout);}catch{throw new Error('change controller produced no complete verdict');}
  const error=verdictSourceError(verdict,expected,result.status)??receivingError(verdict,expected);
  if(error)throw new Error(error);
  verifyChangeSources(carriers,digest);
  writeFileSync(join(output,'verdict.json'),JSON.stringify(verdict)+'\n');
  // Diagnostic output only. Report authority remains in /preparation.
  writeFileSync(join(output,'source-receipt.json'),JSON.stringify({sourceSha256:digest,sourcePlanSha256:expected.sourcePlanSha256,
    comparisonPassed:verdict.verdict==='no-regression'&&result.status===0,deployedRuntimeAcceptance:false})+'\n');
  return {status:result.status===0&&verdict.verdict==='no-regression'?0:1,verdict};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{
    const [mode,...args]=process.argv.slice(2);
    if(mode==='--admit-source-controller'&&args.length===1){admitSourceController(new URL('.',import.meta.url).pathname,args[0]);}
    else if(mode==='--verify-controller'&&args.length===2){await verifyController(args[0],new URL('.',import.meta.url).pathname,args[1]);}
    else if(mode==='--prepare-expectation'&&args.length===9){const [controller,commit,carriers,preparation,machine,machineCommit,repository,head,output]=args;await prepareExpectation({controller,helper:new URL('.',import.meta.url).pathname,commit,carriers,preparation,machine,machineCommit,repository,head,output});}
    else if(mode==='--worker'&&args.length===1){const result=await worker({digest:args[0]});process.stdout.write(JSON.stringify(result.verdict)+'\n');process.exitCode=result.status;}
    else if(mode==='--run'&&args.length===7){const [controller,carriers,output,helper,commit,digest,preparation]=args;
      const result=await runHosted({controller,carriers,output,helper,preparation,commit,digest});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exitCode=result.status;
    }else throw new Error('usage: hosted-change.mjs --run CONTROLLER CARRIERS OUTPUT HELPER CONTROLLER_COMMIT SOURCE_SHA256 PREPARATION_DIRECTORY');
  }catch(error){console.error(`hosted-change: ${error.message}`);process.exitCode=1;}
}
