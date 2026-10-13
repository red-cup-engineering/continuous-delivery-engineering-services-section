import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generatedSource, verifyGeneratedSource, openPullRequest, githubRequest, planGeneratedTree } from '../generator/open-pr.mjs';
import { generateFromSource } from '../generator/generate-ci.mjs';
const repo = 'owner/source', branch = 'ci/caller-generator';
const inputs = [{ repository: 'owner/generator', commit: 'a'.repeat(40) }];
const files = { 'src/generated.mjs': 'export const generated = "exact 🌲 bytes";\n' };
// Real Git supplies object identities. No network, credentials or hosted effects.
function provider(t, initial = { 'package.json': '{}\n', 'untouched.txt': 'keep\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-receive-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args, input, overrides = {}) => execFileSync('git', args, { cwd: root, env: { ...env, ...overrides }, input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trimEnd();
  git(['init', '-q', '-b', 'main']);
  for (const [file, content] of Object.entries(initial)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
  git(['add', '.']); git(['commit', '-qm', 'source']);
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (Object.hasOwn(initial, 'generator/generate-ci.mjs')) {
    fs.appendFileSync(path.join(root,'.git/info/exclude'),'\n/node_modules\n');
    fs.symlinkSync(fs.realpathSync(new URL('../node_modules',import.meta.url)),path.join(root,'node_modules'),'dir');
  }
  const state = { head: sourceCommit, base: sourceCommit, pulls: [], calls: [], before: null, after: null };
  const treeResponse = sha => ({ sha, truncated: false, tree: git(['ls-tree', '-z', sha]).split('\0').filter(Boolean).map(row => {
    const [,mode,type,id,file] = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row); return { path:file, mode, type, sha:id };
  }) });
  const commitResponse = sha => ({ sha, tree:{ sha:git(['rev-parse',`${sha}^{tree}`]) }, parents:git(['show','-s','--format=%P',sha]).split(' ').filter(Boolean).map(sha=>({sha})), message:git(['show','-s','--format=%B',sha]) });
  const request = async (method,url,body) => {
    state.calls.push({method,url,body}); await state.before?.(method,url,body); let result;
    if (method==='GET' && url===`/repos/${repo}`) result=state.repository??{id:1,visibility:'public',full_name:repo,default_branch:'main'};
    else if (method==='GET' && url===`/repos/${repo}/actions/runs/81`) result=structuredClone(state.historicalRun);
    else if (method==='GET' && url===`/repos/${repo}/actions/runs/81/jobs?per_page=100`) result=structuredClone(state.historicalJobs);
    else if (method==='GET' && url.includes('/git/blobs/')) {
      const sha=url.split('/').at(-1),bytes=execFileSync('git',['cat-file','blob',sha],{cwd:root});
      result={sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')};
    }
    else if (method==='GET' && url===`/repos/${repo}/git/ref/heads/${branch}`) result=state.head===null?null:{object:{sha:state.head}};
    else if (method==='GET' && url===`/repos/${repo}/git/ref/heads/main`) result={object:{sha:state.base}};
    else if (method==='GET' && url.includes('/git/commits/')) result=commitResponse(url.split('/').at(-1));
    else if (method==='GET' && url.includes('/git/trees/')) result=treeResponse(url.split('/').at(-1).split('?')[0]);
    else if (method==='POST' && url.endsWith('/git/trees')) {
      const index=path.join(root,'.git',`temporary-index-${state.calls.length}`), overrides={GIT_INDEX_FILE:index};
      try { git(['read-tree',body.base_tree],undefined,overrides);
        for(const e of body.tree) {const blob=git(['hash-object','-w','--stdin'],e.content);git(['update-index','--add','--cacheinfo',`${e.mode},${blob},${e.path}`],undefined,overrides);}
        result={sha:git(['write-tree'],undefined,overrides)};
      } finally {fs.rmSync(index,{force:true});}
    } else if(method==='POST' && url.endsWith('/git/commits')) result={sha:git(['commit-tree',body.tree,...body.parents.flatMap(p=>['-p',p])],body.message)};
    else if((method==='PATCH' && url.endsWith(`/git/refs/heads/${branch}`))||(method==='POST' && url.endsWith('/git/refs'))) {
      if(method==='POST' && state.head!==null) throw new Error('reference exists');
      if(method==='PATCH') {assert.equal(body.force,false);git(['merge-base','--is-ancestor',state.head,body.sha]);}
      state.head=body.sha;result={object:{sha:body.sha}};
    } else if(method==='GET' && url.includes('/pulls?')) result=structuredClone(state.pulls.map(p=>({...p,head:{...p.head,sha:state.head}})));
    else if(method==='POST' && url.endsWith('/pulls')) {
      assert.equal(body.draft,true);result={number:1,state:'open',draft:true,html_url:`https://github.com/${repo}/pull/1`,head:{repo:{full_name:repo},ref:branch,sha:state.head},base:{ref:'main'}};state.pulls.push(result);
    } else throw new Error(`unhandled fixture route ${method} ${url}`);
    await state.after?.(method,url,body,result);return result;
  };
  return {root,git,state,request,sourceCommit,options:{repo,branch,sourceCommit,inputs,files,request,runsOn:['ubuntu-latest']}};
}
const writes=p=>p.state.calls.filter(c=>c.method!=='GET');

test('exact source, unrelated files, draft review, restart idempotence and regeneration parity',async t=>{
 const p=provider(t), first=await openPullRequest(p.options);
 assert.equal(first.status,'proposed');assert.equal(p.git(['show',`${first.commit}:src/generated.mjs`]),files['src/generated.mjs'].trimEnd());
 assert.equal(p.git(['show',`${first.commit}:untouched.txt`]),'keep');
 assert.equal(first.proposal.outputs[0].blob,p.git(['rev-parse',`${first.commit}:src/generated.mjs`]));
 assert.equal(first.proposal.outputs[0].bytes,Buffer.byteLength(files['src/generated.mjs']));
 assert.deepEqual(verifyGeneratedSource(first.proposal,{files,inputs}),first.proposal);
 const n=writes(p).length;assert.deepEqual(await openPullRequest(p.options),first);assert.equal(writes(p).length,n);
 assert.throws(()=>verifyGeneratedSource(first.proposal,{files:{...files,'src/generated.mjs':'different'},inputs}),{code:'generation-drift'});
 assert.throws(()=>verifyGeneratedSource(first.proposal,{files,inputs:[{...inputs[0],commit:'b'.repeat(40)}]}),{code:'generation-drift'});
});
test('new branch requires current default source; stale events cannot recreate old branches',async t=>{
 const p=provider(t);p.state.head=null;assert.equal((await openPullRequest(p.options)).status,'proposed');
 assert.equal(writes(p).filter(c=>c.url.endsWith('/git/refs')).length,1);
 const stale=provider(t);stale.state.head=null;stale.state.base='b'.repeat(40);
 await assert.rejects(openPullRequest(stale.options),{code:'stale-base'});assert.equal(writes(stale).length,0);
});
test('unchanged source manufactures no commit or review',async t=>{const p=provider(t,files);assert.equal((await openPullRequest(p.options)).status,'unchanged');assert.equal(writes(p).length,0);});
for(const effect of ['ref','pull']) test(`lost ${effect} response reconciles without duplicate writes`,async t=>{
 const p=provider(t);let lost=false;p.state.after=(method,url)=>{if(!lost&&((effect==='ref'&&method==='PATCH')||(effect==='pull'&&method==='POST'&&url.endsWith('/pulls')))){lost=true;throw new Error('lost response');}};
 assert.equal((await openPullRequest(p.options)).status,'proposed');assert.equal(p.state.pulls.length,1);assert.equal(writes(p).filter(c=>c.method==='PATCH').length,1);
});
test('unknown ref publication stops without successful receiving',async t=>{
 const p=provider(t);p.state.before=method=>{if(method==='PATCH')throw new Error('unavailable');};
 await assert.rejects(openPullRequest(p.options),{code:'publication-unresolved'});assert.equal(p.state.head,p.sourceCommit);assert.equal(p.state.pulls.length,0);
});
test('concurrent movement is preserved and never force-overwritten',async t=>{
 const p=provider(t),other=p.git(['commit-tree',p.git(['rev-parse','HEAD^{tree}']),'-p',p.sourceCommit],'concurrent contribution');
 p.state.before=method=>{if(method==='PATCH')p.state.head=other;};
 await assert.rejects(openPullRequest(p.options),{code:'publication-unresolved'});assert.equal(p.state.head,other);assert.equal(p.state.pulls.length,0);
});
test('unrelated branch head is stale even if its tree matches',async t=>{
 const p=provider(t);p.state.head=p.git(['commit-tree',p.git(['rev-parse','HEAD^{tree}']),'-p',p.sourceCommit],'reviewer change');
 await assert.rejects(openPullRequest(p.options),{code:'stale-head'});assert.equal(writes(p).length,0);
});
test('altered output tree is refused before publishing a ref',async t=>{
 const p=provider(t);p.state.after=(method,url,body,result)=>{if(method==='POST'&&url.endsWith('/git/trees'))result.sha=p.git(['rev-parse','HEAD^{tree}']);};
 await assert.rejects(openPullRequest(p.options),{code:'output-mismatch'});assert.equal(p.state.head,p.sourceCommit);assert.equal(p.state.pulls.length,0);
});
test('truncated tree is unknown rather than partial successful receiving',async t=>{
 const p=provider(t);p.state.after=(method,url,body,result)=>{if(url.includes('/git/trees/'))result.truncated=true;};
 await assert.rejects(openPullRequest(p.options),{code:'incomplete-tree'});assert.equal(writes(p).length,0);
});
test('closed exact proposal is not silently recreated',async t=>{
 const p=provider(t);await openPullRequest(p.options);p.state.pulls[0].state='closed';const n=writes(p).length;
 await assert.rejects(openPullRequest(p.options),{code:'closed-review'});assert.equal(writes(p).length,n);
});
test('unavailable review actuator preserves source branch and reports the gap',async t=>{
 const p=provider(t);p.state.before=(method,url)=>{if(method==='POST'&&url.endsWith('/pulls'))throw new Error('permission unavailable');};
 await assert.rejects(openPullRequest(p.options),{code:'review-unresolved'});assert.notEqual(p.state.head,p.sourceCommit);assert.equal(p.state.pulls.length,0);
});
test('invalid paths, UTF-8, suppliers and writes to default branch are rejected',async t=>{
 const p=provider(t);for(const file of ['../escape','/absolute','.git/config','a/../b','a\\b'])assert.throws(()=>generatedSource({...p.options,files:{[file]:'x'}}),{code:'invalid-output'});
 assert.throws(()=>generatedSource({...p.options,files:{a:'\ud800'}}),{code:'invalid-output'});
 assert.throws(()=>generatedSource({...p.options,inputs:[inputs[0],inputs[0]]}),{code:'invalid-inputs'});
 await assert.rejects(openPullRequest({...p.options,branch:'main'}),{code:'protected-base'});assert.equal(writes(p).length,0);
});
test('transport distinguishes absent GET from failed write; missing actuator is explicit',async()=>{
 assert.throws(()=>githubRequest(undefined),{code:'missing-actuator'});
 const request=githubRequest('fixture-not-a-credential',async()=>({status:404,ok:false}));assert.equal(await request('GET','/fixture'),null);
 await assert.rejects(request('POST','/fixture',{}),{code:'github-error'});
});
test('generation uses immutable source despite dirty/untracked working bytes and refuses symlinks',t=>{
 const p=provider(t,{'README.md':'plain text\n'});fs.writeFileSync(path.join(p.root,'README.md'),'[dirty](link.md)');fs.writeFileSync(path.join(p.root,'package.json'),'{}');
 const produced=generateFromSource(p.root,{runsOn:['ubuntu-latest']});assert.equal(produced.sourceCommit,p.sourceCommit);assert.deepEqual(Object.keys(produced.files),['.github/workflows/agent-work-intake.yml']);
 fs.symlinkSync('/does-not-exist',path.join(p.root,'linked.md'));p.git(['add','linked.md']);p.git(['commit','-qm','symlink']);assert.throws(()=>generateFromSource(p.root,{runsOn:['ubuntu-latest']}),/symlink/);
});
test('actual caller binds source and supplier, receives and verifies its regenerated bytes',async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
  'generator/retained-runner.mjs':fs.readFileSync(new URL('../generator/retained-runner.mjs',import.meta.url),'utf8'),
 });
 const {receiveGeneratedCaller}=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await receiveGeneratedCaller({root:p.root,repo,request:p.request,runsOn:['ubuntu-latest'],workflows:['ci']});assert.equal(result.status,'proposed');
 assert.equal(result.proposal.sourceCommit,p.sourceCommit);assert.equal(result.proposal.inputs[0].commit,supplier.sourceCommit);
 assert.match(p.git(['show',`${result.commit}:.github/workflows/ci.yml`]),new RegExp(supplier.sourceCommit));assert.equal(result.proposal.outputs.length,1);
 const n=writes(p).length;assert.deepEqual(await receiveGeneratedCaller({root:p.root,repo,request:p.request,runsOn:['ubuntu-latest'],workflows:['ci']}),result);assert.equal(writes(p).length,n);
});

