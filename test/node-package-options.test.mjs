import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';

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
  assert.equal(install.if,'inputs.install');
  assert.equal(check.if,'inputs.check');
  assert.equal(testStep.env.TEST_SCRIPT,'\${{ inputs.test-script }}');
  assert.match(testStep.run,/npm run --if-present "\$TEST_SCRIPT"/);
  assert.match(testStep.run,/Invalid npm test script name/);
});

test('caller cannot turn an npm script name into arbitrary shell',()=>{
  const run=workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run;
  assert.match(run,/a-zA-Z0-9:._-/);
  assert.match(run,/exit 1/);
  assert.ok(!run.includes('eval '));
});
