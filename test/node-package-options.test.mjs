import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import * as fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {renderCi} from '../generator/generate-ci.mjs';

const source=readFileSync(new URL('../.github/workflows/node-package.yml',import.meta.url),'utf8');
const workflow=parse(source);

test('existing callers keep install, check and npm test defaults',()=>{
  const inputs=workflow.on.workflow_call.inputs;
  assert.equal(inputs.install.default,true);
  assert.equal(inputs.check.default,true);
  assert.equal(inputs['test-script'].default,'test');
  assert.equal(inputs.install.type,'boolean');
  assert.equal(inputs.check.type,'boolean');
  assert.equal(inputs['test-script'].type,'string');
});

test('dependency-free source tests skip install and checks without changing the default workflow',()=>{
  const steps=workflow.jobs.package.steps;
  const install=steps.find(s=>s.name==='Install dependencies when needed');
  const check=steps.find(s=>s.name==='Check package when requested');
  const testStep=steps.find(s=>s.name==='Run selected named test script');
  assert.equal(install.if,"inputs.install && inputs.package-manager == 'npm'");
  assert.equal(check.if,'inputs.check');
  assert.equal(testStep.env.TEST_SCRIPT,'\${{ inputs.test-script }}');
  assert.match(testStep.run,/\['run','--if-present',script/);
  assert.match(testStep.run,/Invalid npm test script name/);
});

test('PNPM receiving binds immutable original source and confines registry secrets to installation',()=>{
  const inputs=workflow.on.workflow_call.inputs;
  assert.equal(inputs['package-manager'].default,'npm');
  assert.equal(inputs['supplier-ref'].default,'');
  const steps=workflow.jobs.package.steps;
  const source=steps.find(s=>s.name==='Receive exact PNPM installer source');
  assert.equal(source.with.repository,'red-cup-engineering/continuous-delivery-services-section');
  assert.equal(source.with.ref,'${{ inputs.supplier-ref }}');
  assert.equal(source.with['persist-credentials'],false);
  const install=steps.find(s=>s.name==='Install original frozen PNPM graph');
  assert.equal(install.if,"inputs.install && inputs.package-manager == 'pnpm'");
  assert.equal(install.env.REGISTRY_TOKEN,'${{ secrets.registry-token }}');
  assert.equal(install.env.REGISTRY_PASSWORD,'${{ secrets.registry-password }}');
  assert.ok(!workflow.jobs.package.env);
  for(const step of steps.filter(s=>/Check package|Run selected/.test(s.name??'')))
    assert.ok(!Object.keys(step.env??{}).some(name=>/TOKEN|PASSWORD/.test(name)));
});

test('caller cannot turn an npm script name into arbitrary shell',()=>{
  const run=workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run;
  assert.match(run,/a-zA-Z0-9:._-/);
  const root=nativePackage('node capture.mjs');
  fs.writeFileSync(path.join(root,'capture.mjs'),"import fs from 'node:fs';fs.writeFileSync('should-not-run','');");
  const rejected=executeNamedTest(root,[],{TEST_SCRIPT:'test; touch should-not-run'});
  assert.notEqual(rejected.status,0);assert.equal(fs.existsSync(path.join(root,'should-not-run')),false);
  assert.ok(!run.includes('eval '));
});

test('original caller generator binds PNPM source, supplier, paths and one named credential',()=>{
 const ref='a'.repeat(40);
 const produced=parse(renderCi({node:true,lean:[],content:false},{ref,runsOn:['self-hosted','Linux','X64','bare-cedar-fog'],
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',testArguments:['--test-concurrency=1'],paths:['lib/organizing'],registryUrl:'https://registry.example.test/',
   registryUsername:'reader',registryPasswordSecret:'SOURCE_REGISTRY_READ_PASSWORD'}}));
 const job=produced.jobs['node-package'];
 assert.equal(job.with['supplier-ref'],ref);
 assert.equal(job.with['source-commit'],'${{ github.sha }}');
 assert.equal(job.with['package-manager'],'pnpm');
 assert.equal(job.with['pnpm-version'],'11.28.5');
 assert.deepEqual(JSON.parse(job.with['test-arguments']),['--test-concurrency=1']);
 assert.deepEqual(JSON.parse(job.with.paths),['lib/organizing']);
 assert.equal(job.with.concurrency,1);
 assert.equal(job.secrets['registry-password'],'${{ secrets.SOURCE_REGISTRY_READ_PASSWORD }}');
 assert.equal(job.with['registry-username'],'reader');
});

