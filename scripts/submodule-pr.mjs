// Receive pin-only proposal metadata independently of whether this run pushed.
// The engine already qualifies complete base/head trees. This receiver binds
// those identities again to live refs and the one review, before and after I/O.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const branchName = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)
  && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
  && value.split('/').every(p => !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));

export function githubRequest(method, endpoint, body) {
  return JSON.parse(execFileSync('gh', ['api', '--method', method, endpoint.slice(1),
    ...(body === undefined ? [] : ['--input', '-'])], {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body),
    timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

export async function receiveSubmodulePull({ repo, base, proposal, request = githubRequest }) {
  const { branch, baseSha, headSha, body } = proposal ?? {};
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      !branchName(base) || !branchName(branch) || base === branch || !sha(baseSha) || !sha(headSha) || baseSha === headSha ||
      typeof body !== 'string' || !body.endsWith(`\nObserved base: ${baseSha}\nObserved head: ${headSha}\n`))
    throw new Error('exact pending pin proposal and destination required');
  const prefix = `/repos/${repo}`;
  const refs = async () => {
    for (const [name, expected] of [[base, baseSha], [branch, headSha]]) {
      const ref = await request('GET', `${prefix}/git/ref/heads/${encodeURIComponent(name)}`);
      if (ref?.ref !== `refs/heads/${name}` || ref.object?.type !== 'commit' || ref.object.sha !== expected)
        throw new Error(`source ref moved or unread: ${name}; recompute pending metadata`);
    }
  };
  const identity = pr => {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
        pr.html_url !== `https://github.com/${repo}/pull/${pr.number}` || pr.state !== 'open' ||
        pr.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo ||
        pr.head.ref !== branch || pr.base.ref !== base || pr.head.sha !== headSha || pr.base.sha !== baseSha)
      throw new Error('sync pull request identity differs from observed source');
    return pr;
  };
  const lookup = async () => {
    const pulls = await request('GET', `${prefix}/pulls?head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(base)}&state=open&per_page=2`);
    if (!Array.isArray(pulls) || pulls.length > 1) throw new Error('unread or ambiguous sync pull request');
    return pulls.length ? identity(pulls[0]) : null;
  };
  await refs();
  let pr = await lookup();
  await refs();
  if (pr?.body === body) {
    // The lookup can be stale by the time the ref reads finish, even when no
    // write is needed. Observe that exact review again before reporting receipt.
    pr = identity(await request('GET', `${prefix}/pulls/${pr.number}`));
    await refs();
    if (pr.body !== body) throw new Error('pending metadata changed during unchanged-body receiving');
    return { status: 'unchanged', pullRequest: pr.html_url, baseSha, headSha };
  }
  const prior = pr;
  let writeError;
  try {
    if (pr) await request('PATCH', `${prefix}/pulls/${pr.number}`, { body });
    else await request('POST', `${prefix}/pulls`, { base, head: branch, title: 'Advance submodules', body });
  } catch (error) { writeError = error; }
  // A missing write response is unknown, never a reason to create or replay.
  // Read the original destination once; a matching body plus exact refs is the
  // only success evidence, including a lost response to an accepted mutation.
  try {
    pr = prior ? identity(await request('GET', `${prefix}/pulls/${prior.number}`)) : await lookup();
    await refs();
    if (!pr || pr.body !== body) throw new Error('pending metadata body not received');
  } catch (error) {
    throw new Error(`sync metadata outcome unresolved; reconcile the original review before retrying: ${error.message}`, { cause: writeError ?? error });
  }
  return { status: writeError ? 'reconciled' : prior ? 'updated' : 'created', pullRequest: pr.html_url, baseSha, headSha };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = execFileSync('git', ['rev-parse', '--git-path', 'advance-proposal.json'], { encoding: 'utf8' }).trim();
  const result = await receiveSubmodulePull({ repo: process.env.GITHUB_REPOSITORY, base: process.env.BASE,
    proposal: JSON.parse(fs.readFileSync(file, 'utf8')) });
  console.log(`${result.status}: ${result.pullRequest}`);
}
