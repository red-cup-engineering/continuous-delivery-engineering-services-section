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
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(url.replace(/\.git\/?$/, ''));
  return m && m[1];
}

// status is the GitHub compare status of pin...head: identical | ahead | behind | diverged | unknown.
// Only 'ahead' (the remote head descends from the pin) advances, so a pin is moved
// only where the remote head differs from it and a reconciliation is not owed.
export function plan(entries) {
  const out = { advance: [], diverged: [], current: [] };
  for (const e of entries) {
    if (e.head && e.head === e.pin) out.current.push(e);
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
    e.status = !e.head || !pin ? 'unknown' : e.head !== pin ? status(url, pin, e.head) : 'identical';
    return e;
  });
}

// Receive the existing branch and the checked-out base before observing pins.
// Every contributor's history is retained, including prior bot commits.
function prepare(cwd, { branch, remote = 'origin' }) {
  git(cwd, 'check-ref-format', '--branch', branch);
  // Supplier checkouts need not be materialized: this operation owns parent
  // gitlinks, never the supplier's worktree. Staged gitlinks still count as dirt.
  if (git(cwd, 'diff', '--ignore-submodules=all', '--name-only') || git(cwd, 'diff', '--cached', '--name-only')) throw new Error('pin advance requires clean parent files and index');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'config', 'user.name', 'continuous-delivery-services-section');
  git(cwd, 'config', 'user.email', BOT_EMAIL);
  const remoteSha = git(cwd, 'ls-remote', '--heads', remote, `refs/heads/${branch}`).split(/\s/)[0];
  if (remoteSha) {
    git(cwd, 'fetch', remote, `refs/heads/${branch}`);
    if (git(cwd, 'rev-parse', 'FETCH_HEAD') !== remoteSha) throw new Error('sync branch moved during observation; receive it again');
  }
  const foreign = remoteSha && git(cwd, 'log', '--format=%ae', `HEAD..${remoteSha}`).split('\n').some(a => a && a !== BOT_EMAIL);
  git(cwd, 'checkout', '-q', '-B', branch, remoteSha || base);
  if (remoteSha) git(cwd, 'merge', '--no-edit', base);
  return { foreign: !!foreign, remoteSha };
}

function pushAndReceive(cwd, branch, remote) {
  git(cwd, 'push', remote, `HEAD:refs/heads/${branch}`);
  const published = git(cwd, 'rev-parse', 'HEAD');
  const observed = git(cwd, 'ls-remote', '--heads', remote, `refs/heads/${branch}`).split(/\s/)[0];
  if (observed !== published) throw new Error('sync branch moved after publication; receive its current history before claiming success');
}

export function publish(cwd, { branch, advance, message = 'Advance submodules', remote = 'origin', prepared }) {
  const context = prepared ?? prepare(cwd, { branch, remote });
  for (const e of advance) {
    const current = git(cwd, 'ls-tree', 'HEAD', '--', e.path).split(/\s+/)[2];
    if (current !== e.pin) throw new Error(`pin changed since observation: ${e.path}`);
    git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${e.head},${e.path}`);
  }
  const foreign = context.foreign;
  if (!git(cwd, 'diff', '--cached', '--name-only')) return { pushed: false, foreign: !!foreign };
  git(cwd, 'commit', '-q', '-m', message);
  pushAndReceive(cwd, branch, remote);
  return { pushed: true, foreign: !!foreign };
}

export function run(cwd, { branch, note = '', head, status, remote }) {
  if (!fs.existsSync(path.join(cwd, '.gitmodules'))) return { result: 'no submodules' };
  const prepared = prepare(cwd, { branch, remote });
  const p = plan(readEntries(cwd, { head, status }));
  const body = renderBody(p, note);
  const bodyFile = path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'advance-body.md'));
  fs.writeFileSync(bodyFile, body);
  if (!p.advance.length) {
    if (prepared.remoteSha && git(cwd, 'rev-parse', 'HEAD') !== prepared.remoteSha) {
      pushAndReceive(cwd, branch, remote || 'origin');
      return { result: 'advanced', pushed: true, foreign: prepared.foreign, diverged: p.diverged, body, bodyFile };
    }
    return { result: 'nothing to advance', diverged: p.diverged, body };
  }
  return { result: 'advanced', ...publish(cwd, { branch, advance: p.advance, remote, prepared }), diverged: p.diverged, body, bodyFile };
}

// Live dependencies: ls-remote for heads, the compare API for ancestry.
function liveDeps(token) {
  const environment = { ...process.env };
  if (token) {
    const count = Number(environment.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isSafeInteger(count) || count < 0 || count > 32) throw new Error('invalid inherited Git configuration count');
    // Checkout already supplies an Authorization header. Git's extraheader
    // is multivalued: reset it before selecting this request's authority.
    // Otherwise GitHub rejects every supplier with Duplicate header (HTTP 400).
    environment.GIT_CONFIG_COUNT = String(count + 2);
    environment[`GIT_CONFIG_KEY_${count}`] = 'http.https://github.com/.extraheader';
    environment[`GIT_CONFIG_VALUE_${count}`] = '';
    environment[`GIT_CONFIG_KEY_${count + 1}`] = 'http.https://github.com/.extraheader';
    environment[`GIT_CONFIG_VALUE_${count + 1}`] = `Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}`;
  }
  return {
    head: (url, ref) => {
      if (!githubSlug(url)) return '';
      const selectedRef = ref === 'HEAD' ? ref : `refs/heads/${ref}`;
      try { return execFileSync('git', ['ls-remote', '--', url, selectedRef], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0].split('\t')[0]; }
      catch { return ''; }
    },
    status: (url, pin, head) => {
      const slug = githubSlug(url);
      if (!slug || !pin) return 'unknown';
      try {
        return JSON.parse(execFileSync('curl', ['-fsS', '--config', '-', '-H', 'Accept: application/vnd.github+json',
          `https://api.github.com/repos/${slug}/compare/${pin}...${head}`], {
          input: `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        })).status;
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
  if (r.diverged?.length) {
    console.error(`${r.diverged.length} supplier pins remain unresolved; sync receiving is incomplete`);
    process.exitCode = 1;
  }
}
