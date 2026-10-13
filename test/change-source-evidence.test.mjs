import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sourceExpectation,validateExpectation,verdictSourceError,receivingError} from '../scripts/change-source-evidence.mjs';
import {verifyController} from '../scripts/hosted-change.mjs';
import {evidence} from './fixtures/source-evidence.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));

test('source evidence rejects partial identities, forged plans and unrecognized status',()=>{
  const sample=evidence();assert.equal(verdictSourceError(sample.verdict,sample.expected,0),null);
  for(const mutate of [e=>e.snapshot.lockBlob='x',e=>e.candidateSnapshot.definition='other',e=>e.sourcePlan.delta=[],e=>e.sourcePlanSha256='f'.repeat(64),e=>e.baselineGraph.edges.push({}),e=>e.requestedPR.commit='f'.repeat(40)]){
    const changed=structuredClone(sample.expected);mutate(changed);assert.throws(()=>validateExpectation(changed));
  }
  for(const mutate of [v=>v.changes=[],v=>v.candidateGraph.edges.push({}),v=>v.sourcePlan.delta=[],v=>v.sourcePlanSha256='f'.repeat(64),v=>v.verdict='surprise']){
    const changed=structuredClone(sample.verdict);mutate(changed);assert.ok(verdictSourceError(changed,sample.expected,0));
  }
  assert.ok(verdictSourceError(sample.verdict,sample.expected,1));assert.ok(verdictSourceError({...sample.verdict,verdict:'incomplete'},sample.expected,0));
  assert.ok(verdictSourceError({...sample.verdict,verdict:'incomplete'},sample.expected,null));
});

test('missing or retired receiving obligations cannot become green',()=>{
  const {verdict,expected}=evidence();assert.equal(receivingError(verdict,expected),null);
  for(const change of [{unmeasured:true},{unread:'missing'},{removed:['@fixture/retired']},{removedTests:[{}]},{regressions:[{}]},{entries:{removed:['@fixture/entry']}},{removedPackages:[{disposition:'unmeasured'}]}])assert.ok(receivingError({...verdict,receiving:{...verdict.receiving,...change}},expected));
  assert.ok(receivingError({...verdict,receiving:undefined},expected));
});

test('trusted owner verifier rejects same-size hidden edits, untracked bytes and altered verifier before selected code',async t=>{
  const base=mkdtempSync(join(tmpdir(),'cd13-controller-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const controller=join(base,'controller'),helper=join(base,'helper');mkdirSync(join(controller,'scripts'),{recursive:true});mkdirSync(helper);
  const git=(...args)=>{const r=spawnSync('git',['-C',controller,...args],{env:{PATH:process.env.PATH,HOME:base,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file'},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('remote','add','origin','https://github.com/red-cup-engineering/guix-machine-release-service.git');
  copyFileSync(join(root,'test/fixtures/verify-release-source.mjs'),join(controller,'scripts/verify-release-source.mjs'));
  writeFileSync(join(controller,'scripts/never-import.mjs'),'throw new Error("must not execute selected module");\n');writeFileSync(join(controller,'.gitignore'),'ignored\n');writeFileSync(join(controller,'source.txt'),'original');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','reviewed fixture');
  const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');writeFileSync(join(helper,'reviewed-source-controllers.json'),JSON.stringify({kind:'guix.reviewed-source-controllers.v2',controllers:[{commit,tree,verifierBlob:'2d889845a1f6a5dc41211fc9e93dd35e2b554062'}]}));
  const execute=(program,args,options)=>{assert.notEqual(program,'docker');assert.notEqual(program,process.execPath);return spawnSync(program,args,options);};
  await verifyController(controller,helper,commit,execute);
  git('update-index','--assume-unchanged','source.txt');writeFileSync(join(controller,'source.txt'),'modified');await assert.rejects(verifyController(controller,helper,commit,execute),/bytes refused/);writeFileSync(join(controller,'source.txt'),'original');git('update-index','--no-assume-unchanged','source.txt');
  for(const file of ['ignored','untracked']){writeFileSync(join(controller,file),'unadmitted');await assert.rejects(verifyController(controller,helper,commit,execute),/bytes refused/);rmSync(join(controller,file));}
  writeFileSync(join(controller,'scripts/verify-release-source.mjs'),'throw new Error("must not execute altered verifier");\n');await assert.rejects(verifyController(controller,helper,commit,execute),/verifier bytes differ/);
});

test('declared receiving enrollment and exact per-test testimony cannot be erased',()=>{
  const sample=evidence(),name='@fixture/owed',owner=sample.expected.candidateGraph.repositories[1];
  // This test targets evidence consistency after source identity admission.
  for(const graph of [sample.expected.baselineGraph,sample.expected.candidateGraph])graph.receivingPackages=[name];
  const row=commit=>({name,repository:owner.repository,commit,path:'.',manifestSha256:'a'.repeat(64),tests:[{path:'test/owed.mjs',gitBlob:'b'.repeat(40),sha256:'c'.repeat(64)}],results:[{file:'test/owed.mjs',passed:true}]});
  sample.verdict.receiving.baseline=[row(sample.expected.baselineGraph.repositories[1].commit)];sample.verdict.receiving.candidate=[row(owner.commit)];
  assert.equal(receivingError(sample.verdict,sample.expected),null);
  for(const mutate of [r=>r.candidate=[],r=>r.candidate.push(r.candidate[0]),r=>r.candidate[0].commit='f'.repeat(40),r=>r.candidate[0].tests=[],r=>r.candidate[0].results=[],r=>r.candidate[0].results[0].passed=false,r=>r.candidate[0].results[0].file='test/other.mjs']){
    const changed=structuredClone(sample.verdict);mutate(changed.receiving);assert.ok(receivingError(changed,sample.expected));
  }
});

test('direct worker refuses unknown controller before any selected import-time marker',async t=>{
  const base=mkdtempSync(join(tmpdir(),'cd13-direct-worker-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const paths=Object.fromEntries(['controller','helper','carriers','preparation','output'].map(name=>[name,join(base,name)]));for(const path of Object.values(paths))mkdirSync(path);
  mkdirSync(join(paths.controller,'scripts'));
  const marker=join(base,'imported');writeFileSync(join(paths.controller,'scripts/materialize-sources.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');throw new Error('selected code executed');`);
  writeFileSync(join(paths.helper,'reviewed-source-controllers.json'),JSON.stringify({kind:'guix.reviewed-source-controllers.v2',controllers:[]}));
  const {expected}=evidence();writeFileSync(join(paths.preparation,'expectation.json'),JSON.stringify(expected));
  const {worker}=await import('../scripts/hosted-change.mjs');
  await assert.rejects(worker({...paths,digest:expected.sourceSha256,execute:()=>assert.fail('comparison must not execute')}),/not reviewed/);
  assert.throws(()=>readFileSync(marker),/ENOENT/);
});
