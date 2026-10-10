// Pin advance engine (requirements 16, 19-22b). Run in a checkout of the repository
// whose gitlinks move. Writes nothing outside the workspace: the pull request body
// goes to .git/advance-body.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BOT_EMAIL = 'ci@users.noreply.github.com';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

export function githubSlug(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(url);
  return m && m[1];
}

// status is the GitHub compare status of pin...head: identical | ahead | behind | diverged | unknown.
// Only 'ahead' (the remote head descends from the pin) advances, so a pin is moved
// only where the remote head differs from it and a reconciliation is not owed.
export function plan(entries) {
  const out = { advance: [], diverged: [], current: [] };
  for (const e of entries) {
    if (!e.head || e.head === e.pin) out.current.push(e);
    else if (e.status === 'ahead') out.advance.push(e);
    else out.diverged.push(e);
  }
  return out;
}

const short = s => (s || '').slice(0, 9);

export function renderBody({ advance, diverged }, note) {
  const lines = [];
  if (note) lines.push(note, '');
  if (advance.length) lines.push('Advanced:', ...advance.map(e => `- ${e.path}: ${short(e.pin)} -> ${short(e.head)}`), '');
  if (diverged.length) lines.push('Diverged, not advanced (reconcile first, requirement 16):',
    ...diverged.map(e => `- ${e.path}: pin ${short(e.pin)}, remote ${short(e.head)} (${e.status})`), '');
  return lines.join('\n');
}

export function readEntries(cwd, { head, status }) {
  const cfg = git(cwd, 'config', '-f', '.gitmodules', '--get-regexp', '\\.path$');
  return cfg.split('\n').filter(Boolean).map(line => {
    const [key, p] = line.split(/\s+/);
    const name = key.slice('submodule.'.length, -'.path'.length);
    const get = k => { try { return git(cwd, 'config', '-f', '.gitmodules', `submodule.${name}.${k}`); } catch { return ''; } };
    const url = get('url'), branch = get('branch');
    const pin = git(cwd, 'ls-tree', 'HEAD', p).split(/\s+/)[2] ?? '';
    const e = { path: p, url, branch, pin };
    e.head = head(url, branch || 'HEAD');
    e.status = e.head && e.head !== pin ? status(url, pin, e.head) : 'identical';
    return e;
  });
}

// Commit the new pins without losing a reviewer's work. A branch that carries a
// commit by anyone but the bot is extended by fast-forward, never replaced.
export function publish(cwd, { branch, advance, message = 'Advance submodules', remote = 'origin' }) {
  git(cwd, 'config', 'user.name', 'continuous-delivery-services-section');
  git(cwd, 'config', 'user.email', BOT_EMAIL);
  let remoteSha = '';
  try { git(cwd, 'fetch', remote, branch); remoteSha = git(cwd, 'rev-parse', 'FETCH_HEAD'); } catch { /* branch absent */ }
  const foreign = remoteSha && git(cwd, 'log', '--format=%ae', `HEAD..${remoteSha}`).split('\n').some(a => a && a !== BOT_EMAIL);
  git(cwd, 'checkout', '-q', '-B', branch, foreign ? remoteSha : 'HEAD');
  for (const e of advance) git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${e.head},${e.path}`);
  if (!git(cwd, 'diff', '--cached', '--name-only')) return { pushed: false, foreign: !!foreign };
  git(cwd, 'commit', '-q', '-m', message);
  if (!remoteSha || foreign) git(cwd, 'push', remote, `${branch}:${branch}`);
  else git(cwd, 'push', `--force-with-lease=${branch}:${remoteSha}`, remote, `${branch}:${branch}`);
  return { pushed: true, foreign: !!foreign };
}

export function run(cwd, { branch, note = '', head, status, remote }) {
  if (!fs.existsSync(path.join(cwd, '.gitmodules'))) return { result: 'no submodules' };
  const p = plan(readEntries(cwd, { head, status }));
  const body = renderBody(p, note);
  const bodyFile = path.join(cwd, '.git', 'advance-body.md');
  fs.writeFileSync(bodyFile, body);
  if (!p.advance.length) return { result: 'nothing to advance', diverged: p.diverged, body };
  return { result: 'advanced', ...publish(cwd, { branch, advance: p.advance, remote }), diverged: p.diverged, body, bodyFile };
}

// Live dependencies: ls-remote for heads, the compare API for ancestry.
function liveDeps(token) {
  const auth = token ? ['-c', `http.extraheader=Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}`] : [];
  return {
    head: (url, ref) => execFileSync('git', [...auth, 'ls-remote', url, ref], { encoding: 'utf8' }).split('\n')[0].split('\t')[0],
    status: (url, pin, head) => {
      const slug = githubSlug(url);
      if (!slug || !pin) return 'unknown';
      try {
        return JSON.parse(execFileSync('curl', ['-fsS', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json',
          `https://api.github.com/repos/${slug}/compare/${pin}...${head}`], { encoding: 'utf8' })).status;
      } catch { return 'unknown'; }
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (n, d = '') => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
  const r = run(process.cwd(), { branch: opt('--branch', 'ci/submodule-advance'), note: opt('--note'), ...liveDeps(process.env.GH_TOKEN) });
  console.log(r.result);
  if (r.body && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, r.body + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `advanced=${r.result === 'advanced' && r.pushed}\n`);
}