test('later build consumes retained commit proposal, reruns the producer and rejects drift',async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
  'generator/retained-runner.mjs':fs.readFileSync(new URL('../generator/retained-runner.mjs',import.meta.url),'utf8'),
 });
 const module=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await module.receiveGeneratedCaller({root:p.root,repo,request:p.request,runsOn:['ubuntu-latest'],workflows:['ci']});
 p.git(['checkout','--detach',result.commit]);
 const verified=await module.verifyGeneratedCaller({root:p.root,runsOn:['ubuntu-latest'],workflows:['ci'],receiptCommit:result.commit});
 assert.equal(verified.status,'verified');assert.equal(verified.proposal.id,result.proposal.id);
 const cli=execFileSync(process.execPath,[path.join(supplier.root,'generator/generate-ci.mjs'),p.root,'--verify-commit',result.commit,'--runs-on','["ubuntu-latest"]','--workflows','["ci"]'],{encoding:'utf8'});
 assert.match(cli,/source parity:.*"status":"verified"/);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,runsOn:['ubuntu-latest'],workflows:['ci'],receiptCommit:result.commit,ref:'b'.repeat(40)}),{code:'generation-drift'});
 fs.writeFileSync(path.join(p.root,'untouched.txt'),'changed source');p.git(['add','.']);p.git(['commit','-qm','later input']);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,runsOn:['ubuntu-latest'],workflows:['ci'],receiptCommit:result.commit}),/source tree differs/);
 assert.equal(writes(p).filter(c=>c.url.endsWith('/pulls')).length,1);
});

