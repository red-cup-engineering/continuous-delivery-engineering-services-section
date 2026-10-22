import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {inspectRunnerGraph, verifyHistoricalRunner, compareRetainedRunnerGraphs} from '../generator/retained-runner.mjs';
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
const repository='group/machine', supplier='engineering/delivery', path='.github/workflows/sync.yml';
const runsOn=['self-hosted','Linux','X64','machine'];
const root=ref=>`on:\n  push:\n    branches: [main]\npermissions: {contents: write}\njobs:\n  advance:\n    uses: ${supplier}/.github/workflows/super.yml@${ref}\n    with:\n      runs-on: '["self-hosted","Linux","X64","machine"]'\n    secrets: {token: "\${{ secrets.EXISTING_TOKEN }}"}\n`;
const superWorkflow=`on: {workflow_call: {}}\npermissions: {contents: write}\njobs:\n  advance:\n    uses: ./.github/workflows/leaf.yml\n    with:\n      runs-on: "\${{ inputs.runs-on }}"\n    secrets: {token: "\${{ secrets.token }}"}\n`;
const leaf=`on: {workflow_call: {}}\npermissions: {contents: write}\njobs:\n  advance:\n    runs-on: "\${{ fromJSON(inputs.runs-on) }}"\n    env: {GH_TOKEN: "\${{ secrets.token || github.token }}"}\n    steps: [{run: 'true'}]\n`;
async function graph(content=root(B), transform=x=>x) {
 const requests=[];
 const result=await inspectRunnerGraph({repository,commit:A,path,content,runsOn,readWorkflow:async(repo,ref,file)=>{
   requests.push({repo,ref,file});assert.equal(repo,supplier);assert.ok([B,C].includes(ref));
   return transform(file.endsWith('/super.yml')?superWorkflow:leaf,file);
 }});
 return {...result,requests};
}
test('immutable reusable graph resolves relative calls at its containing supplier and revision',async()=>{
 const before=await graph(),after=await graph(root(C));
 assert.deepEqual(before.requests.map(x=>[x.repo,x.ref]),[[supplier,B],[supplier,B]]);
 assert.deepEqual([...before.leaves.values()].map(x=>x.name),['advance / advance / advance']);
 assert.equal(compareRetainedRunnerGraphs(before,after).selectorRetained,true);
});
for(const [name,change] of [
 ['mutable supplier',s=>s.replace('@'+B,'@main')],
 ['dynamic selector',s=>s.replace('["self-hosted","Linux","X64","machine"]','${{ matrix.runner }}')],
 ['different selector',s=>s.replace('X64','ARM64')],
 ['duplicate YAML key',s=>s+'permissions: {contents: read}\n'],
 ['matrix strategy',s=>s.replace('    uses:', '    strategy: {matrix: {x: [1]}}\n    uses:')],
 ['dynamic name',s=>s.replace('    uses:', '    name: "${{ inputs.name }}"\n    uses:')],
 ['input-dependent environment',s=>s.replace('    uses:', '    environment: "${{ inputs.stage }}"\n    uses:')],
]) test(`retained graph refuses ${name}`,async()=>{await assert.rejects(()=>graph(change(root(B))),{code:'runner-evidence'});});
for(const [name,transform] of [
 ['permission',s=>s.replace('contents: write','contents: read')],
 ['secret identity',s=>s.replace('secrets.token || github.token','secrets.other || github.token')],
 ['environment',s=>s.replace('    env:', '    environment: production\n    env:')],
]) test(`existing leaf ${name} changes cannot hide behind equal selectors`,async()=>{
 const before=await graph(),after=await graph(root(C),(s,file)=>file.endsWith('/leaf.yml')?transform(s):s);
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
});
test('different supplier path is refused despite matching declarations',async()=>{
 const before=await graph(),after=await graph();after.nodes.get('advance').supplier.path='.github/workflows/replacement.yml';
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
});
test('job-profile swapping cannot preserve admission by set equality',async()=>{
 const before=await graph(),after=await graph();const parent=after.nodes.get('advance'),child=after.nodes.get('advance/advance');
 [parent.envelope,child.envelope]=[child.envelope,parent.envelope];
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
});
test('reusable input and default changes cannot hide behind an unchanged callee expression',async()=>{
 const before=await graph(),after=await graph(root(C).replace('    with:', '    with:\n      stage: production'));
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
 const defaults=await graph(root(C),s=>s.replace('workflow_call: {}','workflow_call: {inputs: {stage: {default: production}}}'));
 assert.throws(()=>compareRetainedRunnerGraphs(before,defaults),{code:'runner-evidence'});
});
test('workflow environment bracket and case credential expressions stay visible',async()=>{
 const before=await graph(),after=await graph(root(C)+"env: {A: \"${{ SeCrEtS['TOKEN'] }}\"}\n");
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
});
test('complete activation delta includes nested job-if and concurrency',async()=>{
 const before=await graph(),after=await graph(root(C),(s,file)=>file.endsWith('/leaf.yml')?s.replace('    env:',"    if: github.event_name == 'push'\n    concurrency: existing\n    env:"):s);
 const delta=compareRetainedRunnerGraphs(before,after).triggerChanges;
 assert.equal(delta.after['advance/advance'].jobs.advance.concurrency,'existing');
 assert.equal(delta.before['advance/advance'].jobs.advance.if,null);
});
const direct=(extra='')=>`on: [push]\npermissions: {contents: read}\njobs:\n  release:\n    runs-on: [self-hosted, Linux, X64, machine]\n    steps: [{run: 'true'}]\n${extra}`;
const diagnostic=`  change-receiving:\n    permissions: {contents: read}\n    runs-on: [self-hosted, Linux, X64, machine]\n    steps:\n      - uses: actions/checkout@${B}\n        with: {persist-credentials: false}\n      - run: 'true'\n`;
const directGraph=content=>inspectRunnerGraph({repository,commit:A,path,content,runsOn,readWorkflow:async()=>assert.fail('unexpected call')});
test('only the exact owner-produced read-only direct addition retains existing selection',async()=>{
 const before=await directGraph(direct()),after=await directGraph(direct(diagnostic));
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
 const descriptor={job:'change-receiving',fragment:after.fragments.get('change-receiving')};
 assert.equal(compareRetainedRunnerGraphs(before,after,{additions:[descriptor]}).addedJobs.length,1);
 assert.throws(()=>compareRetainedRunnerGraphs(before,after,{additions:[{...descriptor,fragment:{}}]}),{code:'runner-evidence'});
 assert.throws(()=>compareRetainedRunnerGraphs(before,after,{additions:[descriptor,descriptor]}),{code:'runner-evidence'});
});
for(const [name,change] of [
 ['write permissions',s=>s.replace('permissions: {contents: read}','permissions: {contents: write}')],
 ['environment',s=>s.replace('    permissions:', '    environment: production\n    permissions:')],
 ['secret',s=>s.replace('    permissions:', '    secrets: inherit\n    permissions:')],
 ['container',s=>s.replace('    permissions:', '    container: ubuntu\n    permissions:')],
 ['service',s=>s.replace('    permissions:', '    services: {db: {image: postgres}}\n    permissions:')],
 ['credential persistence',s=>s.replace('persist-credentials: false','persist-credentials: true')],
 ['implicit checkout persistence',s=>s.replace('        with: {persist-credentials: false}\n','')],
]) test(`even an exact fragment cannot admit a new ${name} grant`,async()=>{
 const before=await directGraph(direct()),after=await directGraph(direct(change(diagnostic)));
 assert.throws(()=>compareRetainedRunnerGraphs(before,after,{additions:[{job:'change-receiving',fragment:after.fragments.get('change-receiving')}]}),{code:'runner-evidence'});
});
for(const [name,extra] of [
 ['checkout persistence','with: {persist-credentials: true}'],
 ['literal step token','env: {GH_TOKEN: fixture-only}'],
 ['literal action token','with: {token: fixture-only}'],
 ['SSH identity','with: {ssh-key: fixture-only}'],
 ['default checkout credentials',`uses: actions/checkout@${B}`],
]) test(`nested ${name} changes remain visible`,async()=>{
 const before=await graph(),after=await graph(root(C),(s,file)=>file.endsWith('/leaf.yml')?s.replace("steps: [{run: 'true'}]",`steps: [{run: 'true', ${extra}}]`):s);
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
});
function history(graph){
 const owner={id:1,full_name:repository,default_branch:'main'},runId=3,jobId=4;
 const run={id:runId,repository:owner,head_repository:owner,head_sha:A,head_branch:'main',path,run_attempt:2};
 const job={id:jobId,run_id:runId,run_attempt:2,head_sha:A,name:'advance / advance / advance',labels:runsOn,
  runner_id:21,runner_name:'existing',started_at:'2026-10-13T20:09:59Z',status:'completed',conclusion:'failure'};
 return {owner,sourceCommit:A,path,runId,jobId,run,jobs:{total_count:1,jobs:[job]},graph,runsOn};
}
test('failed started execution proves only historical enrollment',async()=>{
 const result=verifyHistoricalRunner(history(await graph()));assert.equal(result.runnerId,21);assert.equal(result.currentAvailability,'unknown');assert.equal(result.executedSuccessfully,false);
});
for(const [name,change] of [
 ['foreign head repository',p=>p.run.head_repository={...p.owner,id:2}],
 ['source mismatch',p=>p.run.head_sha=B],['workflow path mismatch',p=>p.run.path='.github/workflows/other.yml'],
 ['non-default branch',p=>p.run.head_branch='review/other'],['run mismatch',p=>p.run.id=9],
 ['job attempt mismatch',p=>p.jobs.jobs[0].run_attempt=1],['incomplete jobs',p=>p.jobs.total_count=2],
 ['duplicate job IDs',p=>{p.jobs.jobs.push({...p.jobs.jobs[0]});p.jobs.total_count=2;}],
 ['same-label wrong job',p=>p.jobs.jobs[0].name='other'],['no runner assignment',p=>p.jobs.jobs[0].runner_id=0],
 ['unstarted queued job',p=>{p.jobs.jobs[0].started_at=null;p.jobs.jobs[0].status='queued';}],
]) test(`historical proof refuses ${name}`,async()=>{
 const data=history(await graph());change(data);assert.throws(()=>verifyHistoricalRunner(data),{code:'runner-evidence'});
});

