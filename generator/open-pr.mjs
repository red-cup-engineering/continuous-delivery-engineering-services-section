// Opens a pull request with the GitHub git-data API (blobs-free: tree entries carry
// content), without a clone. Never force-updates: an existing branch is extended.
export function githubRequest(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const r = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
}

/** Receive the actual repository runner binding before proposing callers. */
export async function receiveRunnerSelection({repo,runsOn,request}) {
  if(typeof repo!=='string'||!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)
      ||!Array.isArray(runsOn)||!runsOn.includes('self-hosted')
      ||runsOn.some(label=>typeof label!=='string'||!label.trim()))
    throw new Error('house workflow callers require an explicit repository and self-hosted runner labels');
  const observation=await request('GET',`/repos/${repo}/actions/runners?per_page=100`);
  if(!observation||!Number.isSafeInteger(observation.total_count)||!Array.isArray(observation.runners)
      ||observation.total_count!==observation.runners.length)
    throw new Error('repository runner observation is unavailable or incomplete');
  const runners=observation.runners.filter(runner=>runner.status==='online'
    &&runsOn.every(label=>runner.labels?.some(row=>row.name===label)));
  if(!runners.length)throw new Error(`no online registered house runner matches ${repo}; caller proposal held`);
  return {repository:repo,labels:runsOn,runnerIds:runners.map(runner=>runner.id),executed:false};
}

export async function openPullRequest({ repo, files, token, runsOn, branch = 'ci/caller-generator', title = 'Call the continuous-delivery services section', request = githubRequest(token) }) {
  if (!Object.keys(files).length) throw new Error('no files to commit');
  await receiveRunnerSelection({repo,runsOn,request});
  const { default_branch: base } = await request('GET', `/repos/${repo}`);
  const existing = await request('GET', `/repos/${repo}/git/ref/heads/${branch}`);
  const parent = (existing ?? await request('GET', `/repos/${repo}/git/ref/heads/${base}`)).object.sha;
  const parentCommit = await request('GET', `/repos/${repo}/git/commits/${parent}`);
  const tree = await request('POST', `/repos/${repo}/git/trees`, {
    base_tree: parentCommit.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
  });
  const commit = await request('POST', `/repos/${repo}/git/commits`, { message: title, tree: tree.sha, parents: [parent] });
  if (existing) await request('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  else await request('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  const open = await request('GET', `/repos/${repo}/pulls?head=${repo.split('/')[0]}:${branch}&state=open`);
  if (open?.length) return open[0].html_url;
  const pr = await request('POST', `/repos/${repo}/pulls`, {
    title, head: branch, base,
    body: 'Caller written by the continuous-delivery services section generator (requirements 17 and 18). Handwritten workflows are left in place until the receiving office confirms the reusable workflow covers them.',
  });
  return pr.html_url;
}