for (const forgedPath of ['.github/workflows/ci.yml','untouched.txt']) test(`later build rejects forged receipt with altered ${forgedPath}`,async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
  'generator/retained-runner.mjs':fs.readFileSync(new URL('../generator/retained-runner.mjs',import.meta.url),'utf8'),
 });
 const module=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await module.receiveGeneratedCaller({root:p.root,repo,request:p.request,runsOn:['ubuntu-latest'],workflows:['ci']});
 p.git(['checkout','--detach',result.commit]);fs.writeFileSync(path.join(p.root,forgedPath),'altered bytes');p.git(['add','.']);
 const counterfeit=p.git(['commit-tree',p.git(['write-tree']),'-p',p.sourceCommit],p.git(['show','-s','--format=%B',result.commit]));
 p.git(['checkout','--detach',counterfeit]);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,runsOn:['ubuntu-latest'],workflows:['ci'],receiptCommit:counterfeit}),{code:'output-mismatch'});
});

test('independent: counterfeit manifest outputs cannot excuse altered committed output',async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
  'generator/retained-runner.mjs':fs.readFileSync(new URL('../generator/retained-runner.mjs',import.meta.url),'utf8'),
 });
 const module=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await module.receiveGeneratedCaller({root:p.root,repo,request:p.request,runsOn:['ubuntu-latest'],workflows:['ci']});
 p.git(['checkout','--detach',result.commit]);
 const altered='name: counterfeit\njobs: {}\n';fs.writeFileSync(path.join(p.root,'.github/workflows/ci.yml'),altered);p.git(['add','.']);
 const proposal=structuredClone(result.proposal);proposal.outputs[0].blob=p.git(['hash-object','--stdin'],altered);
 const forged=p.git(['commit-tree',p.git(['write-tree']),'-p',p.sourceCommit],`Forged\n\nGenerated-source identity: ${proposal.id}\n${JSON.stringify(proposal)}`);
 p.git(['checkout','--detach',forged]);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,runsOn:['ubuntu-latest'],workflows:['ci'],receiptCommit:forged}),{code:'output-mismatch'});
});

