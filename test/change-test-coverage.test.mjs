import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { isCommit, machineName, machinesPinning } from '../scripts/pinning-machines.mjs';
import { overallVerdict, readResults, renderComment, upsertComment } from '../scripts/change-test-comment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'o/change', commit = 'c'.repeat(40), machineCommit = 'a'.repeat(40);
const idFor = (machine, sha = machineCommit) => createHash('sha256').update(JSON.stringify([machine, sha])).digest('hex');
const expected = ['o/machine:snapshot-a', 'o/machine:snapshot-b'].map((machine) => ({ machine, machineCommit, id: idFor(machine) }));
const context = { repository, commit, expected, discovery: 'success' };
const clean = () => ({ kind: 'change-test', snapshot: machineCommit, changes: [{ repository, commit }],
  verdict: 'no-regression', regressions: 0, lock: 'frozen', packages: [], designRules: { added: [], removed: [] } });
const sources = (repo = repository) => ({ repositories: [{ repository: repo, commit }] });
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'change-test-coverage-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function artifact(directory, entry, { name = entry.id, meta = {}, verdict = clean() } = {}) {
  const at = path.join(directory, name); fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, 'meta.json'), JSON.stringify({ ...entry, commit, status: 0, ...meta }));
  fs.writeFileSync(path.join(at, 'verdict.json'), JSON.stringify(verdict));
  return at;
}
const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/pinning-machines.mjs'), ...args], { encoding: 'utf8' });
const workflow = () => parse(fs.readFileSync(path.join(root, '.github/workflows/change-test.yml'), 'utf8'));

test('unknown or malformed source readings cannot prove an empty pin set', () => {
  for (const value of [null, {}, [], { repositories: 'x' }, { repositories: [null] },
    { repositories: [{ repository }] }, { repositories: [{ repository, commit: 'main' }] },
    { repositories: [{ repository: 'not-a-repository', commit }] },
    { repositories: [...sources().repositories, ...sources().repositories] }]) {
    assert.throws(() => machinesPinning(repository, { 'o/machine': value }), /unread|invalid|duplicate/i, JSON.stringify(value));
  }
  assert.deepEqual(machinesPinning(repository, { 'o/machine': sources('o/other') }), []);
});

test('unreadable CLI input fails even beside a valid pin, and duplicates cannot overwrite readings', (t) => {
  const d = temp(t), good = path.join(d, 'good.json'), bad = path.join(d, 'bad.json');
  fs.writeFileSync(good, JSON.stringify(sources())); fs.writeFileSync(bad, '{');
  for (const file of [bad, path.join(d, 'missing.json')]) {
    const result = cli(repository, `o/good=${good}`, `o/bad=${file}`);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /unread|invalid/i);
  }
  assert.notEqual(cli(repository, `o/machine=${good}`, `o/machine=${bad}`).status, 0);
});

test('candidate validation rejects malformed and duplicate scope before discovery', () => {
  for (const candidates of ['null', '{}', '"o/machine"', '[null]', '["o/machine","O/MACHINE"]', '["o/machine:../outside"]']) {
    assert.notEqual(cli('--candidates', '', candidates).status, 0, candidates);
  }
  assert.equal(cli('--candidates', 'o/machine:snapshot-a', 'ignored').stdout, 'o/machine:snapshot-a\n');
  assert.equal(cli('--candidates', '', '[]').status, 0);
});

test('discovery plans bind distinct snapshot paths and repository commits without lossy slugs', (t) => {
  const d = temp(t), file = path.join(d, 'sources.json'); fs.writeFileSync(file, JSON.stringify(sources()));
  const result = cli('--plan', repository, ...expected.map((entry) => `${entry.machine}@${entry.machineCommit}=${file}`));
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), expected);
  const moved = cli('--plan', repository, `o/machine:snapshot-a@${'b'.repeat(40)}=${file}`);
  assert.equal(moved.status, 0, moved.stderr); assert.notEqual(JSON.parse(moved.stdout)[0].id, expected[0].id);
});

