import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
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
  assert.match(testStep.run,/npm run --if-present "\$TEST_SCRIPT"/);
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
  assert.match(run,/exit 1/);
  assert.ok(!run.includes('eval '));
});

test('original caller generator binds PNPM source, supplier, paths and one named credential',()=>{
 const ref='a'.repeat(40);
 const produced=parse(renderCi({node:true,lean:[],content:false},{ref,runsOn:['self-hosted','Linux','X64','bare-cedar-fog'],
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',paths:['lib/organizing'],registryUrl:'https://registry.example.test/',
   registryUsername:'reader',registryPasswordSecret:'SOURCE_REGISTRY_READ_PASSWORD'}}));
 const job=produced.jobs['node-package'];
 assert.equal(job.with['supplier-ref'],ref);
 assert.equal(job.with['source-commit'],'${{ github.sha }}');
 assert.equal(job.with['package-manager'],'pnpm');
 assert.equal(job.with['pnpm-version'],'11.28.5');
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
