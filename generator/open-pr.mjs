// CD's existing generator source receiver: exact bytes into source review only.
// No merge, deployment, authority grant, artifact execution or build-guard waiver.
import { createHash } from 'node:crypto';
import { qualifyRetainedRunnerSelection } from './retained-runner.mjs';
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const repoName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const branchName = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)
  && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
  && value.split('/').every(p => !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
const sourcePath = value => typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
// Unchanged Git source can contain POSIX names that portable generated outputs
// cannot use. Preserve their object identities without publishing new such paths.
const trackedPath = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
  && value.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const required = (value, label) => value ?? fail('unavailable', `${label} unavailable; no receiving claim`);

export function githubRequest(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token.trim()) fail('missing-actuator', 'source proposal needs an already authorized GitHub write actuator');
  return async (method, path, body) => {
    const r = await fetchImpl(`https://api.github.com${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (method === 'GET' && r.status === 404) return null;
    if (!r.ok) fail('github-error', `${method} ${path}: HTTP ${r.status}`);
    return r.json();
  };
}

/** Inputs name immutable suppliers, not authority or semantic proof. Outputs are
 * regular UTF-8 source only: no deletions, binary transcoding or mode changes. */
export function generatedSource({ repo, branch = 'ci/caller-generator', sourceCommit, inputs, files }) {
  if (!repoName(repo) || !branchName(branch) || !sha(sourceCommit)) fail('invalid-source', 'generated source needs its repository, review branch and exact source commit');
  if (!Array.isArray(inputs) || !inputs.length) fail('invalid-inputs', 'generation needs exact supplier input identities');
  const suppliers = inputs.map(input => {
    if (!repoName(input.repository) || !sha(input.commit)) fail('invalid-inputs', 'generation supplier needs a repository and exact commit');
    return { repository: input.repository, commit: input.commit };
  }).sort((a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0);
  if (new Set(suppliers.map(i => i.repository)).size !== suppliers.length) fail('invalid-inputs', 'generation suppliers must be unique');
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) fail('invalid-output', 'no generated files to receive');
  const outputs = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, content]) => {
    if (!sourcePath(path) || typeof content !== 'string' || !content.isWellFormed()) fail('invalid-output', `invalid UTF-8 generated source: ${path}`);
    const bytes = Buffer.from(content, 'utf8');
    return { path, mode: '100644', bytes: bytes.length, sha256: hash('sha256', bytes),
      blob: hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])) };
  });
  for (let i = 1; i < outputs.length; i++) if (outputs[i].path.startsWith(outputs[i - 1].path + '/')) fail('invalid-output', 'generated output file/directory collision');
  const identity = { repo, branch, sourceCommit, inputs: suppliers, outputs };
  return { ...identity, id: hash('sha256', JSON.stringify(identity)) };
}

/** Later-build byte/supplier parity, separate from independent review. */
export function verifyGeneratedSource(proposal, { files, inputs }) {
  const actual = generatedSource({ ...proposal, files, inputs });
  if (actual.id !== proposal.id) fail('generation-drift', 'regenerated source or suppliers differ from the received proposal');
  return actual;
}

function entries(response) {
  if (!response || response.truncated !== false || !Array.isArray(response.tree)) fail('incomplete-tree', 'complete source tree required');
  const leaves = new Map();
  for (const e of response.tree) {
    if (!trackedPath(e.path) || !sha(e.sha)) fail('invalid-tree', 'invalid source tree entry');
    if (e.type === 'tree') continue;
    if (leaves.has(e.path)) fail('invalid-tree', 'duplicate source tree path');
    leaves.set(e.path, { mode: e.mode, type: e.type, sha: e.sha });
  }
  return leaves;
}
const sameTree = (a, b) => a.size === b.size && [...a].every(([path, e]) => {
  const other = b.get(path); return other && e.sha === other.sha && e.mode === other.mode && e.type === other.type;
});

function expectedTree(proposal, before) {
  const expected = new Map(before);
  for (const output of proposal.outputs) {
    const prior = before.get(output.path);
    if (prior && (prior.type !== 'blob' || prior.mode !== output.mode)) fail('unsupported-output', `generated source changes file kind or mode: ${output.path}`);
    for (const path of before.keys()) if (path.startsWith(output.path + '/') || output.path.startsWith(path + '/')) fail('unsupported-output', 'generated source conflicts with an existing file or directory');
    expected.set(output.path, { mode: output.mode, type: 'blob', sha: output.blob });
  }
  return expected;
}

/** Verify every changed leaf, including unrelated files that must stay fixed. */
export function verifyGeneratedTransformation(proposal, sourceTree, receivedTree) {
  if (!sameTree(expectedTree(proposal, entries(sourceTree)), entries(receivedTree))) fail('output-mismatch', 'received source tree differs from the complete generated transformation');
  return true;
}

/** Large owners use the same complete transformation contract through shared Git frames. */
export async function verifyGeneratedTreeFrames(proposal,sourceTree,targetTree,readTree,{deriveTreePatch,proveTreePatch}={}) {
  return (await planGeneratedTree(proposal,{sourceTree,readTree,deriveTreePatch,proveTreePatch})).prove(targetTree);
}

/** Receive a configured no-billing runner before proposing workflow callers. */
export async function receiveRunnerSelection({repo,runsOn,request,repositoryRecord}) {
  if(typeof repo!=='string'||!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)
      ||!Array.isArray(runsOn)||!runsOn.length||runsOn.some(label=>typeof label!=='string'||!label.trim()))
    throw new Error('workflow callers require an explicit repository and runner labels');
  const owner=repositoryRecord??await request('GET',`/repos/${repo}`);
  if(owner?.full_name!==repo||!Number.isSafeInteger(owner.id))throw new Error('runner repository identity differs');
  // Standard Ubuntu execution is free for an explicitly observed public repository.
  // A private caller never inherits the public supplier's execution entitlement.
  if(owner.visibility==='public'&&runsOn.length===1&&runsOn[0]==='ubuntu-latest')
    return {repository:repo,labels:runsOn,execution:'public-standard',billingActivation:false,executed:false};
  if(!runsOn.includes('self-hosted'))throw new Error('private workflow callers require registered house runner labels');
  const observation=await request('GET',`/repos/${repo}/actions/runners?per_page=100`);
  if(!observation||!Number.isSafeInteger(observation.total_count)||!Array.isArray(observation.runners)
      ||observation.total_count!==observation.runners.length)
    throw new Error('repository runner observation is unavailable or incomplete');
  const runners=observation.runners.filter(runner=>runner.status==='online'
    &&runsOn.every(label=>runner.labels?.some(row=>row.name===label)));
  if(!runners.length)throw new Error(`no online registered house runner matches ${repo}; caller proposal held`);
  return {repository:repo,labels:runsOn,runnerIds:runners.map(runner=>runner.id),billingActivation:false,executed:false};
}

/** Shared Git owns canonical object encoding and full transformation proof. */
export async function planGeneratedTree(proposal,{sourceTree,readTree,deriveTreePatch,proveTreePatch}) {
  const shared=deriveTreePatch&&proveTreePatch?null:await import('@red-cup-engineering/git-services-section/source-tree-patch');
  const derive=deriveTreePatch??shared.deriveSourceTreePatch, prove=proveTreePatch??shared.proveSourceTreePatch;
  const frames=new Map();
  const readFrame=async sha=>{
    if(!frames.has(sha)) {
      const frame=await readTree(sha);
      if(!frame||frame.truncated!==false||!Array.isArray(frame.tree)) fail('incomplete-tree','complete immediate source tree required');
      frames.set(sha,frame);
    }
    return frames.get(sha);
  };
  const request={sourceTree,readTree:readFrame,changes:proposal.outputs.map(output=>({path:output.path,mode:output.mode,type:'blob',sha:output.blob}))};
  let plan;
  try {plan=await derive(request);}
  catch(error) {
    if(error.code)throw error;
    if(/overlapping source changes/.test(error.message))fail('invalid-output',error.message);
    if(/source kind or mode changes|source path is obstructed/.test(error.message))fail('unsupported-output',error.message);
    fail('invalid-tree',error.message);
  }
  const receive=async targetTree=>{
    try {
      const proof=await prove({...request,targetTree});
      // Shared proof derives the expected root from source frames. Receive the
      // actual target frames too, by deriving the same leaves as an identity.
      const observed=await derive({...request,sourceTree:targetTree});
      if(observed.targetTree!==targetTree||observed.changedLeaves!==0)throw new Error('target source differs');
      return proof;
    } catch {fail('output-mismatch','received source tree differs from the complete generated transformation');}
  };
  return {sourceTree,tree:plan.targetTree,prove:receive,verify:async targetTree=>{await receive(targetTree);return true;}};
}

/** Publish from the exact generation base into the named review branch. GitHub
 * rejects a non-fast-forward race. Lost mutation replies are reconciled at the
 * original ref/PR. A repeat after restart is identified by its durable commit. */
export async function openPullRequest({ repo, files, sourceCommit, inputs, token, runsOn, retainedRunnerEvidence, branch = 'ci/caller-generator',
  title = 'Receive generated source', request = githubRequest(token), proveTreePatch, deriveTreePatch }) {
  const proposal = generatedSource({ repo, branch, sourceCommit, inputs, files });
  const prefix = `/repos/${repo}`;
  const repository = required(await request('GET', prefix), 'source repository');
  if (repository.full_name !== repo || !branchName(repository.default_branch)) fail('wrong-owner', 'source repository identity differs');
  let runnerReceiving;
  if(Object.keys(files).some(path=>path.startsWith('.github/workflows/')))
    runnerReceiving = retainedRunnerEvidence === undefined
      ? await receiveRunnerSelection({repo,runsOn,request,repositoryRecord:repository})
      : await qualifyRetainedRunnerSelection({repositoryRecord:repository,proposal,files,runsOn,evidence:retainedRunnerEvidence,request});
  else if(retainedRunnerEvidence !== undefined) fail('runner-evidence','runner evidence has no proposed workflow consumer');
  const base = repository.default_branch;
  if (branch === base) fail('protected-base', 'generated source requires a separate review branch');
  const refPath = `${prefix}/git/ref/heads/${branch}`;
  const readHead = async () => {
    const ref = await request('GET', refPath);
    if (ref === null) return null;
    if (!sha(ref?.object?.sha)) fail('invalid-ref', 'source review branch identity unavailable');
    return ref.object.sha;
  };
  const parent = required(await request('GET', `${prefix}/git/commits/${sourceCommit}`), 'generation source commit');
  if (parent.sha !== sourceCommit || !sha(parent.tree?.sha)) fail('wrong-source', 'generation source commit differs');
  const plan=await planGeneratedTree(proposal,{sourceTree:parent.tree.sha,
    readTree:sha=>request('GET',`${prefix}/git/trees/${sha}`),deriveTreePatch,proveTreePatch});
  const verifyTree=plan.verify;
  const head = await readHead();
  if (head === null) {
    const current = required(await request('GET', `${prefix}/git/ref/heads/${base}`), 'default source ref');
    if (current.object?.sha !== sourceCommit) fail('stale-base', 'generation base moved; regenerate from the current source');
  }
  const marker = `Generated-source identity: ${proposal.id}`;
  const receiveCommit = async commit => {
    const observed = required(await request('GET', `${prefix}/git/commits/${commit}`), 'proposed commit');
    if (observed.sha !== commit || observed.parents?.length !== 1 || observed.parents[0].sha !== sourceCommit || !observed.message?.split('\n').includes(marker)) fail('stale-head', 'source review branch moved; regenerate from its exact current head');
    await verifyTree(observed.tree.sha);
    return observed.tree.sha;
  };
  let commit, tree;
  if (head !== null && head !== sourceCommit) {
    commit = head; tree = await receiveCommit(commit);
  } else if (plan.tree===parent.tree.sha) {
    return { status: 'unchanged', proposal, commit: sourceCommit, tree: parent.tree.sha, pullRequest: null, ...(runnerReceiving ? {runnerReceiving} : {}) };
  } else {
    const createdTree = required(await request('POST', `${prefix}/git/trees`, { base_tree: parent.tree.sha,
      tree: proposal.outputs.map(output => ({ path: output.path, mode: output.mode, type: 'blob', content: files[output.path] })) }), 'generated source tree');
    tree = createdTree.sha;
    if (!sha(tree))fail('output-mismatch','created tree identity is unavailable');
    await verifyTree(tree);
    const created = required(await request('POST', `${prefix}/git/commits`, {
      message: `${title}\n\n${marker}\n${JSON.stringify(proposal)}`, tree, parents: [sourceCommit],
    }), 'generated source commit');
    commit = created.sha;
    if (!sha(commit)) fail('invalid-commit', 'created source commit identity unavailable');
    await receiveCommit(commit);
    if (await readHead() !== head) fail('stale-head', 'source review branch changed during generation receiving');
    try {
      if (head === null) await request('POST', `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit });
      else await request('PATCH', `${prefix}/git/refs/heads/${branch}`, { sha: commit, force: false });
    } catch {
      if (await readHead() !== commit) fail('publication-unresolved', 'source ref publication unresolved; reconcile the original branch before retrying');
    }
    if (await readHead() !== commit) fail('publication-unresolved', 'published source ref differs; no receiving claim');
  }
  const pullPath = `${prefix}/pulls?head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&state=all&per_page=100`;
  const findPull = async () => {
    const pulls = required(await request('GET', pullPath), 'source pull requests');
    if (!Array.isArray(pulls) || pulls.length >= 100) fail('incomplete-pulls', 'complete bounded review history required');
    const matches = pulls.filter(p => p.head?.repo?.full_name === repo && p.head.ref === branch && p.base?.ref === base);
    if (matches.some(p => p.state !== 'open' && p.head.sha === commit)) fail('closed-review', 'this generated proposal already has a closed review; do not recreate it');
    const open = matches.filter(p => p.state === 'open');
    if (open.length > 1 || open.some(p => p.head.sha !== commit)) fail('review-mismatch', 'review head differs from received generated source');
    return open[0];
  };
  let pr = await findPull();
  if (!pr) {
    try {
      await request('POST', `${prefix}/pulls`, { title, head: branch, base, draft: true,
        body: `Generated source received by the continuous-delivery generator.\n\n${marker}\n\nSource base: ${sourceCommit}\nReceived commit: ${commit}\n\n${JSON.stringify(proposal, null, 2)}\n\nReview and later regeneration parity remain required. This is not a merge, successful release or runtime receipt.` });
    } catch {
      pr = await findPull();
      if (!pr) fail('review-unresolved', 'source branch retained; draft review creation unresolved, reconcile before retrying');
    }
    pr ??= await findPull();
  }
  if (!pr || !Number.isSafeInteger(pr.number) || pr.html_url !== `https://github.com/${repo}/pull/${pr.number}` || await readHead() !== commit) fail('review-unresolved', 'exact source review receiving not established');
  return { status: 'proposed', proposal, commit, tree, pullRequest: pr.html_url, ...(runnerReceiving ? {runnerReceiving} : {}) };
}