test('a report requires every expected machine and an independently supplied head', (t) => {
  const d = temp(t); artifact(d, expected[0]);
  assert.notEqual(overallVerdict(readResults(d, context)), 'no-regression');
  assert.match(renderComment(readResults(d, context)), /missing|not received/i);
  assert.notEqual(overallVerdict(readResults(d)), 'no-regression');
  assert.notEqual(overallVerdict(readResults(d, { ...context, commit: undefined })), 'no-regression');
  assert.notEqual(overallVerdict(readResults(d, { ...context, discovery: 'failure' })), 'no-regression');
  artifact(d, expected[1]);
  assert.equal(overallVerdict(readResults(d, context)), 'no-regression');
  assert.notEqual(overallVerdict(readResults(path.join(d, 'absent'), context)), 'no-regression');
});

test('duplicate, unexpected, malformed and conflicting artifacts never qualify a complete matrix', (t) => {
  const cases = [
    (d) => artifact(d, expected[0], { name: 'duplicate' }),
    (d) => artifact(d, { machine: 'o/other', machineCommit, id: idFor('o/other') }),
    (d) => fs.writeFileSync(path.join(d, expected[0].id, 'meta.json'), '{'),
    (d) => fs.rmSync(path.join(d, expected[0].id, 'meta.json')),
    (d) => fs.writeFileSync(path.join(d, expected[0].id, 'verdict.json'), '{'),
    (d) => artifact(d, expected[0], { meta: { commit: 'd'.repeat(40) } }),
    (d) => artifact(d, expected[0], { meta: { machineCommit: 'b'.repeat(40) } }),
    (d) => artifact(d, expected[0], { meta: { id: expected[1].id } }),
    (d) => artifact(d, expected[0], { meta: { status: 1 } }),
    (d) => artifact(d, expected[0], { meta: { status: null } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), snapshot: 'b'.repeat(40) } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), changes: [{ repository, commit: 'd'.repeat(40) }] } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), changes: [{ repository: 'o/wrong', commit }] } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), changes: [...clean().changes, ...clean().changes] } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), kind: 'materialized' } }),
    (d) => artifact(d, expected[0], { verdict: { verdict: 'no-regression' } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), packages: {} } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), regressions: 1 } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), packages: [{ name: '@o/a', status: 'not-composed' }] } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), designRules: { added: ['drc-1'] } } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), designRules: { unread: 'could not read' } } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), verdict: 'unrecognized' } }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), verdict: undefined } }),
    (d) => artifact(d, expected[0], { verdict: null }),
    (d) => artifact(d, expected[0], { verdict: { ...clean(), packages: [{ name: '@o/a', tests: 2, passed: 0, regressions: [], preexisting: [] }] } }),
  ];
  for (const [i, mutate] of cases.entries()) {
    const d = path.join(temp(t), String(i)); for (const entry of expected) artifact(d, entry); mutate(d);
    const results = readResults(d, context);
    assert.notEqual(overallVerdict(results), 'no-regression', `adversarial case ${i}`);
    assert.doesNotThrow(() => renderComment(results), `render adversarial case ${i}`);
  }
});

test('an empty or duplicate expectation cannot hide received results, and unknown is not no pins', (t) => {
  const d = temp(t); artifact(d, expected[0]);
  assert.notEqual(overallVerdict(readResults(d, { ...context, expected: [] })), 'no-regression');
  assert.notEqual(overallVerdict(readResults(d, { ...context, expected: [expected[0], expected[0]] })), 'no-regression');
  assert.doesNotMatch(renderComment([], { none: repository }), /No machine pins/);
  const empty = temp(t), knownEmpty = { ...context, expected: [] };
  assert.match(renderComment(readResults(empty, knownEmpty), { ...knownEmpty, none: repository }), /No (?:candidate )?machine pins/);
  const unknown = { ...knownEmpty, discovery: 'failure' };
  assert.doesNotMatch(renderComment(readResults(empty, unknown), { ...unknown, none: repository }), /No (?:candidate )?machine pins/);
});

