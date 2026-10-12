// The change test's one pull-request comment: every machine's verdict, kept in a single comment that each run
// updates in place (found by its marker), so a pull request carries the current reading and not a trail of them.
//   node change-test-comment.mjs RESULTS_DIR --expected PLAN_JSON --commit HEAD_SHA --repository OWNER/REPO \
//     --discovery success > comment.md                                           (render)
// Add --repo OWNER/REPO --pr N and GH_TOKEN to render and upsert. Unqualified reports exit nonzero.
// RESULTS_DIR holds one directory per machine leg, each with meta.json ({machine, machineCommit, id, commit, status})
// and verdict.json (the change test's output; absent or empty when it produced none) and log-tail.txt.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCommit, machineName, validatePlan } from './pinning-machines.mjs';

export const REPORT_AUTHOR = 'github-actions[bot]';
export const MARKER = '<!-- continuous-delivery-services-section: change-test -->';
const RANK = { regression: 4, 'not-composed': 3, incomplete: 2, 'not-run': 1, 'no-regression': 0 };

/** The worst verdict of RESULTS: one regression anywhere is a regression. */
export function overallVerdict(results) {
  if (!results.length) return 'not-run';
  return results.map((r) => !r.error && Object.hasOwn(RANK, r.verdict?.verdict) ? r.verdict.verdict : 'not-run').sort((a, b) => (RANK[b] ?? 1) - (RANK[a] ?? 1))[0];
}

const code = (text) => `\`${String(text).replaceAll('`', "'")}\``;
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 9) : '?');

function machineSection({ machine, machineCommit, commit, verdict, logTail, error }) {
  const lines = [`### ${machine} @ ${code(short(machineCommit))}: ${code(verdict?.verdict ?? 'not-run')}`];
  if (error) lines.push('', `Unqualified result: ${error}`);
  if (!verdict) {
    lines.push('', 'The change test produced no verdict. Last lines of its log:', '', '```', (logTail ?? '').slice(-2500), '```');
    return lines.join('\n');
  }
  lines.push('', `Commit ${code(short(commit))}; lock ${code(verdict.lock ?? '-')}; regressions **${verdict.regressions ?? 0}**.`);
  if (verdict.break) lines.push('', `Break: ${code(verdict.break.class ?? 'unclassified')}${verdict.reason ? ` - ${verdict.reason.slice(0, 600)}` : ''}`);
  const rows = (verdict.packages ?? []).filter((p) => p.status || p.regressions?.length || p.preexisting?.length);
  if (rows.length) {
    lines.push('', '| package | status | regressions | fails at base too |', '|---|---|---|---|');
    for (const p of rows) {
      lines.push(`| ${code(p.name)} | ${p.status ?? `${p.passed ?? '?'}/${p.tests ?? '?'} passed`} | ${(p.regressions ?? []).map(code).join('<br>') || '-'} | ${(p.preexisting ?? []).length} |`);
    }
  }
  const rules = verdict.designRules ?? {};
  if (rules.added?.length) lines.push('', `Design rules **added** (${rules.added.length}): ${rules.added.map((r) => code(r.key ?? r)).join(', ')}`);
  if (rules.removed?.length) lines.push('', `Design rules removed (${rules.removed.length}): ${rules.removed.map((r) => code(r.key ?? r)).join(', ')}`);
  if (rules.unread) lines.push('', `Design-rule deck unread: ${rules.unread}`);
  lines.push('', '<details><summary>verdict JSON</summary>', '', '```json', JSON.stringify(verdict, null, 2).slice(0, 20000), '```', '</details>');
  return lines.join('\n');
}

/** Only a successful, explicitly empty discovery can support a no-pins statement. */
export function provenEmpty(results, { none, expected, discovery } = {}) {
  return Boolean(none && discovery === 'success' && Array.isArray(expected) && expected.length === 0 && results.length === 0);
}