for (const [name, generated] of Object.entries({
  sync: { '.github/workflows/sync.yml': 'name: sync\non: workflow_dispatch\n' },
  release: { '.github/workflows/release.yml': 'name: release\non: workflow_dispatch\n', '.github/scripts/release.mjs': 'export const release = true;\n' },
})) test(`${name} caller receives with bounded tree proof and never enumerates unrelated archives`, async t => {
  const p = provider(t, { 'package.json': '{}\n', '.github/workflows/sync.yml': 'old\n', '.github/scripts/keep.mjs': 'retain\n',
    'archive/a/large.txt': 'unrelated archived body\n', 'source-binding.json': '{"immutable":"input"}\n' });
  const archived = p.git(['rev-parse', `${p.sourceCommit}:archive`]);
  p.state.before = (method, url) => { if (method === 'GET' && (url.includes('?recursive') || url.endsWith(archived))) throw new Error('archive enumeration unavailable'); };
  const result = await openPullRequest({ ...p.options, files: generated });
  assert.equal(result.status, 'proposed');
  assert.equal(p.git(['rev-parse', `${result.commit}:archive`]), archived);
  assert.equal(p.git(['show', `${result.commit}:.github/scripts/keep.mjs`]), 'retain');
  assert.equal(p.git(['show', `${result.commit}:source-binding.json`]), '{"immutable":"input"}');
  const reads = p.state.calls.filter(c => c.method === 'GET' && c.url.includes('/git/trees/'));
  assert.equal(reads.length, name === 'sync' ? 6 : 8); // source + result ancestors, shared prefixes read once
});