test('workflow carries immutable expected coverage through checkout, artifacts and reporting', () => {
  const { jobs } = workflow();
  assert.ok(jobs['change-test'].strategy.matrix.include, 'matrix includes the frozen discovery plan');
  assert.equal(jobs['change-test'].env.MACHINE_COMMIT, '${{ matrix.machineCommit }}');
  assert.equal(jobs['change-test'].env.MACHINE_SLUG, '${{ matrix.id }}');
  const machineStep = jobs['change-test'].steps.find((s) => s.name === 'Controller and machine');
  assert.match(machineStep.run, /checkout[^\n]+\$MACHINE_COMMIT/);
  const upload = jobs['change-test'].steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(upload.with.path.includes('MACHINE_SLUG'));
  const download = jobs.report.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['merge-multiple'], false, 'do not overwrite colliding artifact payloads before validation');
  const report = jobs.report.steps.find((s) => s.name === 'One comment, updated in place');
  assert.equal(report.env.EXPECTED_MACHINES, '${{ needs.machines.outputs.machines }}');
  assert.equal(report.env.EXPECTED_COMMIT, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.match(report.run, /--expected/); assert.match(report.run, /--commit/); assert.match(report.run, /--discovery/);
  assert.equal(report.if, 'always()');
  assert.doesNotMatch(jobs.report.if, /needs.machines.result == 'success'/);
  for (const job of Object.values(jobs)) for (const step of job.steps ?? []) if (step.run) {
    const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'fixture');
    assert.equal(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status, 0, step.name);
  }
});

function shellStep(t, script, extraEnv = {}) {
  const d = temp(t), bin = path.join(d, 'bin'); fs.mkdirSync(bin); fs.cpSync(path.join(root, 'scripts'), path.join(d, 'section/scripts'), { recursive: true });
  if(extraEnv.CONTROLLER_REF)fs.writeFileSync(path.join(d,'section/scripts/reviewed-source-controllers.json'),JSON.stringify({kind:'guix.reviewed-source-controllers.v1',commits:[extraEnv.CONTROLLER_REF]}));
  const output = path.join(d, 'output'), log = path.join(d, 'requests'); fs.writeFileSync(output, ''); fs.writeFileSync(log, '');
  return { d, bin, output, log, run: () => spawnSync('bash', ['-eo', 'pipefail', '-c', script.replaceAll('${{ github.repository }}', repository)],
    { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: d, GITHUB_OUTPUT: output,
      REQUEST_LOG: log, HOUSE_READ_TOKEN: 'fixture-token', MACHINE: '', MACHINES: JSON.stringify(expected.map((e) => e.machine)), ...extraEnv } }) };
}

