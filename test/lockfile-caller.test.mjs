import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { generate, renderLockfileFreshCaller, REF, REUSABLE } from '../generator/generate-ci.mjs';

// Exact source: 561-group/bare-cedar-fog@099b036cf27035b25041eb7133f4fd26fe06fc08,
// .github/workflows/lockfile-fresh.yml, Git blob 209567aac073ab1cee8b10d81f77829e0f41c06e.
const source = fs.readFileSync(new URL('./fixtures/lockfile-caller.yml', import.meta.url), 'utf8');
const oldRef = 'e186963c8a4b9cfe5a90e5e33c3e6e30f56cc282';
const runsOn = ['self-hosted', 'Linux', 'X64', 'bare-cedar-fog'];
const toolWorkspace = { repository: '561-group/source-fixture', revision: 'b'.repeat(40), checkerPath: 'services/continuous-delivery' };
const sourceTokenSecret = 'EXISTING_SOURCE_READ';
const bindingOptions = { runsOn, toolWorkspace, sourceTokenSecret };
const options = { ...bindingOptions, workflows: ['lockfile-fresh'] };
const file = '.github/workflows/lockfile-fresh.yml';
const oldUse = `${REUSABLE}/lockfile-fresh.yml@${oldRef}`;
const newUse = `${REUSABLE}/lockfile-fresh.yml@${REF}`;
const render = text => renderLockfileFreshCaller(text, bindingOptions);
function bindExpected(job) {
  job.uses = newUse;
  Object.assign(job.with, {
    'supplier-revision': REF,
    'tool-workspace-repository': toolWorkspace.repository,
    'tool-workspace-revision': toolWorkspace.revision,
    'tool-workspace-checker-path': toolWorkspace.checkerPath,
  });
  job.secrets = { ...(typeof job.secrets === 'object' ? job.secrets : {}),
    'source-read-token': '${{ secrets.EXISTING_SOURCE_READ }}' };
}
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-lockfile-caller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

test('real BCF source binds exact supplier and workspace, then repeats byte-identically', () => {
  const bytes = Buffer.from(source);
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'),
    '209567aac073ab1cee8b10d81f77829e0f41c06e');
  const output = render(source);
  assert.equal(render(output), output);
  const before = YAML.parse(source), after = YAML.parse(output);
  bindExpected(before.jobs['lockfile-fresh']);
  assert.deepEqual(after, before);
  assert.equal(after.jobs['lockfile-fresh'].with.directory, undefined);
  assert.equal(after.concurrency, undefined);
});

test('different caller retains unrelated policy while binding its selected source secret', () => {
  const input = source.replace('  pull_request:', '  pull_request:\n    paths: ["workspace/**"]\n  workflow_dispatch:')
    .replace('jobs:', `# This occurrence is inert: ${oldUse}\npermissions: {contents: read}\nconcurrency: {group: checker-existing, cancel-in-progress: false}\njobs:`)
    .replace('  lockfile-fresh:', '  check_workspace:')
    .replace('    uses:', "    if: github.event_name == 'pull_request'\n    concurrency: {group: checker-job, cancel-in-progress: true}\n    permissions: {contents: read}\n    secrets: inherit\n    uses:")
    .replace('    with:', '    with:\n      directory: "nested workspace"')
    + '  untouched:\n    runs-on: [self-hosted, existing-other]\n    steps: [{run: "true"}]\n';
  for (const text of [input, input.replaceAll('\n', '\r\n')]) {
    const output = render(text), expected = YAML.parse(text);
    bindExpected(expected.jobs.check_workspace);
    assert.deepEqual(YAML.parse(output), expected);
    assert.ok(output.includes(`# This occurrence is inert: ${oldUse}`));
    assert.equal(render(output), output);
  }
});

test('quoted and flow-style supplier scalars preserve adjacent comments and Unicode source', () => {
  const quoted = source.replace(`uses: ${oldUse}`, `uses: '${oldUse}' # preserve 🌲 ${oldUse}`);
  const quotedOutput = render(quoted);
  assert.ok(quotedOutput.includes(`# preserve 🌲 ${oldUse}`));
  assert.equal(YAML.parse(quotedOutput).jobs['lockfile-fresh'].uses, newUse);
  assert.equal(render(quotedOutput), quotedOutput);
  const flow = `# preserve 🌲\nname: checker\non: [pull_request]\njobs: {check: {uses: '${oldUse}', with: {runs-on: '${JSON.stringify(runsOn)}'}}}\n`;
  const flowOutput = render(flow), expected = YAML.parse(flow);
  bindExpected(expected.jobs.check);
  assert.deepEqual(YAML.parse(flowOutput), expected);
  assert.ok(flowOutput.includes('# preserve 🌲'));
  assert.equal(render(flowOutput), flowOutput);
});

for (const [name, change] of [
  ['duplicate key', text => text + 'jobs: {}\n'],
  ['alias', text => text.replace('name: lockfile-fresh', 'name: &name lockfile-fresh\nrun-name: *name')],
  ['anchor', text => text.replace('name: lockfile-fresh', 'name: &name lockfile-fresh')],
  ['merge declaration', text => text.replace('    with:', '    <<: {permissions: {contents: write}}\n    with:')],
  ['wrong supplier', text => text.replace(REUSABLE, 'another/owner/.github/workflows')],
  ['wrong workflow', text => text.replace('workflows/lockfile-fresh.yml', 'workflows/other.yml')],
  ['moving supplier', text => text.replace(oldRef, 'main')],
  ['dynamic supplier', text => text.replace(oldRef, '${{ inputs.revision }}')],
  ['direct steps', text => text.replace('    with:', '    steps: []\n    with:')],
  ['direct runner', text => text.replace('    with:', '    runs-on: self-hosted\n    with:')],
  ['matrix job', text => text.replace('    with:', '    strategy: {matrix: {os: [linux]}}\n    with:')],
  ['unbound runner', text => text.replace(/      runs-on:.*\n/, '')],
  ['dynamic runner', text => text.replace('["self-hosted","Linux","X64","bare-cedar-fog"]', '${{ inputs.runner }}')],
  ['different runner', text => text.replace('"bare-cedar-fog"', '"another-machine"')],
  ['duplicate checker jobs', text => text + text.slice(text.indexOf('  lockfile-fresh:')).replace('  lockfile-fresh:', '  duplicate:')],
  ['invalid YAML', () => 'jobs: ['],
  ['non-workflow document', () => '[]\n'],
]) test(`caller transformation refuses ${name}`, () => assert.throws(() => render(change(source))));

