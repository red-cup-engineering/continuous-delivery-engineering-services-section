// Pin advance engine (requirements 16, 19-22b). Run in a checkout of the repository
// whose gitlinks move. Writes nothing outside the workspace: the pull request body
// goes to .git/advance-body.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BOT_EMAIL = 'ci@users.noreply.github.com';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const gitRaw = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function githubSlug(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(url.replace(/\.git\/?$/, ''));
  return m && m[1];
}

// status is the GitHub compare status of pin...head: identical | ahead | behind | diverged | unknown.
// Only 'ahead' (the remote head descends from the pin) advances, so a pin is moved
// only where the remote head differs from it and a reconciliation is not owed.
export function plan(entries) {
  const out = { advance: [], diverged: [], unread: [], current: [] };
  for (const e of entries) {
    if (e.head && e.head === e.pin) out.current.push(e);
    else if (!e.head || !e.pin || !['ahead', 'behind', 'diverged'].includes(e.status)) out.unread.push(e);
    else if (e.status === 'ahead') out.advance.push(e);
    else out.diverged.push(e);
  }
  return out;
}

const short = s => (s || '').slice(0, 9);

export function renderBody({ advance, diverged, unread = [] }, note) {
  const lines = [];
  if (note) lines.push(note, '');
  if (advance.length) lines.push('Advanced:', ...advance.map(e => `- ${e.path}: ${short(e.pin)} -> ${short(e.head)}`), '');
  if (diverged.length) lines.push('Diverged, not advanced (reconcile first, requirement 16):',
    ...diverged.map(e => `- ${e.path}: pin ${short(e.pin)}, remote ${short(e.head)} (${e.status})`), '');
  if (unread.length) lines.push('Unread supplier observations; ancestry is unknown:',
    ...unread.map(e => `- ${e.path}: pin ${short(e.pin)}, remote ${short(e.head)} (${e.status})`), '');
  return lines.join('\n');
}