test('the actual discovery shell resolves recursive reading through its exact controller and machine commits', (t) => {
  const script = workflow().jobs.machines.steps.find((step) => step.id === 'pins').run;
  const d=temp(t),controller=path.join(d,'controller'),machine=path.join(d,'machine');
  const actualGit=spawnSync('which',['git'],{encoding:'utf8'}).stdout.trim();
  const git=(cwd,...args)=>{const r=spawnSync(actualGit,args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  for(const directory of [controller,machine]){fs.mkdirSync(directory);git(directory,'init','-q','-b','main');git(directory,'config','user.name','Fixture');git(directory,'config','user.email','fixture@example.invalid');}
  fs.mkdirSync(path.join(controller,'scripts'));
  // Fixture controller models the committed-graph reading boundary. Separate
  // owner integration tests exercise the genuine recursive controller API.
  fs.writeFileSync(path.join(controller,'scripts/materialize-sources.mjs'), `import fs from 'node:fs';\nif(process.env.SCENARIO==='source-error')process.exit(22);\nconsole.log(process.env.SCENARIO==='invalid-source'?'{}':JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2]+'/reading.json','utf8'))));\n`);
  git(controller,'add','.');git(controller,'commit','-qm','reviewed controller');const controllerCommit=git(controller,'rev-parse','HEAD');
  for(const snapshot of ['snapshot-a','snapshot-b']){fs.mkdirSync(path.join(machine,snapshot));fs.writeFileSync(path.join(machine,snapshot,'reading.json'),JSON.stringify(sources()));}
  git(machine,'add','.');git(machine,'commit','-qm','reviewed machine');const pinned=git(machine,'rev-parse','HEAD');
  const planExpected=expected.map(entry=>({...entry,machineCommit:pinned,id:idFor(entry.machine,pinned)}));
  for(const snapshot of ['snapshot-a','snapshot-b'])fs.writeFileSync(path.join(machine,snapshot,'reading.json'),JSON.stringify(sources('o/other')));
  git(machine,'commit','-qam','moving default branch');
  for(const scenario of ['success','source-error','invalid-source','invalid-commit','forced','invalid-list']){
    const fixture=shellStep(t,script,{SCENARIO:scenario,CONTROLLER_REF:controllerCommit,
      ...(scenario==='forced'?{MACHINE:'o/machine:snapshot-a',MACHINES:'invalid'}:{}),...(scenario==='invalid-list'?{MACHINES:'{}'}:{})});
    fs.writeFileSync(path.join(fixture.bin,'git'), `#!${process.execPath}\nconst args=process.argv.slice(2).map(a=>a==='https://github.com/o/machine.git'?${JSON.stringify(machine)}:a==='https://github.com/red-cup-engineering/guix-machine-release-service.git'?${JSON.stringify(controller)}:a);if(args.some(a=>a.startsWith('https://')))process.exit(99);const r=require('child_process').spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
    fs.writeFileSync(path.join(fixture.bin,'curl'), `#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2),url=args.find(a=>a.startsWith('https://')),out=args[args.indexOf('-o')+1];fs.appendFileSync(process.env.REQUEST_LOG,url+'\\n');if(!url.endsWith('/commits/HEAD'))process.exit(99);fs.writeFileSync(out,JSON.stringify({sha:process.env.SCENARIO==='invalid-commit'?'main':'${pinned}'}));\n`,{mode:0o755});
    const result=fixture.run(),output=fs.readFileSync(fixture.output,'utf8');
    if(['source-error','invalid-source','invalid-commit','invalid-list'].includes(scenario)){assert.notEqual(result.status,0,scenario);assert.equal(output,'');}
    else{assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(output.trim().slice('machines='.length)),scenario==='forced'?planExpected.slice(0,1):planExpected);}
  }
});

test('the actual machine checkout uses the discovered commit after the default branch has moved', (t) => {
  const d = temp(t), machine = path.join(d, 'machine'), controller = path.join(d, 'controller');
  function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
  for (const repo of [machine, controller]) {
    fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), 'initial'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  }
  const controllerCommit = git(controller, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(controller, 'README.md'), 'moved controller'); git(controller, 'commit', '-qam', 'moved controller');
  fs.mkdirSync(path.join(machine, 'snapshot-a')); fs.writeFileSync(path.join(machine, 'snapshot-a', 'sources.json'), JSON.stringify(sources()));
  git(machine, 'add', '.'); git(machine, 'commit', '-qm', 'discovered'); const pinned = git(machine, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(machine, 'snapshot-a', 'sources.json'), JSON.stringify(sources('o/other'))); git(machine, 'commit', '-qam', 'moved');
  const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const script = workflow().jobs['change-test'].steps.find((step) => step.name === 'Controller and machine').run;
  for (const name of ['o/machine:snapshot-a', 'o/machine']) {
    const house = path.join(temp(t), 'house'), home = temp(t), envFile = path.join(home, 'env');
    fs.mkdirSync(house);
    const fixture = shellStep(t, script, { MACHINE: name, MACHINE_COMMIT: pinned, CONTROLLER_REF: controllerCommit, HOUSE: house, HOME: home, GITHUB_ENV: envFile });
    fs.writeFileSync(path.join(fixture.bin, 'git'), `#!${process.execPath}\n`
      + `const args=process.argv.slice(2).map(a=>a==='https://github.com/o/machine.git'?${JSON.stringify(machine)}:a==='https://github.com/red-cup-engineering/guix-machine-release-service.git'?${JSON.stringify(controller)}:a);\n`
      + `if(args.some(a=>a.startsWith('https://')))process.exit(99);\n`
      + `const r=require('child_process').spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'}); process.exit(r.status??1);\n`, { mode: 0o755 });
    const result = fixture.run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(git(path.join(house, 'controller'), 'rev-parse', 'HEAD'), controllerCommit);
    assert.equal(fs.readFileSync(path.join(house, 'controller/README.md'), 'utf8'), 'initial');
    assert.equal(git(path.join(house, 'machine-repository'), 'rev-parse', 'HEAD'), pinned);
    const checked = JSON.parse(fs.readFileSync(path.join(house, 'machine-repository/snapshot-a/sources.json'), 'utf8'));
    assert.equal(checked.repositories[0].repository, repository);
  }
});

test('report CLI is successful only for fully qualified coverage or proven empty discovery', (t) => {
  const d = temp(t); for (const entry of expected) artifact(d, entry);
  const report = (dir, opts = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/change-test-comment.mjs'), dir,
    '--expected', JSON.stringify(opts.expected ?? expected), '--commit', commit, '--repository', repository,
    '--discovery', opts.discovery ?? 'success', '--none', repository], { encoding: 'utf8' });
  assert.equal(report(d).status, 0);
  fs.rmSync(path.join(d, expected[1].id), { recursive: true });
  assert.notEqual(report(d).status, 0); assert.match(report(d).stdout, /missing/);
  const empty = temp(t);
  assert.equal(report(empty, { expected: [] }).status, 0);
  const unknown = report(empty, { expected: [], discovery: 'failure' });
  assert.notEqual(unknown.status, 0); assert.match(unknown.stdout, /coverage is unknown/); assert.doesNotMatch(unknown.stdout, /No candidate machine pins/);
});


