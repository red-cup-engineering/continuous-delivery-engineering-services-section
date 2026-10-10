// The change test's one pull-request comment: every machine's verdict, kept in a single comment that each run
// updates in place (found by its marker), so a pull request carries the current reading and not a trail of them.
//   node change-test-comment.mjs RESULTS_DIR > comment.md                       (render)
//   GH_TOKEN=... node change-test-comment.mjs RESULTS_DIR --repo OWNER/REPO --pr N   (render and upsert)
// RESULTS_DIR holds one directory per machine leg, each with meta.json ({machine, machineCommit, commit, status})
// and verdict.json (the change test's output; absent or empty when it produced none) and log-tail.txt.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- continuous-delivery-services-section: change-test -->';
const RANK = { regression: 4, 'not-composed': 3, incomplete: 2, 'not-run': 1, 'no-regression': 0 };

/** The worst verdict of RESULTS: one regression anywhere is a regression. */
export function overallVerdict(results) {
  if (!results.length) return 'not-run';
  return results.map((r) => r.verdict?.verdict ?? 'not-run').sort((a, b) => (RANK[b] ?? 1) - (RANK[a] ?? 1))[0];
}

const code = (text) => `\`${String(text).replaceAll('`', "'")}\``;
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 9) : '?');

function machineSection({ machine, machineCommit, commit, verdict, logTail }) {
  const lines = [`### ${machine} @ ${code(short(machineCommit))}: ${code(verdict?.verdict ?? 'not-run')}`];
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

/** The comment body for RESULTS ([{machine, machineCommit, commit, verdict|null, logTail}]); NONE names a
 *  repository no machine pins. */
export function renderComment(results, { none } = {}) {
  const head = [MARKER, `## Change test: ${code(overallVerdict(results))}`];
  if (none) return [...head, '', `No machine pins ${code(none)}, so there is nothing to test it against.`].join('\n') + '\n';
  return [...head, '', ...results.flatMap((r) => [machineSection(r), ''])].join('\n');
}

/** Read RESULTS_DIR as renderComment's input. */
export function readResults(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().flatMap((leg) => {
    const at = (name) => path.join(directory, leg, name);
    if (!fs.existsSync(at('meta.json'))) return [];
    const meta = JSON.parse(fs.readFileSync(at('meta.json'), 'utf8'));
    let verdict = null;
    try { const text = fs.readFileSync(at('verdict.json'), 'utf8'); if (text.trim()) verdict = JSON.parse(text); } catch { verdict = null; }
    const logTail = fs.existsSync(at('log-tail.txt')) ? fs.readFileSync(at('log-tail.txt'), 'utf8') : '';
    return [{ ...meta, verdict, logTail }];
  });
}

/** Put BODY in the pull request's one marked comment: update it when it exists, create it otherwise. */
export async function upsertComment({ repo, pr, body, request }) {
  for (let page = 1; ; page += 1) {
    const comments = await request('GET', `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!comments?.length) break;
    const mine = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    if (mine) return (await request('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body })).html_url;
    if (comments.length < 100) break;
  }
  return (await request('POST', `/repos/${repo}/issues/${pr}/comments`, { body })).html_url;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const directory = args.find((a, i) => !a.startsWith('--') && !['--repo', '--pr', '--none'].includes(args[i - 1]));
  const body = renderComment(readResults(directory ?? 'results'), { none: option('--none') });
  if (option('--repo') && option('--pr')) {
    const { githubRequest } = await import('../generator/open-pr.mjs');
    const url = await upsertComment({ repo: option('--repo'), pr: option('--pr'), body, request: githubRequest(process.env.GH_TOKEN) });
    process.stdout.write(`${url}\n`);
  } else process.stdout.write(body);
}
