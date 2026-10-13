import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { detect, generate as generateSource, renderCi as renderCiSource, renderSync as renderSyncSource, renderAgentWork, auditRunnerRouting, REUSABLE, REF } from '../generator/generate-ci.mjs';


const runsOn=['self-hosted','existing-runner'];
const generate=(root,options={})=>generateSource(root,{runsOn,...options});
const renderCi=(selection,options={})=>renderCiSource(selection,{runsOn,...options});
const renderSync=options=>renderSyncSource({runsOn,...options});

// Fixture repositories are built from a map of path -> content.
function fixture(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fx-'));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), c);
  }
  return d;
}

test('empty repository selects no fabrication while retaining original-work intake', () => {
  const r = generate(fixture({ 'a.txt': 'x' }));
  assert.deepEqual(r.selection, { node: false, lean: [], content: false });
  assert.deepEqual(Object.keys(r.files), ['.github/workflows/agent-work-intake.yml']);
});

test('agent intake serializes only comparable events and cannot cancel latest push with PR-target receiving', () => {
  const parsed = YAML.parse(renderAgentWork({ref: REF, runsOn}));
  assert.deepEqual(parsed.concurrency, {
    group: 'agent-work-${{ github.event_name }}-${{ github.event.pull_request.head.ref || github.ref_name }}',
    'cancel-in-progress': false
  });
  assert.equal(parsed.jobs.receive.with['runs-on'], '["self-hosted","existing-runner"]');
  assert.equal(parsed.jobs.receive.if,
    "github.event_name != 'push' || (github.ref_name != github.event.repository.default_branch && !github.event.deleted)");
  assert.deepEqual(parsed.on.pull_request_target.types, ['opened', 'reopened', 'synchronize', 'closed']);
});

test('package.json selects node-package, also when nested; node_modules is ignored', () => {
  assert.equal(detect(fixture({ 'pkg/package.json': '{}' })).node, true);
  assert.equal(detect(fixture({ 'node_modules/x/package.json': '{}' })).node, false);
});

test('lakefile selects lean with its working directory', () => {
  assert.deepEqual(detect(fixture({ 'lakefile.lean': '' })).lean, ['.']);
  const y = renderCi(detect(fixture({ 'proofs/lakefile.toml': '' })));
  assert.match(y, /lean-proofs:\n    uses: .*\/lean\.yml@[a-f0-9]{40}\n    with:\n      working-directory: proofs/);
});

test('relative $schema selects content; remote $schema does not', () => {
  assert.equal(detect(fixture({ 'a.json': '{"$schema":"./s.json"}' })).content, true);
  assert.equal(detect(fixture({ 'a.json': '{"$schema":"https://json-schema.org/x"}' })).content, false);
  assert.equal(detect(fixture({ 'a.json': 'not json' })).content, false);
});

test('relative markdown links select content; urls, anchors and fenced code do not', () => {
  assert.equal(detect(fixture({ 'a.md': 'see [b](b.md)' })).content, true);
  assert.equal(detect(fixture({ 'a.md': '[x](https://e.com) [y](#top)' })).content, false);
  assert.equal(detect(fixture({ 'a.md': '```\n[b](b.md)\n```' })).content, false);
});

test('all three selected: short caller naming each reusable workflow', () => {
  const r = generate(fixture({ 'package.json': '{}', 'lakefile.lean': '', 'README.md': '[d](d.md)' }));
  const y = r.files['.github/workflows/ci.yml'];
  for (const w of ['node-package', 'lean', 'content']) assert.ok(y.includes(`${REUSABLE}/${w}.yml@${REF}`), w);
  assert.ok(y.split('\n').length < 20);
  assert.match(y, /on: \[push, pull_request\]/);
});

test('handwritten workflows are reported against the covering reusable workflow', () => {
  const r = generate(fixture({
    'package.json': '{}',
    '.github/workflows/test.yml': 'steps:\n - run: npm ci\n',
    '.github/workflows/proof.yml': 'steps:\n - uses: leanprover/lean-action@v1\n',
    '.github/workflows/odd.yml': 'steps:\n - run: echo hi\n',
  }));
  const by = Object.fromEntries(r.handwritten.map(h => [h.file, h.coveredBy]));
  assert.deepEqual(by, { 'test.yml': 'node-package.yml', 'proof.yml': 'lean.yml', 'odd.yml': null });
});

test('repository with submodules gets a sync caller; a parent adds the upward notify', () => {
  const r = generate(fixture({ '.gitmodules': '' }), { parent: 'o/parent' });
  const y = r.files['.github/workflows/sync.yml'];
  assert.match(y, /superrepo-advance\.yml@[a-f0-9]{40}/);
  assert.match(y, /notify-parent\.yml@[a-f0-9]{40}/);
  assert.match(y, /parent: o\/parent/);
  assert.equal(renderSync({ submodules: false }), null);
});

test('current machine-neutral generator does not assign a package to implicit machines',()=>{
  assert.equal(generate(fixture({'package.json':'{}'})).files['.github/workflows/change-test.yml'],undefined);
});