test('the controller receipt contract preserves real clean, regression and incomplete outcomes', (t) => {
  const d = temp(t), entry = expected[0], one = { ...context, expected: [entry] };
  const packageResult = { name: '@o/a', repository, tests: 3, passed: 2, regressions: [], preexisting: ['test/existing.test.mjs'] };
  const receipts = [
    { ...clean(), packages: [packageResult] },
    { ...clean(), verdict: 'regression', regressions: 1, designRules: { added: [{ key: 'drc-1' }], removed: [] } },
    { kind: 'change-test', snapshot: machineCommit, changes: [{ repository, commit }], packages: [], regressions: 0,
      verdict: 'not-composed', reason: 'source unavailable', break: { class: 'repository-formation-unavailable' } },
    { ...clean(), verdict: 'incomplete', packages: [{ name: '@o/a', repository, status: 'not-composed' }] },
  ];
  for (const verdict of receipts) {
    artifact(d, entry, { verdict, meta: { status: verdict.verdict === 'no-regression' ? 0 : 1 } });
    const results = readResults(d, one);
    assert.equal(results.length, 1); assert.equal(results[0].error, undefined); assert.equal(overallVerdict(results), verdict.verdict);
  }
});


test('an older run cannot overwrite a comment for a newer pull-request head', async () => {
  for (const existing of [false, true]) for (const current of [commit, 'd'.repeat(40)]) {
    const writes = [], reads = [];
    const request = async (method, url) => {
      if (method !== 'GET') { writes.push([method, url]); return { html_url: 'published' }; }
      reads.push(url);
      if (url.includes('/pulls/')) return { head: { sha: current } };
      return existing ? [{ id: 9, user: {login:'github-actions[bot]'}, body: '<!-- continuous-delivery-services-section: change-test -->' }] : [];
    };
    const result = upsertComment({ repo: repository, pr: 1, body: 'report', request, commit });
    if (current === commit) { assert.equal(await result, 'published'); assert.equal(writes.length, 1); }
    else { await assert.rejects(result, /head changed/); assert.equal(writes.length, 0); }
    assert.equal(reads.at(-1), `/repos/${repository}/pulls/1`);
  }
});


test('immutable commits and machine identities require the entire input, without line terminators', (t) => {
  assert.equal(isCommit(commit), true);
  for (const invalid of [null, 40, '', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40)]) assert.equal(isCommit(invalid), false);
  assert.equal(machineName('O/Machine:Snapshot-a/nested'), 'o/machine:Snapshot-a/nested');
  const file = path.join(temp(t), 'commit.json');
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', ' ', '\t']) {
    assert.equal(isCommit(commit + suffix), false, JSON.stringify(suffix));
    fs.writeFileSync(file, JSON.stringify({ sha: commit + suffix }));
    const resolved = cli('--commit', file);
    assert.notEqual(resolved.status, 0); assert.equal(resolved.stdout, '');
    for (const machine of [`o/machine${suffix}`, `o/machine:snapshot-a${suffix}`, `o/machine:path${suffix}/child`]) {
      assert.throws(() => machineName(machine), /invalid machine/);
      const candidates = cli('--candidates', '', JSON.stringify([machine]));
      assert.notEqual(candidates.status, 0); assert.equal(candidates.stdout, '');
      assert.throws(() => machinesPinning(repository, { [machine]: sources() }), /invalid machine/);
    }
    assert.throws(() => machinesPinning(repository + suffix, { 'o/machine': sources() }), /invalid repository/);
    assert.throws(() => machinesPinning(repository, { 'o/machine': sources(repository + suffix) }), /invalid source/);
  }
});