for (const alteration of ['addition', 'deletion', 'mode', 'subtree']) test(`Merkle receiving rejects undeclared ${alteration} before publishing`, async t => {
  const p = provider(t, { 'untouched.txt': 'retain\n', 'archive/deep/value': 'original\n' });
  p.state.after = (method, url, body, result) => {
    if (method !== 'POST' || !url.endsWith('/git/trees')) return;
    const index = path.join(p.root, '.git', `altered-index-${alteration}`), env = { GIT_INDEX_FILE: index };
    try {
      p.git(['read-tree', result.sha], undefined, env);
      if (alteration === 'deletion') p.git(['update-index', '--force-remove', 'untouched.txt'], undefined, env);
      else {
        const file = alteration === 'addition' ? 'undeclared.txt' : alteration === 'mode' ? 'untouched.txt' : 'archive/deep/value';
        const blob = p.git(['hash-object', '-w', '--stdin'], alteration === 'mode' ? 'retain\n' : 'altered\n');
        p.git(['update-index', '--add', '--cacheinfo', `${alteration === 'mode' ? '100755' : '100644'},${blob},${file}`], undefined, env);
      }
      result.sha = p.git(['write-tree'], undefined, env);
    } finally { fs.rmSync(index, { force: true }); }
  };
  await assert.rejects(openPullRequest(p.options), { code: 'output-mismatch' });
  assert.equal(p.state.head, p.sourceCommit); assert.equal(p.state.pulls.length, 0);
});

