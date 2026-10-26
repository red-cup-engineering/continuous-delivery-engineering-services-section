// This uses the actual reviewed Guix source exporter/restorer. The comparison
// execution port is deliberately not a runtime assay: it returns 'incomplete'.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,cpSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {reviewedControllerTree,REVIEWED_TREE} from './fixtures/reviewed-controller.mjs';
import {sourceExpectation} from '../scripts/change-source-evidence.mjs';
import {worker} from '../scripts/hosted-change.mjs';
import {machineEntry,machinesPinning} from '../scripts/pinning-machines.mjs';
import {readResults} from '../scripts/change-test-comment.mjs';

const supplier=process.env.GUIX_CONTROLLER_SOURCE?resolve(process.env.GUIX_CONTROLLER_SOURCE):null;
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'cd13-v2-source-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'};
  const run=(program,args)=>{assert.equal(program,'git');const r=spawnSync(program,['-c','core.hooksPath=/dev/null',...args],{env,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const git=(directory,...args)=>run('git',['-C',directory,...args]);
  const commit=(directory,files={},mounts)=>{
    for(const [path,body] of Object.entries(files)){mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),body);}
    if(mounts){
      for(const row of git(directory,'ls-files','--stage').split('\n'))if(row.startsWith('160000 '))git(directory,'update-index','--force-remove',row.split('\t')[1]);
      writeFileSync(join(directory,'.gitmodules'),mounts.map(({repository,path,commit})=>`[submodule "${path}"]\n path = ${path}\n url = https://github.com/${repository}.git\n branch = main\n`).join(''));
    }
    git(directory,'add','.');
    for(const row of mounts??[]){mkdirSync(join(directory,row.path),{recursive:true});git(directory,'update-index','--add','--cacheinfo',`160000,${row.commit},${row.path}`);}
    git(directory,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture');
    return git(directory,'rev-parse','HEAD');
  };
  const repo=(name,files,mounts=[])=>{const directory=join(root,name);mkdirSync(directory);git(directory,'init','-q','-b','main');return {directory,commit:commit(directory,files,mounts)};};
  const child=repo('child',{'package.json':'{"name":"@fixture/child"}\n','index.mjs':'export const value=1;\n'});
  const parent=repo('parent',{'README.md':'parent'},[{repository:'fixture/child',path:'child',commit:child.commit}]);
  const prefix='machines/nested',machine=repo('machine',{'outside.txt':'complete root bytes\n',[prefix+'/machine.json']:'{"repository":"fixture/machine","run":{"entries":["@fixture/child"]}}\n',[prefix+'/channels.scm']:'(channels)\n',[prefix+'/dependencies.lock.yaml']:'lock\n'},[{repository:'fixture/parent',path:'source/parent',commit:parent.commit}]);
  const localSources=new Map([['fixture/parent',parent.directory],['fixture/child',child.directory]]);
  return {root,run,git,commit,repo,child,parent,machine,prefix,localSources,snapshot:join(machine.directory,prefix)};
}

for(const mode of ['transitive-topology','machine-root'])test(`genuine v2 ${mode} exporter, hosted worker and report retain full graph custody`,{skip:!supplier&&'GUIX_CONTROLLER_SOURCE must supply the exact reviewed Guix owner source'},async t=>{
  assert.equal(reviewedControllerTree(supplier),REVIEWED_TREE,'the entire local supplier tree must match immutable Guix1456c041 before any import');
  const f=fixture(t),controller=join(f.root,'reviewed-controller'),helper=join(f.root,'helper');
  cpSync(supplier,controller,{recursive:true,filter:path=>!path.split('/').includes('.git')});mkdirSync(helper);
  f.git(controller,'init','-q');f.git(controller,'remote','add','origin','https://github.com/red-cup-engineering/guix-machine-release-service.git');
  const controllerCommit=f.commit(controller);
  assert.equal(f.git(controller,'rev-parse','HEAD^{tree}'),REVIEWED_TREE);
  writeFileSync(join(helper,'reviewed-source-controllers.json'),JSON.stringify({kind:'guix.reviewed-source-controllers.v2',controllers:[{commit:controllerCommit,tree:REVIEWED_TREE,verifierBlob:'2d889845a1f6a5dc41211fc9e93dd35e2b554062'}]}));
  const {exportChangeSources,verifyChangeSources,materializeSources}=await import(pathToFileURL(join(controller,'scripts/materialize-sources.mjs')));
  const carriers=join(f.root,'carriers'),output=join(f.root,'result'),preparation=join(f.root,'preparation');
  const acquire=(program,args)=>{
    args=[...args];
    if(args.includes('fetch')&&args.includes('origin')){
      const owner=decodeURIComponent(basename(args[args.indexOf('-C')+1])),local=f.localSources.get(owner);
      assert.ok(local,'all fixture acquisition stays in explicit local Git carriers');args[args.indexOf('origin')]=local;
    }
    return f.run(program,args);
  };
  const discovered=materializeSources(f.snapshot,join(f.root,'discovery'),{run:acquire});
  const machineName='fixture/machine:'+f.prefix;
  assert.deepEqual(machinesPinning('fixture/machine',{[machineName]:discovered}),[machineName]);
  assert.equal(discovered.repositories.find(source=>source.path==='.').commit,f.machine.commit);
  let changes=new Map(),candidateSnapshot=f.snapshot,repository,commit;
  if(mode==='transitive-topology'){
    const added=f.repo('added',{'package.json':'{"name":"@fixture/added"}\n'});f.localSources.set('fixture/added',added.directory);
    repository='fixture/parent';commit=f.commit(f.parent.directory,{},[{repository:'fixture/added',path:'new',commit:added.commit}]);changes.set(repository,f.parent.directory);
  }else{
    const next=join(f.root,'candidate-root');f.run('git',['clone','-q','--no-hardlinks',f.machine.directory,next]);
    repository='fixture/machine';commit=f.commit(next,{'outside.txt':'candidate complete root bytes\n',[f.prefix+'/dependencies.lock.yaml']:'candidate lock\n'});candidateSnapshot=join(next,f.prefix);
  }
  const {receipt,sha256}=exportChangeSources(f.snapshot,carriers,changes,{candidateSnapshot,localSources:f.localSources,run:f.run});
  const entry=machineEntry('fixture/machine:'+f.prefix,f.machine.commit);
  const expected=sourceExpectation(receipt,sha256,{...entry,repository,commit,controllerCommit});
  mkdirSync(output);mkdirSync(preparation);writeFileSync(join(preparation,'expectation.json'),JSON.stringify(expected));
  const verdict={kind:'change-test',snapshot:receipt.snapshot.commit,changes:receipt.sourcePlan.delta.map(({repository,candidate})=>({repository,commit:candidate?.commit??null})),
    baselineGraph:receipt.baselineGraph,candidateGraph:receipt.candidateGraph,sourcePlan:receipt.sourcePlan,sourcePlanSha256:receipt.sourcePlanSha256,packages:[],regressions:0,verdict:'incomplete',reason:'Runtime qualification remains separate'};
  const result=await worker({controller,helper,carriers,output,preparation,digest:sha256,execute:(program,args,options)=>{
    assert.equal(options.env.HOUSE_READ_TOKEN,undefined);assert.equal(options.env.GIT_ALLOW_PROTOCOL,'file');
    const candidate=args.find(value=>value.startsWith('--candidate-snapshot=')).split('=').slice(1).join('=');
    assert.equal(f.git(candidate,'rev-parse','HEAD'),receipt.candidateSnapshot.commit);
    const restoredRoot=f.git(candidate,'rev-parse','--show-toplevel');
    assert.equal(readFileSync(join(restoredRoot,'outside.txt'),'utf8'),mode==='machine-root'?'candidate complete root bytes\n':'complete root bytes\n');
    assert.equal(f.git(args[1],'rev-parse','HEAD'),f.machine.commit);
    assert.equal(args.filter(value=>value.startsWith('fixture/')).length,mode==='machine-root'?0:1);
    return {status:1,stdout:JSON.stringify(verdict),stderr:'Boundary execution port; no runtime executed'};
  }});
  assert.equal(result.status,1);assert.deepEqual(verifyChangeSources(carriers,sha256),receipt);
  if(mode==='transitive-topology'){
    assert.equal(verdict.changes.length,3);assert.deepEqual(verdict.changes.find(row=>row.repository==='fixture/child'),{repository:'fixture/child',commit:null});
  }else assert.notEqual(receipt.snapshot.lockBlob,receipt.candidateSnapshot.lockBlob);
  const results=join(f.root,'reports'),leg=join(results,entry.id);mkdirSync(leg,{recursive:true});writeFileSync(join(leg,'meta.json'),JSON.stringify({...entry,commit,status:1}));writeFileSync(join(leg,'verdict.json'),JSON.stringify(verdict));
  const context={expected:[entry],repository,commit,discovery:'success',controllerCommit,preparationByMachine:{[entry.machine]:expected}};
  assert.equal(readResults(results,context)[0].error,undefined);
  writeFileSync(join(leg,'source-receipt.json'),JSON.stringify(expected));
  assert.match(readResults(results,{...context,preparationByMachine:undefined})[0].error,/preparation/);
  const tamperOutput=join(f.root,'tamper-result');mkdirSync(tamperOutput);
  await assert.rejects(worker({controller,helper,carriers,output:tamperOutput,preparation,digest:sha256,execute:()=>{
    const file=join(carriers,'source-carriers.json');writeFileSync(file,readFileSync(file,'utf8')+' ');
    return {status:1,stdout:JSON.stringify(verdict),stderr:''};
  }}),/preparation digest/);
});
