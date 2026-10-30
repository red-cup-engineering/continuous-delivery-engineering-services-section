// Resolver: brings a conflicted pull request up to date with its base so the lander
// can land it. The base is merged into the pull request's own branch in a disposable
// worktree; an agent resolves only the conflicted files, from the pull request's own
// change as its intent; the resolution is checked mechanically (no markers left, no
// file outside the conflict touched, a clean diff check) and pushed to the pull
// request's branch as a fast-forward. The resolver never lands anything: the lander
// tests the result as merged, so the agent that resolved never accepts its own work.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (cwd, args, env) => execFileSync('git', args,
  { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, args, env) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const lines = text => text.split('\n').filter(Boolean);

export function resolverIdentity(host = os.hostname()) {
  const email = `claude+resolver@${host}.561.group`;
  return { GIT_AUTHOR_NAME: 'Claude (resolver)', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Claude (resolver)', GIT_COMMITTER_EMAIL: email };
}

export function resolutionBrief({ pull, target, conflicts, base }) {
  return [
    `You are resolving merge conflicts in this git worktree. The branch of pull request #${pull.number} ("${pull.title}") is being brought up to date with \`${target}\`; \`git merge\` stopped with conflicts in:`,
    ...conflicts.map(f => `- ${f}`),
    '',
    `The pull request's own change is its intent. \`git diff ${base} HEAD -- <file>\` shows what the pull request changed; \`git diff ${base} MERGE_HEAD -- <file>\` shows what \`${target}\` changed since they diverged.`,
    pull.body ? `\nThe pull request's description:\n${pull.body.slice(0, 4000)}\n` : '',
    'Edit only the conflicted files listed above. Keep every change from both sides unless they truly contradict; where they do, keep the base branch\'s behavior and re-apply the pull request\'s intent on top of it. Remove every conflict marker. Do not stage, commit, push, or touch any other file. When done, stop.',
  ].join('\n');
}

export function claudeAgent(dir, brief, { timeoutMs = 20 * 60_000, model = 'sonnet' } = {}) {
  const r = spawnSync('claude', ['-p', brief, '--model', model, '--permission-mode', 'acceptEdits', '--no-session-persistence',
    '--strict-mcp-config', '--allowedTools', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
  { cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000) };
}

const MARKER = /^(<{7}|>{7}|={7})( |$)/m;

export function resolveConflict({ repo, pull, target, identity = resolverIdentity(), agent = claudeAgent }) {
  if (!pull.headRef) return { state: 'unresolved', reason: 'no-head-branch' };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-'));
  const dir = path.join(scratch, 'wt');
  let added = false;
  try {
    git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/resolver/target`, `+refs/heads/${pull.headRef}:refs/resolver/head`]);
    const head = git(repo, ['rev-parse', 'refs/resolver/head']);
    if (pull.head && head !== pull.head) return { state: 'unresolved', reason: 'head-moved', detail: `${pull.headRef} is at ${head}, not ${pull.head}` };
    const base = git(repo, ['merge-base', head, 'refs/resolver/target']);
    git(repo, ['worktree', 'add', '--quiet', '--detach', dir, head]);
    added = true;
    const merge = tryGit(dir, ['merge', '--no-ff', '--no-commit', 'refs/resolver/target'], identity);
    const conflicts = lines(git(dir, ['diff', '--name-only', '--diff-filter=U']));
    if (merge.ok || !conflicts.length) return { state: 'unresolved', reason: 'no-conflict', detail: merge.err };
    const before = new Set(lines(git(dir, ['diff', '--name-only'])));
    const run = agent(dir, resolutionBrief({ pull, target, conflicts, base }));
    const touched = lines(git(dir, ['diff', '--name-only'])).filter(f => !before.has(f) && !conflicts.includes(f));
    const untracked = lines(git(dir, ['ls-files', '--others', '--exclude-standard']));
    if (touched.length || untracked.length) return { state: 'unresolved', reason: 'outside-conflict', files: [...touched, ...untracked], agent: run.output };
    const marked = conflicts.filter(f => fs.existsSync(path.join(dir, f)) && MARKER.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    if (marked.length) return { state: 'unresolved', reason: 'markers-left', files: marked, agent: run.output };
    git(dir, ['add', '-A', '--', ...conflicts]);
    const check = tryGit(dir, ['diff', '--cached', '--check']);
    if (!check.ok) return { state: 'unresolved', reason: 'diff-check', detail: check.out.slice(-3000) };
    git(dir, ['commit', '--quiet', '--no-verify', '-m', `Merge ${target} into ${pull.headRef}, resolving ${conflicts.join(', ')}`], identity);
    const commit = git(dir, ['rev-parse', 'HEAD']);
    const push = tryGit(repo, ['push', '--quiet', 'origin', `${commit}:refs/heads/${pull.headRef}`]);
    if (!push.ok) return { state: 'unresolved', reason: 'push', detail: push.err };
    return { state: 'resolved', commit, conflicts };
  } finally {
    if (added) tryGit(repo, ['worktree', 'remove', '--force', dir]);
    for (const ref of ['refs/resolver/target', 'refs/resolver/head']) tryGit(repo, ['update-ref', '-d', ref]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