test('caller generation refuses ambiguous secrets, unbound identity and shell-like secret names',()=>{
 for(const delta of [{registryPasswordSecret:'BAD;COMMAND'},{registryPasswordSecret:'PASSWORD',registryTokenSecret:'TOKEN'},
  {registryPasswordSecret:'PASSWORD',registryUrl:undefined}, {paths:['../outside']}])
  assert.throws(()=>renderCi({node:true,lean:[],content:false},{ref:'a'.repeat(40),runsOn:['self-hosted','bare-cedar-fog'],
   nodePackage:{packageManager:'pnpm',paths:['lib/organizing'],registryUrl:'https://registry.example.test/',registryUsername:'reader',...delta}}));
});

const caseRoot=new URL('../data/logs/node-package-options-fixtures/',import.meta.url);
fs.mkdirSync(caseRoot,{recursive:true});
const nativeRoots=[];test.after(()=>{for(const root of nativeRoots)fs.rmSync(root,{recursive:true,force:true});});
function nativePackage(script){
 const root=fs.mkdtempSync(new URL('case-',caseRoot));nativeRoots.push(root);
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({private:true,type:'module',scripts:{test:script}}));
 return root;
}
function executeNamedTest(root,args,extra={}){
 const environment={...process.env,TEST_SCRIPT:'test',TEST_ARGUMENTS:JSON.stringify(args),...extra};
 delete environment.NODE_TEST_CONTEXT;
 return spawnSync('bash',['-c',workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run],{
  cwd:root,encoding:'utf8',timeout:15000,env:environment});
}
test('native descriptor bounds actual Node workers before original glob; appended npm flags do not',()=>{
 const original='node --test "test/**/*.test.mjs"';
 const root=nativePackage(original);
 fs.mkdirSync(path.join(root,'test/nested'),{recursive:true});
 for(const index of [0,1]){
  const source=`import test from 'node:test';import fs from 'node:fs';import path from 'node:path';import {setTimeout} from 'node:timers/promises';
test('file worker is serial',async()=>{
 const root=process.env.SERIAL_ROOT;
 if(process.env.PARALLEL_CONTROL==='true'){
  fs.writeFileSync(path.join(root,'started-${index}'),'');
  const deadline=Date.now()+5000;while(!fs.existsSync(path.join(root,'started-${1-index}'))){if(Date.now()>deadline)throw Error('parallel native control did not start');await setTimeout(5);}
 }
 const lock=path.join(root,'worker.lock');const fd=fs.openSync(lock,'wx');
 try{await setTimeout(300);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
});`;
  fs.writeFileSync(path.join(root,'test/nested',index+'.test.mjs'),source);
 }
 const parallel=executeNamedTest(root,['--test-concurrency=2'],{SERIAL_ROOT:root,PARALLEL_CONTROL:'true'});
 assert.equal(parallel.status,1,parallel.stdout+parallel.stderr);
 assert.match(parallel.stdout+parallel.stderr,/EEXIST/);
 const serial=executeNamedTest(root,[],{SERIAL_ROOT:root,PARALLEL_CONTROL:'false',
  NODE_TEST:JSON.stringify({expectedScript:original,files:['test/**/*.test.mjs'],concurrency:1})});
 assert.equal(serial.status,0,serial.stdout+serial.stderr);
 assert.match(serial.stdout,/tests 2/);
});
test('native descriptor refuses changed script, lifecycle hooks, argv mixing and escaped patterns before execution',()=>{
 const original='node --test "test/**/*.test.mjs"';
 const root=nativePackage(original);
 const descriptor={expectedScript:original,files:['test/**/*.test.mjs'],concurrency:1};
 for(const delta of [{expectedScript:'node other.mjs'},{files:['../other.test.mjs']},{concurrency:0},{extra:true}]){
  const result=executeNamedTest(root,[],{NODE_TEST:JSON.stringify({...descriptor,...delta})});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
 }
 const mixed=executeNamedTest(root,['--test-concurrency=1'],{NODE_TEST:JSON.stringify(descriptor)});
 assert.notEqual(mixed.status,0);
 for(const scripts of [{test:'node changed.mjs'},{test:original,pretest:'node hook.mjs'},{test:original,posttest:'node hook.mjs'}]){
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module',scripts}));
  const result=executeNamedTest(root,[],{NODE_TEST:JSON.stringify(descriptor)});
  assert.notEqual(result.status,0);assert.match(result.stderr,/differs from original script or lifecycle hooks/);
 }
});
test('generator preserves the exact original native script and places its resource limit in a closed descriptor',()=>{
 const nodeTest={expectedScript:'node --test "test/**/*.test.mjs"',files:['test/**/*.test.mjs'],concurrency:1};
 const options={ref:'a'.repeat(40),runsOn:['self-hosted','bare-cedar-fog'],
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',paths:['lib/organizing'],nodeTest}};
 const produced=parse(renderCi({node:true,lean:[],content:false},options));
 assert.deepEqual(JSON.parse(produced.jobs['node-package'].with['node-test']),nodeTest);
 for(const delta of [{expectedScript:'node other.mjs'},{files:['../outside']},{concurrency:0},{unexpected:'field'}])
  assert.throws(()=>renderCi({node:true,lean:[],content:false},{...options,nodePackage:{...options.nodePackage,nodeTest:{...nodeTest,...delta}}}));
});
test('structured arguments remain literal through native npm and malformed vectors never start a script',()=>{
 const root=nativePackage('node capture.mjs');
 fs.writeFileSync(path.join(root,'capture.mjs'),"import fs from 'node:fs';fs.writeFileSync('received.json',JSON.stringify(process.argv.slice(2)));");
 const argument='$(touch SHOULD_NOT_EXIST); echo fixture';
 const result=executeNamedTest(root,[argument]);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'received.json'))),[argument]);assert.equal(fs.existsSync(path.join(root,'SHOULD_NOT_EXIST')),false);
 fs.rmSync(path.join(root,'received.json'));
 const malformed=spawnSync('bash',['-c',workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run],{
  cwd:root,encoding:'utf8',env:{...process.env,TEST_SCRIPT:'test',TEST_ARGUMENTS:'{"not":"argv"}'}});
 assert.notEqual(malformed.status,0);assert.equal(fs.existsSync(path.join(root,'received.json')),false);
});


test('exact Node supplier flows through original generator and reusable workflow without changing defaults',()=>{
 assert.equal(workflow.on.workflow_call.inputs['node-version'].default,'24');
 assert.equal(workflow.jobs.package.steps.find(s=>s.uses?.startsWith('actions/setup-node@')).with['node-version'],'${{ inputs.node-version }}');
 const options={ref:'a'.repeat(40),runsOn:['ubuntu-24.04'],publicRepository:true,
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',nodeVersion:'24.19.0',paths:['services/pnpm-services-section']}};
 assert.equal(parse(renderCi({node:true,lean:[],content:false},options)).jobs['node-package'].with['node-version'],'24.19.0');
 for(const version of ['24','latest','24.x','>=24.19.0','24.19.0; touch injected',['24.19.0'],null,{},24])
  assert.throws(()=>renderCi({node:true,lean:[],content:false},{...options,nodePackage:{...options.nodePackage,nodeVersion:version}}));
});
