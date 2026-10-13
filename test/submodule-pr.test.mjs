import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/submodule-advance.yml', import.meta.url), 'utf8'));
const step = workflow.jobs.advance.steps.find(step => step.name === 'open or update the one pull request');
function exercise(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-pr-metadata-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, '.git'));
  const body = 'Advanced:\n- supplier: old -> new\n\nLiteral $(touch injected), `echo unsafe`, $TOKEN\n';
  fs.writeFileSync(path.join(root, '.git/advance-body.md'), body);
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\n');
if(args[0] !== 'api') process.exit(91);
const method = args[args.indexOf('--method') + 1];
if(method === 'GET') {
  if(['lookup-failure', 'ambiguous'].includes(process.env.MODE)) process.exit(1);
  if(process.env.MODE === 'invalid-number') console.log('796/evil');
  else if(process.env.MODE !== 'missing') console.log('796');
} else if(['PATCH', 'POST'].includes(method)) {
  if(args[args.indexOf('-F') + 1] !== 'body=@.git/advance-body.md') process.exit(92);
  fs.copyFileSync('.git/advance-body.md', process.env.RECEIVED);
  if(process.env.MODE === 'write-failure') process.exit(1);
  console.log('https://github.com/561-group/bare-cedar-fog/pull/796');
} else process.exit(93);
`, {mode: 0o755});
  const result = spawnSync('/bin/sh', ['-c', step.run], {cwd: root, encoding: 'utf8', env: {
    PATH: root, MODE: mode, CALLS: path.join(root, 'calls'), RECEIVED: path.join(root, 'received'),
    GITHUB_REPOSITORY: '561-group/bare-cedar-fog', BRANCH: 'ci/submodule-advance', BASE: 'main',
  }});
  const calls = fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  return {result, calls, body, received: fs.existsSync(path.join(root, 'received')) ? fs.readFileSync(path.join(root, 'received'), 'utf8') : null};
}

test('published sync updates the existing PR body through REST without querying projectCards', t => {
  const {result, calls, body, received} = exercise(t, 'existing');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[0].slice(0, 4), ['api', '--method', 'GET', 'repos/561-group/bare-cedar-fog/pulls']);
  for(const field of ['head=561-group:ci/submodule-advance', 'base=main', 'state=open', 'per_page=2']) assert.ok(calls[0].includes(field));
  assert.match(calls[0].at(-1), /length > 1.*error/);
  assert.deepEqual(calls[1], ['api', '--method', 'PATCH', 'repos/561-group/bare-cedar-fog/pulls/796', '-F', 'body=@.git/advance-body.md', '--jq', '.html_url']);
  assert.equal(calls.length, 2);
  assert.equal(received, body);
});

test('confirmed missing sync PR uses REST creation with the same exact body', t => {
  const {result, calls, body, received} = exercise(t, 'missing');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[1], ['api', '--method', 'POST', 'repos/561-group/bare-cedar-fog/pulls', '-f', 'base=main', '-f', 'head=ci/submodule-advance', '-f', 'title=Advance submodules', '-F', 'body=@.git/advance-body.md', '--jq', '.html_url']);
  assert.equal(calls.length, 2);
  assert.equal(received, body);
});

for(const mode of ['lookup-failure', 'ambiguous', 'invalid-number']) test(`${mode} cannot fall through into a PR write`, t => {
  const {result, calls, received} = exercise(t, mode);
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(received, null);
});

test('uncertain metadata write fails without retry or duplicate creation', t => {
  const {result, calls} = exercise(t, 'write-failure');
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][2], 'PATCH');
});

test('metadata repair preserves the already selected runner, authority and partial-success condition', () => {
  assert.equal(step.if, "always() && steps.advance.outputs.advanced == 'true'");
  assert.deepEqual(workflow.permissions, {contents: 'write', 'pull-requests': 'write'});
  assert.equal(workflow.jobs.advance['runs-on'], '${{ fromJSON(inputs.runs-on) }}');
  assert.equal(workflow.jobs.advance.steps.find(step => step.with?.path === '.cds').with.ref, '131900a1a55b8d3d769a389c43cd6236147d69ab');
  assert.doesNotMatch(step.run.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n'), /gh pr (edit|create|list)/);
});