for (const fault of ['missing-entry', 'truncated', 'wrong-sha']) test(`target immediate tree ${fault} is refused before commit or ref publication`, async t => {
  const p=provider(t); let target, observed=false;
  p.state.after=(method,url,body,result)=>{
    if(method==='POST'&&url.endsWith('/git/trees'))target=result.sha;
    if(method!=='GET'||!target||!url.endsWith(`/git/trees/${target}`))return;
    observed=true;
    if(fault==='missing-entry')result.tree.pop();
    if(fault==='truncated')result.truncated=true;
    if(fault==='wrong-sha')result.sha='f'.repeat(40);
  };
  await assert.rejects(openPullRequest(p.options),{code:'output-mismatch'});
  assert.equal(observed,true);
  assert.equal(writes(p).some(c=>c.url.endsWith('/git/commits')||c.url.includes('/git/refs')),false);
  assert.equal(p.state.head,p.sourceCommit);assert.equal(p.state.pulls.length,0);
});

for (const fault of ['missing-entry', 'wrong-sha', 'duplicate', 'recursive', 'mode']) test(`immediate tree ${fault} is rejected before source writes`, async t => {
  const p = provider(t);
  p.state.after = (method, url, body, result) => {
    if (method !== 'GET' || !url.includes('/git/trees/')) return;
    if (fault === 'missing-entry') result.tree.pop();
    if (fault === 'wrong-sha') result.sha = 'f'.repeat(40);
    if (fault === 'duplicate') result.tree.push(result.tree[0]);
    if (fault === 'recursive') result.tree[0].path = 'directory/nested';
    if (fault === 'mode') result.tree[0].mode = '040000';
  };
  await assert.rejects(openPullRequest(p.options), { code: 'invalid-tree' }); assert.equal(writes(p).length, 0);
});

test('source file, executable, directory and symlink output collisions fail closed', async t => {
  for (const variant of ['file-prefix', 'directory-output', 'executable', 'symlink', 'symlink-prefix']) {
    const p = provider(t, { 'package.json': '{}\n', 'source/file.txt': 'original\n' });
    let generated = { 'source/file.txt/generated': 'new' };
    if (variant === 'directory-output') generated = { source: 'new' };
    if (variant === 'executable') { p.git(['update-index', '--chmod=+x', 'source/file.txt']); generated = { 'source/file.txt': 'new' }; }
    if (variant.startsWith('symlink')) {
      fs.symlinkSync('source', path.join(p.root, 'linked')); p.git(['add', 'linked']);
      generated = { [variant === 'symlink' ? 'linked' : 'linked/generated']: 'new' };
    }
    const current = p.git(['commit-tree', p.git(['write-tree']), '-p', p.sourceCommit], 'typed source');
    p.state.head = current; p.state.base = current;
    await assert.rejects(openPullRequest({ ...p.options, sourceCommit: current, files: generated }), { code: 'unsupported-output' });
    assert.equal(writes(p).length, 0);
  }
});