export function renderComment(results, options = {}) {
  const head = [MARKER, `## Change test: ${code(overallVerdict(results))}`];
  if (provenEmpty(results, options)) return [...head, '', `No candidate machine pins ${code(options.none)}, so there is nothing to test it against.`].join('\n') + '\n';
  return [...head, '', ...results.flatMap((r) => [machineSection(r), ''])].join('\n');
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const ruleList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' || (object(item) && typeof item.key === 'string'));
const failure = (machine, error, fields = {}) => ({ ...fields, machine, verdict: null, error });

/** Validate the controller receipt, independently of the artifact's claimed metadata. */
function verdictError(verdict, entry, { commit, repository }, status) {
  if (!object(verdict) || verdict.kind !== 'change-test' || !Object.hasOwn(RANK, verdict.verdict)
    || !count(verdict.regressions) || !Array.isArray(verdict.packages)) return 'Malformed controller verdict';
  if (verdict.snapshot !== entry.machineCommit) return 'Verdict is for the wrong machine commit';
  if (!Array.isArray(verdict.changes) || verdict.changes.length !== 1
    || verdict.changes[0]?.repository?.toLowerCase?.() !== repository.toLowerCase()
    || verdict.changes[0]?.commit !== commit) return 'Verdict is for the wrong repository or change head';
  for (const pkg of verdict.packages) {
    if (!object(pkg) || typeof pkg.name !== 'string'
      || (pkg.status !== undefined && typeof pkg.status !== 'string')
      || (pkg.tests !== undefined && !count(pkg.tests)) || (pkg.passed !== undefined && !count(pkg.passed))
      || (pkg.tests !== undefined && pkg.passed > pkg.tests)
      || (pkg.regressions !== undefined && !stringList(pkg.regressions))
      || (pkg.preexisting !== undefined && !stringList(pkg.preexisting))) return 'Malformed package result';
  }
  if (verdict.reason !== undefined && typeof verdict.reason !== 'string') return 'Malformed verdict reason';
  if (verdict.break !== undefined && !object(verdict.break)) return 'Malformed break result';
  const rules = verdict.designRules;
  if (rules !== undefined && (!object(rules)
    || (rules.added !== undefined && !ruleList(rules.added)) || (rules.removed !== undefined && !ruleList(rules.removed))
    || (rules.unread !== undefined && typeof rules.unread !== 'string'))) return 'Malformed design-rule result';
  if (verdict.verdict === 'no-regression' && (status !== 0 || verdict.regressions !== 0 || verdict.lock !== 'frozen'
    || !rules || !ruleList(rules.added) || !ruleList(rules.removed) || rules.unread !== undefined || rules.added.length
    || verdict.packages.some((pkg) => pkg.status !== undefined || !count(pkg.tests) || !count(pkg.passed)
      || !stringList(pkg.regressions) || !stringList(pkg.preexisting) || pkg.regressions.length
      || pkg.passed + pkg.preexisting.length !== pkg.tests))) {
    return 'No-regression verdict conflicts with incomplete or failed execution';
  }
  return null;
}

/** Reconcile all received artifacts against the complete immutable matrix and change head. */
export function readResults(directory, context = {}) {
  let expected;
  try {
    if (context.discovery !== 'success') throw new Error('Machine discovery did not complete successfully; pin coverage is unknown');
    expected = validatePlan(context.expected);
    if (!isCommit(context.commit) || typeof context.repository !== 'string'
      || machineName(context.repository) !== context.repository.toLowerCase() || context.repository.includes(':')) {
      throw new Error('Expected repository and exact change head are required');
    }
  } catch (error) { return [failure('Machine coverage', error.message)]; }
  let legs;
  try { legs = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) {
    if (error.code === 'ENOENT') legs = [];
    else return [failure('Machine coverage', 'Results directory could not be read')];
  }
  const received = new Map(), extras = [];
  for (const leg of legs) {
    const at = (name) => path.join(directory, leg.name, name);
    let meta;
    try {
      if (!leg.isDirectory()) throw new Error();
      meta = JSON.parse(fs.readFileSync(at('meta.json'), 'utf8'));
      if (!object(meta) || typeof meta.machine !== 'string') throw new Error();
    } catch { extras.push(failure(`Artifact ${leg.name}`, 'Missing or malformed result metadata')); continue; }
    const entry = expected.find((item) => item.machine === meta.machine);
    if (!entry) { extras.push(failure(meta.machine, 'Unexpected machine result')); continue; }
    const matches = received.get(entry.machine) ?? []; received.set(entry.machine, matches);
    let verdict, logTail = '';
    try { logTail = fs.readFileSync(at('log-tail.txt'), 'utf8'); } catch { /* Optional diagnostic only. */ }
    const fields = { machineCommit: entry.machineCommit, commit: context.commit, logTail };
    if (meta.id !== entry.id || meta.machineCommit !== entry.machineCommit || meta.commit !== context.commit) {
      matches.push(failure(entry.machine, 'Result identity conflicts with the expected snapshot, machine commit or change head', fields)); continue;
    }
    try { verdict = JSON.parse(fs.readFileSync(at('verdict.json'), 'utf8')); }
    catch { matches.push(failure(entry.machine, 'Missing or malformed controller verdict', fields)); continue; }
    const error = verdictError(verdict, entry, context, meta.status);
    matches.push(error ? failure(entry.machine, error, fields) : { ...fields, machine: entry.machine, verdict });
  }
  return [...expected.map((entry) => {
    const matches = received.get(entry.machine) ?? [];
    if (matches.length !== 1) return failure(entry.machine, matches.length ? 'Duplicate or conflicting machine results' : 'Expected machine result is missing',
      { machineCommit: entry.machineCommit, commit: context.commit });
    return matches[0];
  }), ...extras];
}

/** Put BODY in the pull request's one marked comment: update it when it exists, create it otherwise. */
export async function upsertComment({ repo, pr, body, request, commit }) {
  const write = async (method, url) => {
    // An older workflow must not replace the current head's comment after a newer push.
    if (commit !== undefined) {
      if (!isCommit(commit) || (await request('GET', `/repos/${repo}/pulls/${pr}`))?.head?.sha !== commit) {
        throw new Error('Pull-request head changed; refusing to publish a stale change-test report');
      }
    }
    return (await request(method, url, { body })).html_url;
  };
  for (let page = 1; ; page += 1) {
    const comments = await request('GET', `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!comments?.length) break;
    const mine = comments.find((c) => c.user?.login === REPORT_AUTHOR && typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (mine) return write('PATCH', `/repos/${repo}/issues/comments/${mine.id}`);
    if (comments.length < 100) break;
  }
  return write('POST', `/repos/${repo}/issues/${pr}/comments`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2), options = {};
    let directory;
    for (let i = 0; i < args.length; i += 1) {
      if (['--repo', '--pr', '--none', '--expected', '--commit', '--repository', '--discovery'].includes(args[i])) {
        const key = args[i].slice(2);
        if (options[key] !== undefined || args[i + 1] === undefined) throw new Error(`Invalid option: ${args[i]}`);
        options[key] = args[++i];
      } else if (!args[i].startsWith('--') && directory === undefined) directory = args[i];
      else throw new Error(`Invalid argument: ${args[i]}`);
    }
    // Invalid/missing discovery data must still replace a previous success comment with an unknown result.
    try { options.expected = JSON.parse(options.expected); } catch { options.expected = undefined; }
    const context = { ...options, repository: options.repository ?? options.repo };
    const results = readResults(directory ?? 'results', context), body = renderComment(results, context);
    if (options.repo && options.pr) {
      const { githubRequest } = await import('../generator/open-pr.mjs');
      const url = await upsertComment({ repo: options.repo, pr: options.pr, body, commit: context.commit, request: githubRequest(process.env.GH_TOKEN) });
      process.stdout.write(`${url}\n`);
    } else process.stdout.write(body);
    if (!provenEmpty(results, context) && overallVerdict(results) !== 'no-regression') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`change-test-comment: ${error.message}\n`); process.exitCode = 1;
  }
}
