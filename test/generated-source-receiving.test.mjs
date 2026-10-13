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
  const state = { head: sourceCommit, base: sourceCommit, pulls: [], calls: [], before: null, after: null };
  const treeResponse = sha => ({ sha, truncated: false, tree: git(['ls-tree', '-z', sha]).split('\0').filter(Boolean).map(row => {
    const [,mode,type,id,file] = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row); return { path:file, mode, type, sha:id };
  }) });
  const commitResponse = sha => ({ sha, tree:{ sha:git(['rev-parse',`${sha}^{tree}`]) }, parents:git(['show','-s','--format=%P',sha]).split(' ').filter(Boolean).map(sha=>({sha})), message:git(['show','-s','--format=%B',sha]) });
  const request = async (method,url,body) => {
    state.calls.push({method,url,body}); await state.before?.(method,url,body); let result;
    if (method==='GET' && url===`/repos/${repo}`) result={id:1,visibility:'public',full_name:repo,default_branch:'main'};
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
 const produced=generateFromSource(p.root,{runsOn:['ubuntu-latest']});assert.equal(produced.sourceCommit,p.sourceCommit);assert.deepEqual(produced.files,{});
 fs.symlinkSync('/does-not-exist',path.join(p.root,'linked'));p.git(['add','linked']);p.git(['commit','-qm','symlink']);assert.throws(()=>generateFromSource(p.root),/symlink/);
});
test('actual caller binds source and supplier, receives and verifies its regenerated bytes',async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
 });
 const {receiveGeneratedCaller}=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await receiveGeneratedCaller({root:p.root,repo,request:p.request});assert.equal(result.status,'proposed');
 assert.equal(result.proposal.sourceCommit,p.sourceCommit);assert.equal(result.proposal.inputs[0].commit,supplier.sourceCommit);
 assert.match(p.git(['show',`${result.commit}:.github/workflows/ci.yml`]),new RegExp(supplier.sourceCommit));assert.equal(result.proposal.outputs.length,1);
 const n=writes(p).length;assert.deepEqual(await receiveGeneratedCaller({root:p.root,repo,request:p.request}),result);assert.equal(writes(p).length,n);
});

test('later build consumes retained commit proposal, reruns the producer and rejects drift',async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
 });
 const module=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await module.receiveGeneratedCaller({root:p.root,repo,request:p.request});
 p.git(['checkout','--detach',result.commit]);
 const verified=await module.verifyGeneratedCaller({root:p.root,receiptCommit:result.commit});
 assert.equal(verified.status,'verified');assert.equal(verified.proposal.id,result.proposal.id);
 const cli=execFileSync(process.execPath,[path.join(supplier.root,'generator/generate-ci.mjs'),p.root,'--verify-commit',result.commit],{encoding:'utf8'});
 assert.match(cli,/source parity:.*"status":"verified"/);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,receiptCommit:result.commit,ref:'b'.repeat(40)}),{code:'generation-drift'});
 fs.writeFileSync(path.join(p.root,'untouched.txt'),'changed source');p.git(['add','.']);p.git(['commit','-qm','later input']);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,receiptCommit:result.commit}),/source tree differs/);
 assert.equal(writes(p).filter(c=>c.url.endsWith('/pulls')).length,1);
});

for (const forgedPath of ['.github/workflows/ci.yml','untouched.txt']) test(`later build rejects forged receipt with altered ${forgedPath}`,async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
 });
 const module=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await module.receiveGeneratedCaller({root:p.root,repo,request:p.request});
 p.git(['checkout','--detach',result.commit]);fs.writeFileSync(path.join(p.root,forgedPath),'altered bytes');p.git(['add','.']);
 const counterfeit=p.git(['commit-tree',p.git(['write-tree']),'-p',p.sourceCommit],p.git(['show','-s','--format=%B',result.commit]));
 p.git(['checkout','--detach',counterfeit]);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,receiptCommit:counterfeit}),{code:'output-mismatch'});
});

test('independent: counterfeit manifest outputs cannot excuse altered committed output',async t=>{
 const p=provider(t),supplier=provider(t,{
  'generator/generate-ci.mjs':fs.readFileSync(new URL('../generator/generate-ci.mjs',import.meta.url),'utf8'),
  'generator/open-pr.mjs':fs.readFileSync(new URL('../generator/open-pr.mjs',import.meta.url),'utf8'),
 });
 const module=await import(pathToFileURL(path.join(supplier.root,'generator/generate-ci.mjs')).href);
 const result=await module.receiveGeneratedCaller({root:p.root,repo,request:p.request});
 p.git(['checkout','--detach',result.commit]);
 const altered='name: counterfeit\njobs: {}\n';fs.writeFileSync(path.join(p.root,'.github/workflows/ci.yml'),altered);p.git(['add','.']);
 const proposal=structuredClone(result.proposal);proposal.outputs[0].blob=p.git(['hash-object','--stdin'],altered);
 const forged=p.git(['commit-tree',p.git(['write-tree']),'-p',p.sourceCommit],`Forged\n\nGenerated-source identity: ${proposal.id}\n${JSON.stringify(proposal)}`);
 p.git(['checkout','--detach',forged]);
 await assert.rejects(()=>module.verifyGeneratedCaller({root:p.root,receiptCommit:forged}),{code:'output-mismatch'});
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
