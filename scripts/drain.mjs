// Drain: feed every open pull request through the lander (scripts/land.mjs), oldest
// first. A pull request is one channel of proposal (LD-2): its head ref is landed
// into its base branch, tested as merged, or refused with a comment naming exactly
// why. Drafts are landed like any other proposal, because agents open drafts by
// default and the gate, not the draft flag, decides what is fit for main; a title
// starting with HOLD is its author's explicit refusal and is left alone.
//
// Each pull request lands into its own repository's branch only. The parent
// gitlinks are advanced by the pin writer that already owns them, so a drain never
// becomes a second writer of the same pointer.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { landChangeSet, landerIdentity } from './land.mjs';
import { resolveConflict } from './resolve.mjs';

export function repositorySlug(url) {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Every checked-out repository mounted under root, by GitHub slug, read from each
// level's .gitmodules. The first mount found for a slug is used; later ones are
// reported, since one repository at two paths is a defect of the tree.
export function mountIndex(root) {
  const index = new Map();
  const duplicates = [];
  const queue = [path.resolve(root)];
  while (queue.length) {
    const dir = queue.shift();
    let origin = '';
    try { origin = git(dir, ['config', '--get', 'remote.origin.url']); } catch { /* no origin */ }
    const slug = repositorySlug(origin);
    if (slug) { if (index.has(slug)) duplicates.push({ slug, path: dir, first: index.get(slug) }); else index.set(slug, dir); }
    const modules = path.join(dir, '.gitmodules');
    if (!fs.existsSync(modules)) continue;
    let lines = [];
    try { lines = git(dir, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']).split('\n'); } catch { /* none */ }
    for (const line of lines) {
      const rel = line.slice(line.indexOf(' ') + 1);
      const child = path.join(dir, rel);
      if (rel && fs.existsSync(path.join(child, '.git'))) queue.push(child);
    }
  }
  return { index, duplicates };
}

export function planDrain(pulls) {
  const skipped = pulls.filter(p => /^\s*HOLD\b/i.test(p.title)).map(p => ({ ...p, skipped: 'hold' }));
  const queue = pulls.filter(p => !/^\s*HOLD\b/i.test(p.title))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug) || a.number - b.number);
  return { queue, skipped };
}

const gh = args => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

export function githubPulls(owners) {
  const repos = new Set();
  for (const owner of owners) {
    const found = JSON.parse(gh(['search', 'prs', '--state', 'open', '--owner', owner, '--limit', '1000', '--json', 'repository']));
    for (const p of found) repos.add(p.repository.nameWithOwner.toLowerCase());
  }
  const pulls = [];
  for (const slug of repos) {
    const lines = gh(['api', '--paginate', `repos/${slug}/pulls?state=open&per_page=100`, '--jq',
      '.[] | {number, title, body, draft, base: .base.ref, head: .head.sha, headRef: .head.ref, createdAt: .created_at, headRepository: .head.repo.full_name}']);
    for (const line of lines.split('\n').filter(Boolean)) {
      const p = JSON.parse(line);
      pulls.push({ slug, number: p.number, title: p.title, body: p.body, draft: p.draft, base: p.base, head: p.head,
        headRef: p.headRef, createdAt: p.createdAt, sameRepository: (p.headRepository || '').toLowerCase() === slug });
    }
  }
  return pulls;
}

const marker = (pull, result) => `<!-- lander ${pull.head} ${result.base || ''} -->`;

export function githubComment(pull, body, mark) {
  const prior = gh(['api', '--paginate', `repos/${pull.slug}/issues/${pull.number}/comments`, '--jq', '.[].body']);
  if (prior.includes(mark)) return false;
  const r = spawnSync('gh', ['pr', 'comment', String(pull.number), '--repo', pull.slug, '--body-file', '-'],
    { input: `${body}\n\n${mark}\n`, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh pr comment: ${(r.stderr || '').trim()}`);
  return true;
}

export function refusalComment(result) {
  const lines = ['The lander did not land this pull request.', ''];
  if (result.reason === 'conflict') lines.push(`It conflicts with \`${result.target}\` in:`, ...result.conflicts.map(f => `- \`${f}\``), '', 'Rebase or merge the base branch and push; the next drain lands it.');
  else if (result.reason === 'test') {
    lines.push(`\`${result.command}\` fails on the merge of this branch into \`${result.target}\`, with failures \`${result.target}\` does not have:`);
    lines.push(...(result.introduced?.length ? result.introduced.map(n => `- ${n}`) : ['- (the output names no test; see the log)']));
    lines.push('', '<details><summary>Log tail</summary>', '', '```', (result.log || '').slice(-6000), '```', '</details>');
  } else lines.push(`Reason: ${result.reason}.`, '', '```', String(result.detail || result.error || '').slice(-3000), '```');
  return lines.join('\n');
}

export function localRepository(slug, index, cacheDir) {
  if (index.has(slug)) return index.get(slug);
  const dir = path.join(cacheDir, slug);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '--quiet', `https://github.com/${slug}.git`, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return dir;
}

export function drain({ root, pulls, identity = landerIdentity(), cacheDir, dryRun = false, comment = githubComment,
  locate, resolve, onResult = () => {}, testTimeoutMs = 15 * 60_000 }) {
  const { index, duplicates } = mountIndex(root);
  const find = locate || (slug => localRepository(slug, index, cacheDir));
  const { queue, skipped } = planDrain(pulls);
  const results = skipped.map(p => ({ slug: p.slug, number: p.number, state: 'skipped', reason: p.skipped }));
  for (const r of results) onResult(r);
  for (const pull of queue) {
    let result;
    try {
      if (!pull.sameRepository && pull.sameRepository !== undefined) throw new Error('head is in another repository');
      const repo = find(pull.slug);
      const land = ref => ({ ...landChangeSet({ root: repo, target: pull.base, identity, dryRun, testTimeoutMs,
        proposals: [{ section: '.', remote: 'origin', ref }] }),
        base: git(repo, ['ls-remote', 'origin', `refs/heads/${pull.base}`]).split(/\s/)[0], target: pull.base });
      result = land(`refs/pull/${pull.number}/head`);
      // A conflict is brought up to date on the pull request's own branch, then landed
      // from that branch, since the forge's pull ref follows the push asynchronously.
      if (resolve && !dryRun && result.reason === 'conflict' && pull.headRef) {
        const resolution = resolve({ repo, pull, target: pull.base });
        result.resolution = resolution;
        if (resolution.state === 'resolved') result = { ...land(`refs/heads/${pull.headRef}`), resolution };
      }
    } catch (e) {
      result = { state: 'refused', reason: 'error', error: e.message.split('\n').slice(0, 5).join('\n'), target: pull.base };
    }
    const record = { slug: pull.slug, number: pull.number, draft: pull.draft, state: result.state, reason: result.reason,
      section: result.section, conflicts: result.conflicts, introduced: result.introduced, error: result.error,
      landed: result.landed, targetFailures: result.tested?.flatMap(t => t.targetFailures || []).length || undefined,
      resolution: result.resolution && { state: result.resolution.state, reason: result.resolution.reason, conflicts: result.resolution.conflicts, files: result.resolution.files, dropped: result.resolution.dropped } };
    if (!dryRun && result.state === 'landed' && result.resolution?.dropped?.length) {
      const body = ['The lander landed this pull request after bringing it up to date with its base. These changes of the pull request were not carried, because the base removed the files they changed:',
        ...result.resolution.dropped.map(d => `- \`${d.file}\`${d.deletedBy ? `, removed by ${d.deletedBy}` : ''}`),
        '', 'If that intent still holds, it belongs wherever those files went.'].join('\n');
      try { record.commented = comment(pull, body, `<!-- lander dropped ${result.resolution.commit} -->`); }
      catch (e) { record.commentError = e.message; }
    }
    if (!dryRun && ['refused', 'partial'].includes(result.state) && result.reason !== 'error') {
      try { record.commented = comment(pull, refusalComment(result), marker(pull, result)); }
      catch (e) { record.commentError = e.message; }
    }
    results.push(record);
    onResult(record);
  }
  return { results, duplicates };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
  const flag = name => { const i = args.indexOf(name); return i >= 0 && args.splice(i, 1).length > 0; };
  const root = opt('--root', process.cwd());
  const owners = opt('--owners', '561-group,red-cup-engineering,lenticule-science,causeway-services,coesite-operations').split(',');
  const only = opt('--repo');
  const limit = Number(opt('--limit', '0'));
  const cacheDir = opt('--cache', path.join(os.homedir(), '.cache', 'lander'));
  const dryRun = flag('--dry-run');
  const resolve = flag('--resolve') ? resolveConflict : undefined;
  let pulls = githubPulls(owners);
  if (only) pulls = pulls.filter(p => p.slug === only.toLowerCase());
  if (limit) pulls = planDrain(pulls).queue.slice(0, limit);
  const { results, duplicates } = drain({ root, pulls, cacheDir, dryRun, resolve, identity: landerIdentity(opt('--host')),
    onResult: r => console.log(JSON.stringify(r)) });
  for (const d of duplicates) console.error(JSON.stringify({ duplicateMount: d }));
  const count = s => results.filter(r => r.state === s).length;
  console.error(JSON.stringify({ landed: count('landed'), tested: count('tested'), refused: count('refused'), partial: count('partial'), skipped: count('skipped'), unchanged: count('unchanged') }));
}