export function readEntries(cwd, { head, status, paths }) {
  const cfg = git(cwd, 'config', '--no-includes', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$');
  const rows=cfg.split('\n').filter(Boolean);
  if(paths!==undefined&&(!Array.isArray(paths)||!paths.length||new Set(paths).size!==paths.length||paths.some(p=>!rows.some(row=>row.slice(row.search(/\s/)).trim()===p))))throw new Error('explicit recorded supplier paths required');
  return rows.filter(line=>paths===undefined||paths.includes(line.slice(line.search(/\s/)).trim())).map(line => {
    const [key, p] = line.split(/\s+/);
    const name = key.slice('submodule.'.length, -'.path'.length);
    const get = k => { try { return git(cwd, 'config', '--no-includes', '-f', '.gitmodules', `submodule.${name}.${k}`); } catch { return ''; } };
    const url = get('url'), branch = get('branch');
    const pin = git(cwd, 'ls-tree', 'HEAD', p).split(/\s+/)[2] ?? '';
    const e = { path: p, url, branch, pin };
    e.head = head(url, branch || 'HEAD');
    e.status = !e.head || !pin ? 'unknown' : e.head !== pin ? status(url, pin, e.head) : 'identical';
    return e;
  });
}

// Git cannot compare unmaterialized supplier commits when merging parent trees.
// Resolve only the closed case: unchanged conflicting supplier definitions, three gitlink
// stages, and a proven ancestor chain. Every other conflict still needs review.
function supplierDefinitions(cwd, blob) {
  const sections = new Map();
  for (const record of gitRaw(cwd, 'config', '--no-includes', '--blob', blob, '-z', '--list').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\n');
    const key = separator < 0 ? record : record.slice(0, separator);
    const value = separator < 0 ? null : record.slice(separator + 1);
    const match = /^submodule\.(.+)\.([^.]+)$/.exec(key);
    if (!match) continue;
    const [, name, field] = match;
    if (!sections.has(name)) sections.set(name, new Map());
    const section = sections.get(name);
    if (!section.has(field)) section.set(field, []);
    section.get(field).push(value);
  }
  const paths = new Map();
  for (const [name, fields] of sections) {
    const declared = fields.get('path');
    if (!declared || declared.length !== 1 || typeof declared[0] !== 'string' || !declared[0]) throw new Error('ambiguous supplier path definition');
    const file = declared[0];
    if (paths.has(file)) throw new Error(`ambiguous supplier path: ${file}`);
    const identity = JSON.stringify([name, [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
    paths.set(file, { identity, urls: fields.get('url'), ambiguous: [...fields.values()].some(values => values.length !== 1 || typeof values[0] !== 'string') });
  }
  return paths;
}

function mergeSupplierDefinitions(cwd, base, ancestor) {
  const objects = ['HEAD', base, ancestor].map(ref => {
    const record = gitRaw(cwd, 'ls-tree', '-z', ref, '--', '.gitmodules');
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t\.gitmodules\0$/.exec(record);
    if (!match) throw new Error('supplier definitions missing or changed file kind');
    return { mode: match[1], blob: match[2] };
  });
  const index = /^(100644|100755) ([0-9a-f]{40}) 0\t\.gitmodules\0$/.exec(gitRaw(cwd, 'ls-files', '--stage', '-z', '--', '.gitmodules'));
  if (!index) throw new Error('supplier definitions are unresolved or changed file kind');
  objects.push({ mode: index[1], blob: index[2] });
  if (new Set(objects.map(o => o.mode)).size !== 1) throw new Error('supplier definitions changed file mode');
  return objects.map(o => supplierDefinitions(cwd, o.blob));
}

function receiveBase(cwd, base, status) {
  try { git(cwd, 'merge', '--no-edit', base); return; }
  catch (mergeError) {
    let mergeHead;
    try { mergeHead = git(cwd, 'rev-parse', '--verify', 'MERGE_HEAD'); }
    catch { throw mergeError; }
    try {
      if (mergeHead !== base) throw new Error('unexpected base merge identity');
      const ancestors = git(cwd, 'merge-base', '--all', 'HEAD', base).split('\n');
      if (ancestors.length !== 1) throw new Error('ambiguous base merge ancestry');
      const ancestor = ancestors[0];
      const conflicts = new Map();
      for (const record of gitRaw(cwd, 'ls-files', '--unmerged', '-z').split('\0').filter(Boolean)) {
        const match = /^(\d{6}) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/.exec(record);
        if (!match) throw new Error('unread base merge conflict');
        const [, mode, sha, stage, file] = match;
        if (!conflicts.has(file)) conflicts.set(file, new Map());
        conflicts.get(file).set(stage, { mode, sha });
      }
      if (!conflicts.size) throw mergeError;
      for (const [file, stages] of conflicts) if (stages.size !== 3 || [...stages.values()].some(e => e.mode !== '160000')) throw new Error(`non-gitlink base merge conflict: ${file}`);
      const definitions = mergeSupplierDefinitions(cwd, base, ancestor);
      const resolved = [];
      for (const [file, stages] of conflicts) {
        const original = stages.get('1').sha, ours = stages.get('2').sha, theirs = stages.get('3').sha;
        const source = gitRaw(cwd, 'ls-tree', '-z', ancestor, '--', file);
        if (source !== `160000 commit ${original}\t${file}\0`) throw new Error(`ambiguous original gitlink: ${file}`);
        // An unrelated clean addition is ordinary merge content. The supplier
        // at this exact conflicted path must retain its section name and every
        // configured value on both sides, the common base and the merge index.
        const suppliers = definitions.map(paths => paths.get(file));
        if (suppliers.some(s => !s)) throw new Error(`supplier definitions changed or removed: ${file}`);
        if (suppliers.some(s => s.ambiguous)) throw new Error(`ambiguous conflicting supplier values: ${file}`);
        if (new Set(suppliers.map(s => s.identity)).size !== 1) throw new Error(`supplier definitions changed for conflicting path: ${file}`);
        const urls = suppliers[0].urls;
        if (!urls || urls.length !== 1 || typeof urls[0] !== 'string' || !githubSlug(urls[0])) throw new Error(`unread conflicting supplier identity: ${file}`);
        const url = urls[0];
        const descends = (pin, head) => pin === head || status?.(url, pin, head) === 'ahead';
        if (!descends(original, ours) || !descends(original, theirs)) throw new Error(`unproven base gitlink ancestry: ${file}`);
        const relation = ours === theirs ? 'identical' : status?.(url, ours, theirs);
        const selected = relation === 'ahead' ? theirs : relation === 'behind' || (ours === theirs && relation === 'identical') ? ours : null;
        if (!selected) throw new Error(`unresolved base gitlink ancestry: ${file} (${relation || 'unknown'})`);
        resolved.push({ file, selected });
      }
      // Validate all conflicts before staging any resolution. Git's merge index
      // retains unrelated clean changes; neither parent is reset or rewritten.
      for (const { file, selected } of resolved) git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${selected},${file}`);
      if (gitRaw(cwd, 'ls-files', '--unmerged', '-z')) throw new Error('base merge still has unresolved entries');
      git(cwd, 'commit', '--no-edit');
    } catch (error) {
      git(cwd, 'merge', '--abort');
      throw error;
    }
  }
}

// Receive the existing branch and the checked-out base before observing pins.
// Every contributor's history is retained, including prior bot commits.
function prepare(cwd, { branch, remote = 'origin', status }) {
  git(cwd, 'check-ref-format', '--branch', branch);
  // Supplier checkouts need not be materialized: this operation owns parent
  // gitlinks, never the supplier's worktree. Staged gitlinks still count as dirt.
  if (git(cwd, 'diff', '--ignore-submodules=all', '--name-only') || git(cwd, 'diff', '--cached', '--name-only')) throw new Error('pin advance requires clean parent files and index');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'config', 'user.name', 'continuous-delivery-services-section');
  git(cwd, 'config', 'user.email', BOT_EMAIL);
  const remoteSha = git(cwd, 'ls-remote', '--heads', remote, `refs/heads/${branch}`).split(/\s/)[0];
  if (remoteSha) {
    git(cwd, 'fetch', '--no-recurse-submodules', '--no-tags', remote, `refs/heads/${branch}`);
    if (git(cwd, 'rev-parse', 'FETCH_HEAD') !== remoteSha) throw new Error('sync branch moved during observation; receive it again');
  }
  const foreign = remoteSha && git(cwd, 'log', '--format=%ae', `HEAD..${remoteSha}`).split('\n').some(a => a && a !== BOT_EMAIL);
  git(cwd, 'checkout', '-q', '-B', branch, remoteSha || base);
  if (remoteSha) receiveBase(cwd, base, status);
  return { foreign: !!foreign, remoteSha };
}

function pushAndReceive(cwd, branch, remote) {
  git(cwd, 'push', '--recurse-submodules=no', remote, `HEAD:refs/heads/${branch}`);
  const published = git(cwd, 'rev-parse', 'HEAD');
  const observed = git(cwd, 'ls-remote', '--heads', remote, `refs/heads/${branch}`).split(/\s/)[0];
  if (observed !== published) throw new Error('sync branch moved after publication; receive its current history before claiming success');
}

export function publish(cwd, { branch, advance, message = 'Advance submodules', remote = 'origin', prepared, status }) {
  const context = prepared ?? prepare(cwd, { branch, remote, status });
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

export function run(cwd, { branch, note = '', head, status, remote, paths }) {
  const definitions = fs.lstatSync(path.join(cwd, '.gitmodules'), { throwIfNoEntry: false });
  if (!definitions) return { result: 'no submodules' };
  if (!definitions.isFile()) throw new Error('supplier definitions changed file kind; regular source required');
  const prepared = prepare(cwd, { branch, remote, status });
  const p = plan(readEntries(cwd, { head, status, paths }));
  const body = renderBody(p, note);
  const bodyFile = path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'advance-body.md'));
  fs.writeFileSync(bodyFile, body);
  if (!p.advance.length) {
    if (prepared.remoteSha && git(cwd, 'rev-parse', 'HEAD') !== prepared.remoteSha) {
      pushAndReceive(cwd, branch, remote || 'origin');
      return { result: 'advanced', pushed: true, foreign: prepared.foreign, diverged: p.diverged, unread: p.unread, body, bodyFile };
    }
    return { result: 'nothing to advance', diverged: p.diverged, unread: p.unread, body };
  }
  return { result: 'advanced', ...publish(cwd, { branch, advance: p.advance, remote, prepared }), diverged: p.diverged, unread: p.unread, body, bodyFile };
}

// The second, single-commit page excludes changed files/patches. Its comparison
// metadata still describes BASE...HEAD, even when that commit page is empty.
// https://docs.github.com/en/rest/commits/commits#compare-two-commits
function comparisonStatus(value, endpoint, pin, head) {
  const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
  if (!value || value.url !== endpoint || value.base_commit?.sha !== pin ||
      !sha(value.merge_base_commit?.sha) ||
      !Array.isArray(value.commits) || value.commits.length > 1 || Object.hasOwn(value, 'files') ||
      ![value.ahead_by, value.behind_by, value.total_commits].every(n => Number.isSafeInteger(n) && n >= 0) ||
      value.total_commits !== value.ahead_by) return 'unknown';
  const ancestor = value.merge_base_commit.sha, ahead = value.ahead_by, behind = value.behind_by;
  if (value.status === 'identical' && pin === head && ancestor === pin && ahead === 0 && behind === 0) return 'identical';
  if (pin === head) return 'unknown';
  if (value.status === 'ahead' && ancestor === pin && ahead > 0 && behind === 0) return 'ahead';
  if (value.status === 'behind' && ancestor === head && ahead === 0 && behind > 0) return 'behind';
  if (value.status === 'diverged' && ancestor !== pin && ancestor !== head && ahead > 0 && behind > 0) return 'diverged';
  return 'unknown';
}

// Live dependencies: ls-remote for heads, the compare API for ancestry.
export function liveDeps(token) {
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
      if (!slug || typeof pin !== 'string' || typeof head !== 'string' ||
          !/^[0-9a-f]{40}$/.test(pin) || !/^[0-9a-f]{40}$/.test(head)) return 'unknown';
      const endpoint = `https://api.github.com/repos/${slug}/compare/${pin}...${head}`;
      try {
        const value=JSON.parse(execFileSync('gh',['api',
          'repos/'+slug+'/compare/'+pin+'...'+head+'?per_page=1&page=2'],{
          env:{...process.env,...(token?{GH_TOKEN:token}:{})},encoding:'utf8',timeout:30000,
          maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
        }));
        return comparisonStatus(value,endpoint,pin,head);
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
  const unresolved = (r.diverged?.length ?? 0) + (r.unread?.length ?? 0);
  if (unresolved) {
    console.error(`${unresolved} supplier pins remain unresolved (${r.unread?.length ?? 0} unread); sync receiving is incomplete`);
    process.exitCode = 1;
  }
}
