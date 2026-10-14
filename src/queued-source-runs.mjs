const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sourcePaths = new Set(['.github/workflows/ci.yml', '.github/workflows/agent-work-intake.yml']);

/** Retire source checks observed queued whose complete history is superseded.
 * Deployments, foreign source and unreceived history stay untouched. GitHub has
 * no conditional cancellation API; a check can start after the renewed read. */
export async function retireQueuedSourceRuns({repository, expectedDefault, execute = false}, {request, isAncestor, retain}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !oid(expectedDefault)
      || typeof execute !== 'boolean' || [request,isAncestor,retain].some(f => typeof f !== 'function'))
    throw new TypeError('exact repository/default, explicit effect mode and receiving operations required');
  const prefix = `/repos/${repository}`;
  const owner = await request('GET', prefix);
  if (owner.full_name !== repository || !Number.isSafeInteger(owner.id) || owner.archived)
    throw new Error('active repository identity required');
  const readDefault = async () => {
    const branch = await request('GET', `${prefix}/branches/${encodeURIComponent(owner.default_branch)}`);
    if (branch.commit?.sha !== expectedDefault) throw new Error('reviewed default source changed; reassess before cancellation');
  };
  await readDefault();
  const runs = [], ids = new Set(); let total;
  for (let page=1; page<=10; page++) {
    const response = await request('GET', `${prefix}/actions/runs?status=queued&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(response.total_count) || !Array.isArray(response.workflow_runs)
        || response.total_count > 1000 || (total !== undefined && total !== response.total_count))
      throw new Error('queued run observation is incomplete or changed during pagination');
    total = response.total_count;
    for (const run of response.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || ids.has(run.id)) throw new Error('queued run identities are ambiguous');
      ids.add(run.id); runs.push(run);
    }
    if (runs.length >= total) break;
    if (!response.workflow_runs.length) throw new Error('queued run observation stopped before completion');
  }
  if (runs.length !== total) throw new Error('queued run observation is incomplete');
  const receipt = {type:'SupersededSourceRunRetirement', repository, repositoryId:owner.id,
    defaultBranch:owner.default_branch, expectedDefault, execute, observedQueued:total,
    observedAt:new Date().toISOString(), runs:[], cancellationRequests:0, executionReceiving:false};
  const ancestry = new Map();
  for (const run of runs) {
    const row = {id:run.id, source:run.head_sha, workflow:run.path, state:'retained'};
    receipt.runs.push(row);
    if (run.status !== 'queued' || !['push','pull_request','pull_request_target'].includes(run.event)
        || !sourcePaths.has(run.path) || run.repository?.id !== owner.id
        || run.head_repository?.id !== owner.id || !oid(run.head_sha) || run.head_sha === expectedDefault) {
      row.reason = 'outside superseded owned source-check contract'; continue;
    }
    if (!ancestry.has(run.head_sha)) ancestry.set(run.head_sha, await isAncestor(run.head_sha, expectedDefault));
    if (ancestry.get(run.head_sha) !== true) {row.reason='source history unreceived or unavailable'; continue;}
    row.state='eligible'; row.reason='older complete source history retained in reviewed default';
  }
  await retain(receipt);
  if (!execute) return receipt;
  for (const row of receipt.runs.filter(row => row.state==='eligible')) {
    await readDefault();
    const current = await request('GET', `${prefix}/actions/runs/${row.id}`);
    if (current.id !== row.id || current.repository?.id !== owner.id || current.head_repository?.id !== owner.id
        || current.head_sha !== row.source || current.path !== row.workflow || current.status !== 'queued') {
      row.state='retained-after-renewal'; await retain(receipt); continue;
    }
    // Retain intent before the effect. A lost reply is followed at this same run;
    // no second cancellation is issued and success requires provider readback.
    row.state='cancellation-requested'; receipt.cancellationRequests++; await retain(receipt);
    try { await request('POST', `${prefix}/actions/runs/${row.id}/cancel`); }
    catch (error) {row.requestError=String(error.message).slice(0,1024);}
    receiveRun(row, await request('GET', `${prefix}/actions/runs/${row.id}`), owner.id);
    await retain(receipt);
  }
  return receipt;
}

function receiveRun(row, observed, repositoryId) {
  if (observed.id!==row.id || observed.head_sha!==row.source || observed.path!==row.workflow
      || observed.repository?.id!==repositoryId || observed.head_repository?.id!==repositoryId)
    throw new Error('cancellation readback identity differs from its retained operation');
  row.observedStatus=observed.status; row.observedConclusion=observed.conclusion;
  row.state=observed.status==='completed' && observed.conclusion==='cancelled'
    ? 'cancellation-received' : observed.status==='completed' ? 'completed-without-cancellation'
    : 'cancellation-pending-receiving';
}

/** Follow retained operations; never submit another cancellation. */
export async function receiveSourceRunRetirements(receipt, {request,retain}) {
  if (receipt?.type!=='SupersededSourceRunRetirement'
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(receipt.repository)
      || !Number.isSafeInteger(receipt.repositoryId) || !Array.isArray(receipt.runs) || receipt.runs.length>1000)
    throw new TypeError('bounded source-run retirement receipt required');
  const pending=receipt.runs.filter(row=>['cancellation-requested','cancellation-pending-receiving'].includes(row.state));
  for (const row of pending) {
    if(!Number.isSafeInteger(row.id)||row.id<1||!oid(row.source)||!sourcePaths.has(row.workflow))
      throw new TypeError('exact retained source-run identity required');
    receiveRun(row,await request('GET',`/repos/${receipt.repository}/actions/runs/${row.id}`),receipt.repositoryId);
    await retain(receipt);
  }
  return receipt;
}
