// CD's existing generator source receiver: exact bytes into source review only.
// No merge, deployment, authority grant, artifact execution or build-guard waiver.
import { createHash } from 'node:crypto';
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

/** Publish from the exact generation base into the named review branch. GitHub
 * rejects a non-fast-forward race. Lost mutation replies are reconciled at the
 * original ref/PR. A repeat after restart is identified by its durable commit. */
export async function openPullRequest({ repo, files, sourceCommit, inputs, token, runsOn, branch = 'ci/caller-generator',
  title = 'Receive generated source', request = githubRequest(token) }) {
  const proposal = generatedSource({ repo, branch, sourceCommit, inputs, files });
  const prefix = `/repos/${repo}`;
  const repository = required(await request('GET', prefix), 'source repository');
  if (repository.full_name !== repo || !branchName(repository.default_branch)) fail('wrong-owner', 'source repository identity differs');
  if(Object.keys(files).some(path=>path.startsWith('.github/workflows/')))
    await receiveRunnerSelection({repo,runsOn,request,repositoryRecord:repository});
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
  const before = entries(await request('GET', `${prefix}/git/trees/${parent.tree.sha}?recursive=1`));
  const expected = expectedTree(proposal, before);
  const head = await readHead();
  if (head === null) {
    const current = required(await request('GET', `${prefix}/git/ref/heads/${base}`), 'default source ref');
    if (current.object?.sha !== sourceCommit) fail('stale-base', 'generation base moved; regenerate from the current source');
  }
  const marker = `Generated-source identity: ${proposal.id}`;
  const receiveCommit = async commit => {
    const observed = required(await request('GET', `${prefix}/git/commits/${commit}`), 'proposed commit');
    if (observed.sha !== commit || observed.parents?.length !== 1 || observed.parents[0].sha !== sourceCommit || !observed.message?.split('\n').includes(marker)) fail('stale-head', 'source review branch moved; regenerate from its exact current head');
    if (!sameTree(expected, entries(await request('GET', `${prefix}/git/trees/${observed.tree.sha}?recursive=1`)))) fail('output-mismatch', 'published source tree differs from the complete generated transformation');
    return observed.tree.sha;
  };
  let commit, tree;
  if (head !== null && head !== sourceCommit) {
    commit = head; tree = await receiveCommit(commit);
  } else if (sameTree(before, expected)) {
    return { status: 'unchanged', proposal, commit: sourceCommit, tree: parent.tree.sha, pullRequest: null };
  } else {
    const createdTree = required(await request('POST', `${prefix}/git/trees`, { base_tree: parent.tree.sha,
      tree: proposal.outputs.map(output => ({ path: output.path, mode: output.mode, type: 'blob', content: files[output.path] })) }), 'generated source tree');
    tree = createdTree.sha;
    if (!sha(tree) || !sameTree(expected, entries(await request('GET', `${prefix}/git/trees/${tree}?recursive=1`)))) fail('output-mismatch', 'created tree differs from the complete generated transformation');
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
  return { status: 'proposed', proposal, commit, tree, pullRequest: pr.html_url };
}