test('tree reconstruction follows actual Git directory sorting and UTF-8 names', async t => {
  const p = provider(t, { 'a/file': 'before', 'a.c': 'retain', 'a-b': 'retain', 'é/file': 'retain', 'tree/file': 'before' });
  const result = await openPullRequest({ ...p.options, files: { 'a/new': 'added', 'tree/file': 'after', '🌲/new': 'unicode' } });
  assert.equal(result.status, 'proposed');
  assert.equal(p.git(['show', `${result.commit}:a.c`]), 'retain');
  assert.equal(p.git(['show', `${result.commit}:🌲/new`]), 'unicode');
});

test('structural planner rejects ambiguous declared output scope before reading', async () => {
  const output = path => ({ path, mode: '100644', blob: 'b'.repeat(40) });
  for (const outputs of [[output('a'), output('a/b')], [output('a/b'), output('a')], [output('a'), output('a')]]) {
    await assert.rejects(planGeneratedTree({ outputs }, { sourceTree: 'a'.repeat(40), readTree() { throw new Error('must not read'); } }), { code: 'invalid-output' });
  }
});

const retainedPath='.github/workflows/release.yml';
const retainedLabels=['self-hosted','Linux','X64','machine'];
const retainedRelease=`on: [push]\npermissions: {contents: read}\njobs:\n  release:\n    runs-on: [self-hosted, Linux, X64, machine]\n    steps: [{run: 'true'}]\n`;
const retainedDiagnostic=`  change-receiving:\n    permissions: {contents: read}\n    runs-on: [self-hosted, Linux, X64, machine]\n    steps: [{run: 'true'}]\n`;
function retainedProvider(t,{historical=retainedRelease,current=historical,proposed=current,extra={}}={}) {
 const p=provider(t,{[retainedPath]:historical,...extra}),H=p.sourceCommit;
 p.git(['commit','--allow-empty','-qm','unrelated current source']);
 if(current!==historical){fs.writeFileSync(path.join(p.root,retainedPath),current);p.git(['add',retainedPath]);p.git(['commit','-qm','current workflow']);}
 const S=p.git(['rev-parse','HEAD']);p.state.base=S;p.state.head=S;
 p.state.repository={id:1,visibility:'private',full_name:repo,default_branch:'main'};
 p.state.historicalRun={id:81,repository:p.state.repository,head_repository:p.state.repository,head_sha:H,head_branch:'main',path:retainedPath,run_attempt:1};
 p.state.historicalJobs={total_count:1,jobs:[{id:82,run_id:81,run_attempt:1,head_sha:H,name:'release',labels:retainedLabels,runner_id:21,runner_name:'existing',started_at:'2026-10-13T20:00:00Z',status:'completed',conclusion:'failure'}]};
 p.options={...p.options,sourceCommit:S,files:{[retainedPath]:proposed,'generated/helper.mjs':'export const received = true;\n'},runsOn:retainedLabels,retainedRunnerEvidence:[{path:retainedPath,runId:81,jobId:82}]};
 return {...p,H,S};
}
test('historical H differs from current S: authentic shared-tree proof receives an unchanged selector without online inventory',async t=>{
 const p=retainedProvider(t),result=await openPullRequest(p.options);
 assert.notEqual(p.H,p.S);assert.equal(result.status,'proposed');
 assert.equal(result.runnerReceiving.currentAvailability,'unknown');assert.equal(result.runnerReceiving.activationApproved,false);
 assert.equal(result.runnerReceiving.records[0].historical.sourceCommit,p.H);assert.equal(result.runnerReceiving.sourceCommit,p.S);
 assert.ok(!p.state.calls.some(c=>c.url.includes('/actions/runners')));
 assert.ok(p.state.calls.some(c=>c.url.endsWith('/git/commits/'+p.H)));
 assert.ok(p.state.calls.some(c=>c.url.endsWith('/git/commits/'+p.S)));
});
test('wrong historical owner is refused before graph reads or mutations',async t=>{
 const p=retainedProvider(t);p.state.historicalRun.head_repository={...p.state.repository,id:2};
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});
 assert.equal(writes(p).length,0);assert.ok(!p.state.calls.some(c=>c.url.includes('/git/')));
});
test('historical grants cannot restore permissions removed by current source',async t=>{
 const old=retainedRelease.replace('contents: read','contents: write');
 const p=retainedProvider(t,{historical:old,current:retainedRelease,proposed:old});
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});assert.equal(writes(p).length,0);
});
test('unknown historical jobs do not become source admission',async t=>{
 const p=retainedProvider(t);p.state.historicalJobs.total_count=2;
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});assert.equal(writes(p).length,0);
});
function ownerProjection(p) {
 const proposal=generatedSource(p.options);
 return {producer:inputs[0],sourceCommit:p.S,branch,proposalId:proposal.id,path:retainedPath,
  jobs:[{job:'change-receiving',fragment:{permissions:{contents:'read'},'runs-on':retainedLabels,steps:[{run:'true'}]}}]};
}
test('exact complete generated-source proposal binds its owning diagnostic fragment',async t=>{
 const p=retainedProvider(t,{proposed:retainedRelease+retainedDiagnostic});
 p.options.retainedRunnerEvidence[0].ownerProjection=ownerProjection(p);
 const result=await openPullRequest(p.options);assert.equal(result.status,'proposed');
 assert.equal(result.runnerReceiving.records[0].addedJobs[0].job,'change-receiving');
 assert.ok(result.runnerReceiving.records[0].triggerChanges);
});
for(const [name,change] of [
 ['source',d=>d.sourceCommit='b'.repeat(40)],['branch',d=>d.branch='review/other'],
 ['proposal',d=>d.proposalId='b'.repeat(64)],['producer',d=>d.producer={...d.producer,commit:'b'.repeat(40)}],
 ['workflow',d=>d.path='.github/workflows/other.yml'],['fragment',d=>d.jobs[0].fragment.steps[0].run='different'],
 ['extra descriptor',d=>d.jobs.push({...d.jobs[0],job:'other'})],
]) test(`owner projection rejects wrong ${name} before publication`,async t=>{
 const p=retainedProvider(t,{proposed:retainedRelease+retainedDiagnostic}),descriptor=ownerProjection(p);change(descriptor);
 p.options.retainedRunnerEvidence[0].ownerProjection=descriptor;
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});assert.equal(writes(p).length,0);
});
test('proposed diagnostic cannot excuse a historical-to-current permission change',async t=>{
 const p=retainedProvider(t,{historical:retainedRelease.replace('contents: read','contents: write'),current:retainedRelease,proposed:retainedRelease+retainedDiagnostic});
 p.options.retainedRunnerEvidence[0].ownerProjection=ownerProjection(p);
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});assert.equal(writes(p).length,0);
});
test('malformed immediate ancestor ID is refused before constructing another provider route',async t=>{
 const p=retainedProvider(t);p.state.after=(method,url,body,result)=>{if(url.includes('/git/trees/')){const entry=result.tree.find(e=>e.type==='tree');if(entry)entry.sha='../unrelated';}};
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});assert.equal(writes(p).length,0);
 assert.ok(!p.state.calls.some(c=>c.url.includes('unrelated')));
});
test('overlapping proposed local reusable callee is refused rather than checked at old bytes',async t=>{
 const child='.github/workflows/child.yml';
 const caller=`on: [push]\npermissions: {contents: read}\njobs:\n  release:\n    uses: ./${child}\n    with:\n      runs-on: '["self-hosted","Linux","X64","machine"]'\n`;
 const p=retainedProvider(t,{historical:caller,extra:{[child]:retainedRelease}});
 p.options.files[child]=retainedRelease.replace("run: 'true'","run: 'changed'");
 p.options.retainedRunnerEvidence.push({path:child,runId:81,jobId:82});
 await assert.rejects(openPullRequest(p.options),{code:'runner-evidence'});assert.equal(writes(p).length,0);
});