/**
 * Fleet receiver for a retired, pinned Continuous Delivery workflow.
 * Pinned callers survive the producer's mainline retirement; remove them
 * with bounded inventory, exact blob custody and independent readback.
 * Reuses the existing githubRequest(token) port and owns no credentials.
 */
export const RETIRED_BRANCH_INTAKE_PATH = '.github/workflows/agent-work-intake.yml';
const retiredIntakeBlobs = new Set([
  'ee077700dcdde1e71be3da2f8982c2ceae15b21e',
  '1acb8b98d60959a7a42260b24f5aa946741a3c54',
  '1788f2c08b0fe190bcd41770d85cef54171cd837',
]);
const fleetOrgs = new Set(['red-cup-engineering','lenticule-science','561-group','coesite-operations','causeway-services']);
// red-cup-engineering alone holds more than 800 repositories; the census stays complete up to this bound.
const fleetPages = 10;
const fleetConcurrency = 4;
const legacyIntake = text =>
  typeof text === 'string'
  && text.includes('name: Agent work\n')
  && text.includes('pull_request_target:')
  && text.includes("branches: ['**']")
  && /^    uses: red-cup-engineering\/continuous-delivery-services-section\/\.github\/workflows\/agent-work\.yml@[a-f0-9]{40}$/mu.test(text);