const actual=JSON.parse(fs.readFileSync(new URL('./fixtures/retained-runner-sources.json',import.meta.url),'utf8'));
test('default proof provider is a required compatible peer in both manifest and lock metadata',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const locked=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url),'utf8')).packages[''];
 for(const p of [manifest,locked]){
  assert.equal(p.peerDependencies['@red-cup-engineering/git-services-section'],'>=0.1.12');
  assert.notEqual(p.peerDependenciesMeta?.['@red-cup-engineering/git-services-section']?.optional,true);
 }
});
const source=id=>actual.sources.find(s=>s.id===id);
const blob=s=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
async function actualGraph(record,labels,content=record.content) {
 assert.equal(blob(record.content),record.gitBlob);
 return inspectRunnerGraph({...record,runsOn:labels,content,readWorkflow:async(repository,commit,path)=>{
   const found=actual.sources.find(s=>s.repository===repository&&s.commit===commit&&s.path===path);
   assert.ok(found,'all actual supplier source must be immutable and present');assert.equal(blob(found.content),found.gitBlob);return found.content;
 }});
}
test('real received BCF sync and its newer CD supplier retain exact no-billing admission',async()=>{
 const labels=['self-hosted','Linux','X64','bare-cedar-fog'];
 const H=source('sync-received'),S=source('sync-current'),before=await actualGraph(H,labels),after=await actualGraph(S,labels);
 assert.equal(compareRetainedRunnerGraphs(before,after).selectorRetained,true);
 const {run,jobs}=actual.syncObservation;
 const observed=verifyHistoricalRunner({owner:{...run.repository,default_branch:'main'},sourceCommit:H.commit,path:H.path,
   runId:38465155928,jobId:115529903186,run,jobs,graph:before,runsOn:labels});
 assert.equal(observed.runnerId,21);assert.equal(observed.currentAvailability,'unknown');
});
test('real historical optional hosted-runner default cannot excuse changed current call declarations',async()=>{
 const record=source('sync-current'),old=record.content.replaceAll('07b3abdc21ede3cd6c4d7ffc9984b33f0d9af778','59d7f6c109f0a6f4576139aebc594c5ed13bfc67');
 const labels=['self-hosted','Linux','X64','bare-cedar-fog'];
 const before=await actualGraph(record,labels,old),after=await actualGraph(record,labels);
 assert.throws(()=>compareRetainedRunnerGraphs(before,after),{code:'runner-evidence'});
});
test('complete real Guix projection retains cf54 release admission and exposes its historical preview boundary',async()=>{
 const base=source('release-current'),p=actual.releaseProjection,labels=['self-hosted','Linux','X64','guix','bare-cedar-fog'];
 assert.equal(base.gitBlob,'b2a444a526a3b70ed2c831b675439e54f3362829');assert.equal(blob(p.content),p.gitBlob);
 const before=await actualGraph(base,labels),after=await actualGraph(base,labels,p.content);
 const fragment=parse(p.content).jobs['change-receiving'];
 const result=compareRetainedRunnerGraphs(before,after,{additions:[{job:'change-receiving',fragment,producer:p.producer}]});
 assert.equal(result.selectorRetained,true);assert.equal(result.activationApproved,false);
 assert.match(result.triggerChanges.after['.'].jobs['change-receiving'].if,new RegExp(p.sourceCommit));
 assert.notEqual(p.sourceCommit,base.commit,'source eligibility must not claim the old preview is current');
 assert.equal(fragment.steps.find(s=>s.uses?.startsWith('actions/checkout@')).with['persist-credentials'],false);
});