test('supplier identity is the actual generator revision, never an independent override', () => {
  assert.throws(() => renderLockfileFreshCaller(source, { runsOn, ref: 'a'.repeat(40) }), /generator source commit/);
  assert.throws(() => renderLockfileFreshCaller(source, { runsOn, ref: 'main' }), /exact source commit/);
  assert.throws(() => renderLockfileFreshCaller(source, { runsOn: ['ubuntu-latest'] }), /house CI/);
  assert.throws(() => renderLockfileFreshCaller(source, {}), /runner labels/);
});

test('explicit selection adopts only its existing caller and accurately classifies generated output', t => {
  const root = fixture(t, { [file]: source, 'package.json': '{}', '.gitmodules': '',
    '.github/workflows/other.yml': 'name: handwritten\non: push\njobs: {}\n' });
  const produced = generate(root, options);
  assert.deepEqual(Object.keys(produced.files), [file]);
  assert.equal(produced.files[file], render(source));
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), source, 'producer does not edit source');
  assert.deepEqual(produced.handwritten.find(x => x.file === 'lockfile-fresh.yml'),
    { file: 'lockfile-fresh.yml', coveredBy: 'lockfile-fresh.yml', note: 'generated caller' });
  assert.equal(produced.handwritten.find(x => x.file === 'other.yml').note, 'no reusable workflow covers it');
});

test('ordinary generation leaves the existing checker unmodified and does not enroll new callers', t => {
  const control = fixture(t, { 'package.json': '{}', '.gitmodules': '' });
  const existing = fixture(t, { 'package.json': '{}', '.gitmodules': '', [file]: source });
  assert.deepEqual(generate(existing, { runsOn }).files, generate(control, { runsOn }).files);
  assert.equal(generate(existing, { runsOn }).files[file], undefined);
  assert.throws(() => generate(control, options), /no source capability/);
  assert.throws(() => generate(control, { ...options, workflows: [] }), /explicit generated workflow selection/);
  assert.throws(() => generate(control, { ...options, workflows: ['lockfile-fresh', 'lockfile-fresh'] }), /explicit generated workflow selection/);
  assert.throws(() => generate(existing, { ...options, workflows: new Array(1) }), /explicit generated workflow selection/);
});

test('existing non-caller source and source symlinks are never silently adopted', t => {
  const root = fixture(t, { [file]: 'name: custom\non: pull_request\njobs: {}\n' });
  assert.throws(() => generate(root, options), /existing lockfile-fresh caller/);
  fs.unlinkSync(path.join(root, file));
  fs.symlinkSync('elsewhere.yml', path.join(root, file));
  assert.throws(() => generate(root, options), /regular source file/);
});

test('source byte decoding and direct string inputs must be lossless and bounded', t => {
  const root = fixture(t, { [file]: Buffer.concat([Buffer.from(source), Buffer.from([0xff])]) });
  assert.throws(() => generate(root, options), /lossless UTF-8/);
  assert.throws(() => render(source + '\ud800'), /existing lockfile-fresh caller/);
  assert.throws(() => render(source + '#'.repeat(1024 * 1024)), /existing lockfile-fresh caller/);
});

test('explicit unrelated caller secrets survive source token binding', () => {
  const input = source.replace('    with:', '    secrets:\n      retained: ${{ secrets.RETAINED }}\n    with:');
  const output = render(input);
  assert.deepEqual(YAML.parse(output).jobs['lockfile-fresh'].secrets, {
    retained: '${{ secrets.RETAINED }}', 'source-read-token': '${{ secrets.EXISTING_SOURCE_READ }}',
  });
  assert.equal(render(output), output);
});

test('existing source associations cannot silently change', () => {
  const output = render(source);
  assert.throws(() => render(output.replace(`supplier-revision: ${REF}`, `supplier-revision: ${oldRef}`)), /supplier checkout differs/);
  for (const value of [toolWorkspace.repository, toolWorkspace.revision, toolWorkspace.checkerPath]) {
    assert.throws(() => render(output.replace(value, 'different')), /workspace differs/);
  }
  assert.throws(() => render(output.replace('secrets.EXISTING_SOURCE_READ', 'secrets.OTHER')), /source-read token differs/);
});

test('exact composed source and existing secret name are required', () => {
  for (const toolWorkspace of [undefined, {}, { ...bindingOptions.toolWorkspace, revision: 'main' },
    { ...bindingOptions.toolWorkspace, checkerPath: '../outside' },
    { ...bindingOptions.toolWorkspace, checkerPath: '/outside' }]) {
    assert.throws(() => renderLockfileFreshCaller(source, { ...bindingOptions, toolWorkspace }), /exact composed workspace/);
  }
  for (const sourceTokenSecret of [undefined, '', 'secret-name', '${{ secrets.NAME }}']) {
    assert.throws(() => renderLockfileFreshCaller(source, { ...bindingOptions, sourceTokenSecret }), /existing source-read secret name/);
  }
});