test('root sync receives reviewed caller changes on its default branch without a review-branch loop', () => {
  const parsed = YAML.parse(renderSync({ submodules: true, defaultBranch: 'trunk',
    runsOn: ['self-hosted', 'existing-runner'], tokenSecret: 'EXISTING_TOKEN' }));
  assert.deepEqual(parsed.on.push, { branches: ['trunk'], paths: ['.github/workflows/sync.yml'] });
  assert.deepEqual(parsed.on.schedule, [{ cron: '17 6 * * *' }]);
  assert.deepEqual(parsed.on.repository_dispatch, { types: ['section-advanced'] });
  assert.ok('workflow_dispatch' in parsed.on);
  assert.equal(parsed.jobs.advance.if, undefined);
  assert.equal(parsed.jobs.notify, undefined);
  assert.deepEqual(parsed.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.equal(parsed.jobs.advance.with['runs-on'], '["self-hosted","existing-runner"]');
  assert.equal(parsed.jobs.advance.secrets.token, '${{ secrets.EXISTING_TOKEN }}');
  assert.deepEqual(parsed.concurrency, { group: 'submodule-sync', 'cancel-in-progress': false });
});

test('parented callers retain all default-source notifications and never advance on their own push', () => {
  for (const submodules of [true, false]) {
    const parsed = YAML.parse(renderSync({ submodules, parent: 'owner/parent', defaultBranch: 'trunk' }));
    assert.deepEqual(parsed.on.push, { branches: ['trunk'] });
    assert.equal(parsed.jobs.notify.if, "github.event_name == 'push'");
    assert.equal(parsed.jobs.notify.with.parent, 'owner/parent');
    if (submodules) assert.equal(parsed.jobs.advance.if, "github.event_name != 'push'");
    else assert.equal(parsed.jobs.advance, undefined);
  }
});

test('generated workflows refuse exhausted GitHub-hosted capacity and anonymous runners', () => {
  const selection = {node:true,lean:[],content:false};
  for (const labels of [undefined, [], ['ubuntu-latest'], ['ubuntu-24.04'],
    ['self-hosted'], ['self-hosted','Linux','X64'],
    ['self-hosted','Linux','X64','Linux'], ['self-hosted','Linux','X64','bad label']]) {
    assert.throws(() => renderCiSource(selection,{ref:REF,runsOn:labels}),
      /runner labels|self-hosted runner|fallback/, JSON.stringify(labels));
  }
  const y=renderCiSource(selection,{ref:REF,runsOn:['self-hosted','Linux','X64','bare-cedar-fog']});
  assert.match(y, /self-hosted/);
  assert.match(y, /bare-cedar-fog/);
  assert.doesNotMatch(y, /ubuntu-latest/);
});

test('runner auditor finds direct GitHub-hosted drift and missing reusable caller identity', () => {
  const root = fixture({
    '.github/workflows/handwritten.yml': 'name: handwritten\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    '.github/workflows/agent-work-intake.yml': 'on: [push]\njobs:\n  receive:\n    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/agent-work.yml@' + REF + '\n',
    '.github/workflows/good.yml': 'on: [push]\njobs:\n  test:\n    runs-on: [self-hosted, Linux, X64, bare-cedar-fog]\n    steps:\n      - run: true\n',
  });
  const findings = auditRunnerRouting(root);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(x=>x.file), [
    '.github/workflows/agent-work-intake.yml',
    '.github/workflows/handwritten.yml'
  ]);
  assert.equal(auditRunnerRouting(root,{publicRepository:true}).length,1,
    'only an explicitly public repository may exempt free isolated GitHub-hosted jobs');
});
test('runner auditor recognizes required inherited selectors and refuses unbound ones', () => {
  const valid = 'on:\n  workflow_call:\n    inputs:\n      runs-on:\n        type: string\n        required: true\njobs:\n  test:\n    runs-on: ${{ fromJSON(inputs.runs-on) }}\n    steps:\n      - run: true\n';
  const bad = valid.replace('required: true','required: false');
  assert.deepEqual(auditRunnerRouting(fixture({'.github/workflows/valid.yml':valid})),[]);
  assert.equal(auditRunnerRouting(fixture({'.github/workflows/bad.yml':bad})).length,1);
});
test('runner auditor refuses duplicate workflow keys and anonymous direct runners', () => {
  const root=fixture({
    '.github/workflows/malformed.yml': 'on: [push]\non: [pull_request]\njobs: {}\n',
    '.github/workflows/anonymous.yml': 'on: [push]\njobs:\n  test:\n    runs-on: [self-hosted, Linux, X64]\n    steps:\n      - run: true\n'
  });
  assert.equal(auditRunnerRouting(root).length,2);
});

test('runner auditor follows local reusable selectors and does not trust unknown providers', () => {
  const root=fixture({
    '.github/workflows/local.yml': 'on: [push]\njobs:\n  use:\n    uses: ./.github/workflows/node-package.yml\n    with:\n      runs-on: \'["ubuntu-latest"]\'\n',
    '.github/workflows/external.yml': 'on: [push]\njobs:\n  use:\n    uses: some-third-party/unknown/.github/workflows/ci.yml@' + REF + '\n',
    '.github/workflows/bound.yml': 'on: [push]\njobs:\n  use:\n    uses: ./.github/workflows/node-package.yml\n    with:\n      runs-on: \'["self-hosted","Linux","X64","bare-cedar-fog"]\'\n',
  });
  const findings=auditRunnerRouting(root);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(f=>f.file),[
    '.github/workflows/external.yml',
    '.github/workflows/local.yml'
  ]);
});