async function boundedFleetMap(items, worker) {
  let next = 0;
  const result = Array(items.length);
  await Promise.all(Array.from({length:Math.min(fleetConcurrency,items.length)}, async()=>{
    for(;;) {
      const i = next++;
      if(i>=items.length)break;
      result[i] = await worker(items[i]);
    }
  }));
  return result;
}

/** apply=false reads a complete token-visible census, apply=true deletes
 * only qualified legacy callers. Never retries an uncertain mutation. */
export async function reconcileRetiredIntakeFleet({organizations,apply=false,maxChanges=400}={}, {request}={}) {
  if(!Array.isArray(organizations)||organizations.length<1||organizations.length>fleetOrgs.size
    ||new Set(organizations).size!==organizations.length
    ||organizations.some(org=>!fleetOrgs.has(org))
    ||typeof apply!=='boolean'
    ||!Number.isSafeInteger(maxChanges)||maxChanges<1||maxChanges>400
    ||typeof request!=='function')throw new TypeError('exact fleet scope, bounded effect budget and authorized GitHub port required');
  const population=[];
  // Exhaust token-accessible org listings before any repository mutation.
  for(const org of organizations) {
    let completed=false;
    for(let page=1;page<=fleetPages+1;page++) {
      let rows;
      try {rows=await request('GET', '/orgs/'+org+'/repos?type=all&per_page=100&page='+page);}
      catch {throw new Error('fleet repository census unavailable: no mutations admitted');}
      if(!Array.isArray(rows)||rows.length>100)throw new Error('fleet repository enumeration malformed');
      if(page===fleetPages+1&&rows.length)throw new RangeError('fleet organization population exceeds complete '+fleetPages*100+'-repository bound');
      for(const row of rows) {
        if(!row||row.owner?.login!==org||row.full_name!==org+'/'+row.name
          ||!repoName(row.full_name)||!branchName(row.default_branch)
          ||!Number.isSafeInteger(row.id)||row.id<1)
          throw new Error('fleet repository identity or default branch unreadable');
        if(row.archived===true||row.disabled===true||row.fork===true)continue;
        population.push({repository:row.full_name,id:row.id,branch:row.default_branch});
      }
      if(rows.length<100){completed=true;break;}
    }
    if(!completed)throw new Error('fleet organization pagination incomplete');
  }
  const path=RETIRED_BRANCH_INTAKE_PATH;
  const observe=async item=>{
    const prefix='/repos/'+item.repository;
    const object=await request('GET',prefix+'/contents/'+path+'?ref='+encodeURIComponent(item.branch));
    if(object===null)return {...item,status:'absent'};
    if(object?.type!=='file'||object.path!==path||!sha(object.sha)
      ||object.encoding!=='base64'||typeof object.content!=='string')
      return {...item,status:'unrecognized'};
    if(!retiredIntakeBlobs.has(object.sha))return {...item,status:'unrecognized'};
    const bytes=Buffer.from(object.content.replace(/\s/g,''),'base64');
    const blob=hash('sha1',Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes]));
    if(blob!==object.sha||!legacyIntake(bytes.toString('utf8')))
      return {...item,status:'unrecognized'};
    const ref=await request('GET',prefix+'/git/ref/heads/'+encodeURIComponent(item.branch));
    if(ref?.ref!=='refs/heads/'+item.branch||!sha(ref.object?.sha))
      return {...item,status:'unread'};
    return {...item,status:'eligible',blob:object.sha,head:ref.object.sha};
  };
  const inspected=await boundedFleetMap(population,async item=>{
    try{return await observe(item);}
    catch{return {...item,status:'unread'};}
  });
  const eligible=inspected.filter(row=>row.status==='eligible');
  const counts={repositories:population.length,eligible:eligible.length,
    absent:inspected.filter(row=>row.status==='absent').length,
    unrecognized:inspected.filter(row=>row.status==='unrecognized').length,
    unread:inspected.filter(row=>row.status==='unread').length};
  if(eligible.length>maxChanges)throw new RangeError('fleet change count exceeds authorized batch bound');
  if(apply&&counts.unread)throw new Error('fleet preflight incomplete: no mutations admitted');
  if(!apply)return {kind:'cd.retired-intake-fleet',mode:'plan',credentialVisible:true,...counts,removed:0,refused:0,indeterminate:0};
  const results=await boundedFleetMap(eligible,async row=>{
    const prefix='/repos/'+row.repository;
    const refPath=prefix+'/git/ref/heads/'+encodeURIComponent(row.branch);
    const filePath=prefix+'/contents/'+path+'?ref='+encodeURIComponent(row.branch);
    let mutation;
    try {
      const before=await request('GET',refPath);
      if(before?.ref!=='refs/heads/'+row.branch||before.object?.sha!==row.head)
        return 'refused';
      mutation=await request('DELETE',prefix+'/contents/'+path,{
        message:'chore(forge): retire obsolete pinned automatic branch-to-PR intake',
        sha:row.blob,branch:row.branch,
      });
    } catch {return 'refused';}
    let received;
    try {received=await request('GET',filePath);}
    catch {return 'indeterminate';}
    if(received!==null)return 'refused';
    if(!sha(mutation?.commit?.sha))return 'indeterminate';
    return 'removed';
  });
  return {kind:'cd.retired-intake-fleet',mode:'apply',credentialVisible:true,...counts,
    removed:results.filter(x=>x==='removed').length,
    refused:results.filter(x=>x==='refused').length,
    indeterminate:results.filter(x=>x==='indeterminate').length};
}
