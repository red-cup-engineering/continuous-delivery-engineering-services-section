import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/submodule-advance.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.advance;
const step = job.steps.find(step => step.name === 'open or update the one pull request');
const repo = '561-group/bare-cedar-fog', base = 'main', branch = 'ci/submodule-advance';
const A = 'a'.repeat(40), B = 'b'.repeat(40);

// Exercise the actual workflow command and CLI, with only Git path discovery and
// the REST transport substituted. The receiver's full refusal/race matrix lives
// in pending-submodule-pr.test.mjs; no retired inline-shell behavior is retained.
function exercise(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-pr-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Owned temp may be beneath this module package; the extensionless mock tools are CommonJS.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.cds/scripts'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/submodule-pr.mjs', import.meta.url), path.join(root, '.cds/scripts/submodule-pr.mjs'));
  const body = `Advanced:\n- supplier: aaaaaaaaa -> bbbbbbbbb\n\nLiteral $(touch injected), \`echo unsafe\`, $TOKEN\n\nObserved base: ${A}\nObserved head: ${B}\n`;
  fs.writeFileSync(path.join(root, '.git/advance-proposal.json'), JSON.stringify({ branch, baseSha: A, headSha: B, body }));
  // A stale body file must never be the receiver's source of metadata.
  fs.writeFileSync(path.join(root, '.git/advance-body.md'), 'stale body');
  fs.writeFileSync(path.join(root, 'git'), `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.GIT_CALLS,JSON.stringify(process.argv.slice(2)));console.log('.git/advance-proposal.json');\n`, { mode: 0o755 });
  const pull = { number: 796, state: 'open', html_url: `https://github.com/${repo}/pull/796`, body: 'stale',
    head: { ref: branch, sha: B, repo: { full_name: repo } }, base: { ref: base, sha: A, repo: { full_name: repo } } };
  fs.writeFileSync(path.join(root, 'state'), JSON.stringify(mode === 'missing' ? null : pull));
  fs.writeFileSync(path.join(root, 'template'), JSON.stringify(pull));
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2), method = args[args.indexOf('--method') + 1], endpoint = args[3];
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, input }) + '\n');
if (args[0] !== 'api') process.exit(91);
let pull = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
if (method === 'GET' && endpoint.includes('/git/ref/heads/')) {
  const name = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
  console.log(JSON.stringify({ ref: 'refs/heads/' + name, object: { type: 'commit', sha: (name === process.env.BASE ? 'a' : 'b').repeat(40) } }));
} else if (method === 'GET' && endpoint.includes('/pulls?')) {
  if (process.env.MODE === 'lookup-failure') process.exit(1);
  if (process.env.MODE === 'invalid-number') pull.number = '796/evil';
  console.log(JSON.stringify(process.env.MODE === 'ambiguous' ? [pull, pull] : pull ? [pull] : []));
} else if (method === 'GET' && endpoint.endsWith('/pulls/796')) {
  console.log(JSON.stringify(pull));
} else if (method === 'PATCH' || method === 'POST') {
  if (args[4] !== '--input' || args[5] !== '-') process.exit(92);
  if (process.env.MODE === 'write-failure') process.exit(1);
  pull ??= JSON.parse(fs.readFileSync(process.env.TEMPLATE, 'utf8'));
  pull.body = input.body;
  fs.writeFileSync(process.env.STATE, JSON.stringify(pull));
  if (process.env.MODE === 'lost-response') process.exit(1);
  console.log(JSON.stringify(pull));
} else process.exit(93);
`, { mode: 0o755 });
  const result = spawnSync('/bin/sh', ['-c', step.run], { cwd: root, encoding: 'utf8', env: {
    HOME: process.env.HOME,
    ...Object.fromEntries(['CODEX_HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    PATH: `${root}${path.delimiter}${path.dirname(process.execPath)}`, MODE: mode,
    CALLS: path.join(root, 'calls'), GIT_CALLS: path.join(root, 'git-calls'),
    STATE: path.join(root, 'state'), TEMPLATE: path.join(root, 'template'),
    GITHUB_REPOSITORY: repo, BRANCH: branch, BASE: base,
  } });
  const calls = fs.existsSync(path.join(root, 'calls'))
    ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { result, calls, body, root,
    gitCalls: JSON.parse(fs.readFileSync(path.join(root, 'git-calls'), 'utf8')),
    received: JSON.parse(fs.readFileSync(path.join(root, 'state'), 'utf8')) };
}

for (const [mode, method, status] of [['existing', 'PATCH', 'updated'], ['missing', 'POST', 'created'], ['lost-response', 'PATCH', 'reconciled']]) {
  test(`${mode}: the workflow CLI receives the exact same-run proposal through REST`, t => {
    const { result, calls, body, root, gitCalls, received } = exercise(t, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${status}: https://github.com/${repo}/pull/796`));
    assert.deepEqual(gitCalls, ['rev-parse', '--git-path', 'advance-proposal.json']);
    const writes = calls.filter(call => call.args[2] !== 'GET');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args[2], method);
    assert.equal(writes[0].input.body, body);
    assert.equal(received.body, body);
    assert.ok(calls.slice(-2).every(call => call.args[2] === 'GET' && call.args[3].includes('/git/ref/heads/')));
    assert.equal(fs.existsSync(path.join(root, 'injected')), false);
  });
}

for (const mode of ['lookup-failure', 'ambiguous', 'invalid-number']) {
  test(`${mode}: the workflow CLI refuses before metadata writes`, t => {
    const { result, calls } = exercise(t, mode);
    assert.notEqual(result.status, 0);
    assert.ok(calls.every(call => call.args[2] === 'GET'));
  });
}

test('unreceived metadata remains failed after one write and original-destination readback', t => {
  const { result, calls } = exercise(t, 'write-failure');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outcome unresolved/);
  assert.equal(calls.filter(call => call.args[2] !== 'GET').length, 1);
  assert.ok(calls.some(call => call.args[2] === 'GET' && call.args[3].endsWith('/pulls/796')));
});

test('workflow activates the immutable pending receiver while retaining caller authority', () => {
  assert.equal(step.if, "always() && steps.advance.outputs.pending == 'true'");
  assert.equal(step.run, 'node .cds/scripts/submodule-pr.mjs');
  assert.deepEqual(workflow.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.equal(job['runs-on'], '${{ fromJSON(inputs.runs-on) }}');
  assert.equal(workflow.on.workflow_call.inputs['runs-on'].required, true);
  assert.deepEqual(job.env, {
    GH_TOKEN: '${{ secrets.token || github.token }}', BRANCH: '${{ inputs.branch }}',
    NOTE: '${{ inputs.note }}', BASE: '${{ github.event.repository.default_branch }}',
  });
  assert.deepEqual(job.steps[0].with, {
    token: '${{ secrets.token || github.token }}', submodules: false, 'fetch-depth': 0,
    ref: '${{ github.event.repository.default_branch }}',
  });
  assert.deepEqual(job.steps.find(step => step.with?.path === '.cds').with, {
    repository: 'red-cup-engineering/continuous-delivery-engineering-services-section',
    ref: 'e141a4445864895631aa4f775a9ad6397e1772c8', path: '.cds', 'persist-credentials': false,
  });
  assert.equal(job.steps.find(step => step.id === 'advance').run, 'node .cds/scripts/advance.mjs --branch "$BRANCH" --note "$NOTE"');
});
