// Source-proposal evidence for an already exercised self-hosted selector.
// This never establishes current capacity, execution permission or job success.
import { parseDocument } from 'yaml';

const fail = message => { throw Object.assign(new Error(message), { code: 'runner-evidence' }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const oid = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const canonical = x => JSON.stringify(x, (_key, value) => object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const same = (a, b) => canonical(a) === canonical(b);
const workflowPath = p => typeof p === 'string' && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(p);

function labels(value) {
  if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== 'string' || !x.trim() || x.includes('${{'))
      || new Set(value).size !== value.length || !value.includes('self-hosted')) fail('exact static self-hosted selector required');
  return [...value].sort();
}
function inputLabels(value, inherited) {
  if (value === '${{ inputs.runs-on }}') value = inherited;
  if (typeof value !== 'string') fail('reusable runner input must be an explicit JSON array');
  let parsed; try { parsed = JSON.parse(value); } catch { fail('unresolved reusable runner input'); }
  labels(parsed); return value;
}
function workflow(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) fail('bounded workflow source required');
  const document = parseDocument(text, { uniqueKeys: true, merge: false });
  if (document.errors.length || document.warnings.length) fail('unambiguous workflow YAML required');
  let value; try { value = document.toJS({ maxAliasCount: 0 }); } catch { fail('workflow aliases are unsupported'); }
  if (!object(value) || !object(value.jobs) || !Object.keys(value.jobs).length) fail('workflow jobs are unavailable');
  return value;
}
function credentials(value) {
  if (!object(value)) return value ?? null;
  const observed = Object.fromEntries(Object.entries(value).filter(([key, val]) => /token|password|secret|credential|auth|private.?key/i.test(key)
    || canonical(val).includes('${{')));
  return Object.keys(observed).length ? observed : null;
}
function envelope(document, job) {
  for (const value of [document.permissions, job.permissions, job.environment, job.container, job.services])
    if (canonical(value)?.includes('${{')) fail('unresolved admission expression');
  const references = {};
  const visit = (value, path = '') => {
    if (typeof value === 'string' && /\$\{\{[^]*?(?:secrets\b|github\s*(?:\.|\[)[^]*?token)[^]*?\}\}/i.test(value)) references[path] = value;
    else if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}/${i}`));
    else if (object(value)) for (const [key, item] of Object.entries(value)) {
      const location = `${path}/${key}`;
      if (/token|password|secret|credential|auth|private.?key|ssh/i.test(key)) references[location] = item;
      visit(item, location);
    }
  };
  visit(job);
  for (const [index,step] of (job.steps ?? []).entries())
    if (typeof step?.uses === 'string' && /^actions\/checkout@/i.test(step.uses))
      references[`/steps/${index}/checkout-credential-admission`] = {
        action:step.uses.split('@')[0].toLowerCase(), persistence:step.with?.['persist-credentials'] ?? 'default',
      };
  return { workflowPermissions: document.permissions ?? null, permissions: job.permissions ?? null,
    workflowCallInputs: document.on?.workflow_call?.inputs ?? null,
    callInputs: job.uses === undefined ? null : job.with ?? null,
    workflowCallSecrets: document.on?.workflow_call?.secrets ?? null, credentialReferences: references,
    environment: job.environment ?? null, secrets: job.secrets ?? null,
    workflowCredentials: credentials(document.env), credentials: credentials(job.env),
    container: job.container ?? null, services: job.services ?? null };
}

/** Only the closed forms emitted by the owning sync/release generators. */
export async function inspectRunnerGraph({ repository, commit, path, content, runsOn, readWorkflow }) {
  const expected = labels(runsOn), nodes = new Map(), leaves = new Map(), revisions = new Map(), active = new Set(), activation = new Map(), fragments = new Map();
  async function visit(repo, ref, file, text, prefix, names, inherited, depth) {
    if (!oid(ref) || !workflowPath(file) || depth > 8 || nodes.size >= 64) fail('bounded immutable workflow graph required');
    const key = `${repo}@${ref}:${file}`;
    if (active.has(key)) fail('recursive workflow call graph');
    active.add(key); revisions.set(key, { repository: repo, commit: ref, path: file });
    const document = workflow(text);
    activation.set(prefix || '.', {on: document.on ?? null, concurrency: document.concurrency ?? null,
      jobs: Object.fromEntries(Object.entries(document.jobs).map(([id, job]) => [id, {if: job?.if ?? null, concurrency: job?.concurrency ?? null}]))});
    for (const [id, job] of Object.entries(document.jobs)) {
      if (nodes.size >= 64) fail('bounded immutable workflow graph required');
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) || !object(job) || job.strategy !== undefined) fail('static unambiguous jobs required');
      const structural = prefix ? `${prefix}/${id}` : id;
      const name = job.name ?? id;
      if (typeof name !== 'string' || !name || name.includes('${{') || name.includes(' / ')) fail('static unambiguous job name required');
      const display = [...names, name];
      const node = { envelope: envelope(document, job), supplier: null };
      fragments.set(structural, job);
      if (job.uses !== undefined) {
        if (job['runs-on'] !== undefined || job.steps !== undefined || typeof job.uses !== 'string') fail('ambiguous reusable job');
        let childRepo = repo, childRef = ref, childPath;
        const external = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([a-f0-9]{40})$/.exec(job.uses);
        if (external) [, childRepo, childPath, childRef] = external;
        else if (job.uses.startsWith('./') && workflowPath(job.uses.slice(2))) childPath = job.uses.slice(2);
        else fail('immutable existing workflow supplier required');
        const selected = inputLabels(job.with?.['runs-on'], inherited);
        if (!same(labels(JSON.parse(selected)), expected)) fail('reusable selector differs from retained runner selection');
        node.supplier = { repository: childRepo, path: childPath };
        nodes.set(structural, node);
        await visit(childRepo, childRef, childPath, await readWorkflow(childRepo, childRef, childPath), structural, display, selected, depth + 1);
      } else {
        let selected = job['runs-on'];
        if (selected === '${{ fromJSON(inputs.runs-on) }}') {
          try { selected = JSON.parse(inherited); } catch { fail('unbound leaf runner input'); }
        }
        if (!same(labels(selected), expected)) fail('job selector differs from retained runner selection');
        const displayName = display.join(' / ');
        if ([...leaves.values()].some(leaf => leaf.name === displayName)) fail('ambiguous historical job name');
        leaves.set(structural, { name: displayName, labels: expected });
        nodes.set(structural, node);
      }
    }
    active.delete(key);
    return document;
  }
  const root = await visit(repository, commit, path, content, '', [], undefined, 0);
  return { nodes, leaves, revisions: [...revisions.values()], events: root.on, activation, fragments };
}

function historicalIdentity({owner, path, runId, run}) {
  if (!Number.isSafeInteger(owner?.id) || owner.id < 1 || typeof owner.full_name !== 'string'
      || !Number.isSafeInteger(runId) || runId < 1 || run?.id !== runId || !oid(run.head_sha)
      || run.head_branch !== owner.default_branch || run.path !== path
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || ![run.repository, run.head_repository].every(r => r?.id === owner.id && r.full_name === owner.full_name)) fail('historical run identity differs');
  return run.head_sha;
}

/** Historical enrollment only; the scheduler must admit each later execution. */
export function verifyHistoricalRunner({ owner, sourceCommit, path, runId, jobId, run, jobs, graph, runsOn }) {
  historicalIdentity({owner, path, runId, run});
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(jobId) || jobId < 1
      || run?.id !== runId || run.head_sha !== sourceCommit || run.head_branch !== owner.default_branch || run.path !== path
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || ![run.repository, run.head_repository].every(r => r?.id === owner.id && r.full_name === owner.full_name)) fail('historical run identity differs');
  if (!jobs || !Array.isArray(jobs.jobs) || !Number.isSafeInteger(jobs.total_count) || jobs.total_count !== jobs.jobs.length
      || jobs.jobs.length > 100 || new Set(jobs.jobs.map(j => j.id)).size !== jobs.jobs.length) fail('complete bounded job observation required');
  const selected = jobs.jobs.filter(j => j.id === jobId);
  if (selected.length !== 1) fail('historical job is unavailable');
  const job = selected[0], matches = [...graph.leaves.entries()].filter(([, leaf]) => leaf.name === job.name);
  if (job.run_id !== runId || job.head_sha !== sourceCommit || job.run_attempt !== run.run_attempt
      || !Number.isSafeInteger(job.runner_id) || job.runner_id < 1 || typeof job.runner_name !== 'string' || !job.runner_name
      || !Number.isFinite(Date.parse(job.started_at)) || !['in_progress', 'completed'].includes(job.status)
      || matches.length !== 1 || !same(labels(job.labels), labels(runsOn))) fail('historical runner assignment differs');
  return { sourceCommit, run: runId, attempt: run.run_attempt, job: jobId, jobPath: matches[0][0], runnerId: job.runner_id,
    runnerName: job.runner_name, selector: labels(runsOn), currentAvailability: 'unknown', executedSuccessfully: false };
}

/** Existing job/call paths cannot silently exchange grants or suppliers. */
export function compareRetainedRunnerGraphs(before, after, { additions: qualified = [] } = {}) {
  for (const [path, prior] of before.nodes) {
    if (!after.nodes.has(path) || !same(prior, after.nodes.get(path))) fail(`runner admission declarations changed at ${path}`);
  }
  const additions = [...after.nodes.keys()].filter(path => !before.nodes.has(path));
  if (!Array.isArray(qualified) || qualified.length !== additions.length || new Set(qualified.map(e => e.job)).size !== qualified.length)
    fail('new workflow jobs require their exact owning projection');
  for (const path of additions) {
    const node = after.nodes.get(path), descriptor = qualified.find(e => e.job === path), e = node.envelope;
    if (path.includes('/') || node.supplier || !descriptor || !same(descriptor.fragment, after.fragments.get(path))
        || !same(e.permissions, {contents:'read'}) || !same(e.workflowPermissions, {contents:'read'})
        || e.environment !== null || e.secrets !== null || e.container !== null || e.services !== null
        || e.workflowCallSecrets !== null || e.workflowCallInputs !== null || e.callInputs !== null
        || Object.keys(e.workflowCredentials ?? {}).length || Object.keys(e.credentials ?? {}).length
        || Object.entries(e.credentialReferences).some(([key,value]) =>
          /^\/steps\/\d+\/checkout-credential-admission$/.test(key)
            ? !same(value,{action:'actions/checkout',persistence:false})
            : !/^\/steps\/\d+\/with\/persist-credentials$/.test(key) || value !== false))
      fail(`added job differs from bounded read-only owner projection: ${path}`);
    for (const step of descriptor.fragment.steps ?? [])
      if (typeof step?.uses === 'string' && /^actions\/checkout@/i.test(step.uses) && step.with?.['persist-credentials'] !== false)
        fail('added checkout must explicitly disable credential persistence');
  }
  const beforeActivation = Object.fromEntries(before.activation), afterActivation = Object.fromEntries(after.activation);
  return { triggerChanges: same(beforeActivation, afterActivation) ? null : { before: beforeActivation, after: afterActivation },
    addedJobs: qualified.map(e => ({job:e.job, producer:e.producer})),
    selectorRetained: true, currentAvailability: 'unknown', activationApproved: false };
}

/** Fetch committed workflow bytes through the shared Git object's proof. */
function committedWorkflowReader(request) {
  const commits = new Map(), frames = new Map(), blobs = new Map(), workflows = new Map();
  return async (repository, commit, path) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !oid(commit) || !workflowPath(path)) fail('exact workflow source identity required');
    const key = `${repository}@${commit}:${path}`;
    if (workflows.has(key)) return workflows.get(key);
    const prefix = `/repos/${repository}`, sourceKey = `${repository}@${commit}`;
    if (!commits.has(sourceKey)) commits.set(sourceKey, await request('GET', `${prefix}/git/commits/${commit}`));
    const source = commits.get(sourceKey);
    if (source?.sha !== commit || !oid(source.tree?.sha)) fail('workflow source commit differs');
    const readTree = async sha => {
      const key = `${repository}:${sha}`;
      if (!frames.has(key)) frames.set(key, await request('GET', `${prefix}/git/trees/${sha}`));
      return frames.get(key);
    };
    let tree = source.tree.sha, entry;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const frame = await readTree(tree);
      if (!frame || frame.truncated !== false || !Array.isArray(frame.tree)) fail('complete workflow path proof required');
      const matches = frame.tree.filter(row => row.path === parts[i]);
      if (matches.length !== 1) fail('workflow source path is absent or ambiguous');
      entry = matches[0];
      if (i < parts.length - 1) {
        if (entry.type !== 'tree' || entry.mode !== '040000' || !oid(entry.sha)) fail('workflow path changes source kind');
        tree = entry.sha;
      }
    }
    if (entry.type !== 'blob' || entry.mode !== '100644' || !oid(entry.sha)) fail('regular committed workflow required');
    const { deriveSourceTreePatch } = await import('@red-cup-engineering/git-services-section/source-tree-patch');
    const proof = await deriveSourceTreePatch({ sourceTree: source.tree.sha, readTree,
      changes: [{ path, mode: entry.mode, type: entry.type, sha: entry.sha }] });
    if (proof.targetTree !== source.tree.sha || proof.changedLeaves !== 0) fail('workflow path proof differs');
    const blobKey = `${repository}:${entry.sha}`;
    if (!blobs.has(blobKey)) blobs.set(blobKey, await request('GET', `${prefix}/git/blobs/${entry.sha}`));
    const blob = blobs.get(blobKey);
    if (blob?.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string'
        || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > 1024 * 1024) fail('bounded workflow blob required');
    const bytes = Buffer.from(blob.content, 'base64');
    const { gitBlobIdOf } = await import('@red-cup-engineering/git-services-section/git-object-id');
    if (bytes.length !== blob.size || gitBlobIdOf(bytes) !== entry.sha || !bytes.equals(Buffer.from(bytes.toString('utf8')))) fail('workflow blob identity differs');
    const text = bytes.toString('utf8'); workflows.set(key, text); return text;
  };
}

/** Explicit alternative source-proof input, never a fallback after denied reads.
 * The owning generator's independent source/trigger qualification must precede
 * publication. This function supplies no trigger or runtime approval. */
export async function qualifyRetainedRunnerSelection({ repositoryRecord: owner, proposal, files, runsOn, evidence, request }) {
  const {sourceCommit, inputs} = proposal;
  if (!owner || !Number.isSafeInteger(owner.id) || owner.id < 1 || owner.full_name !== proposal.repo || !oid(sourceCommit)) fail('exact owning source required');
  const paths = Object.keys(files).filter(workflowPath).sort();
  if (!Array.isArray(evidence) || !paths.length || evidence.length !== paths.length || evidence.length > 16
      || !same(evidence.map(e => e.path).sort(), paths)) fail('one historical observation per proposed workflow required');
  const readWorkflow = committedWorkflowReader(request), records = [];
  for (const item of evidence) {
    const { path, runId, jobId } = item;
    if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(jobId) || jobId < 1) fail('exact historical run and job required');
    const run = await request('GET', `/repos/${owner.full_name}/actions/runs/${runId}`);
    const historicalCommit = historicalIdentity({owner, path, runId, run});
    const history = await inspectRunnerGraph({ repository: owner.full_name, commit: historicalCommit, path,
      content: await readWorkflow(owner.full_name, historicalCommit, path), runsOn, readWorkflow });
    const before = await inspectRunnerGraph({ repository: owner.full_name, commit: sourceCommit, path,
      content: await readWorkflow(owner.full_name, sourceCommit, path), runsOn, readWorkflow });
    const after = await inspectRunnerGraph({ repository: owner.full_name, commit: sourceCommit, path,
      content: files[path], runsOn, readWorkflow: (repository,commit,callee) => {
        if (repository === owner.full_name && commit === sourceCommit && Object.hasOwn(files,callee))
          fail('overlapping proposed reusable callees require separate source qualification');
        return readWorkflow(repository,commit,callee);
      } });
    for (const revision of after.revisions) if (revision.repository !== owner.full_name
        && !inputs?.some(input => input.repository === revision.repository && input.commit === revision.commit)) fail('proposed reusable supplier is not an exact generation input');
    const historicalDeclarations = compareRetainedRunnerGraphs(history, before);
    const additions = item.ownerProjection?.jobs ?? [];
    if (item.ownerProjection !== undefined) {
      const projection = item.ownerProjection;
      if (!object(projection) || projection.sourceCommit !== sourceCommit || projection.branch !== proposal.branch
          || projection.proposalId !== proposal.id || projection.path !== path
          || !Array.isArray(additions) || !additions.length
          || !inputs.some(i => i.repository === projection.producer?.repository && i.commit === projection.producer?.commit))
        fail('owner projection identity differs from exact generated proposal');
    }
    const declarations = compareRetainedRunnerGraphs(before, after, {additions: additions.map(e=>({...e,producer:item.ownerProjection.producer}))});
    const jobs = await request('GET', `/repos/${owner.full_name}/actions/runs/${runId}/jobs?per_page=100`);
    const historical = verifyHistoricalRunner({ owner, sourceCommit:historicalCommit, path, runId, jobId, run, jobs, graph: history, runsOn });
    records.push({ path, historical, historicalDeclarations, ...declarations, historicalGraph: history.revisions,
      currentGraph: before.revisions, proposedGraph: after.revisions });
  }
  return { repository: owner.full_name, sourceCommit, execution: 'retained-self-hosted-source',
    billingActivation: false, currentAvailability: 'unknown', activationApproved: false, records };
}
