import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const text = fs.readFileSync(new URL('../.github/workflows/derive-market-offers.yml', import.meta.url), 'utf8');

test('derive-market-offers is a reusable workflow with caller-supplied runners and no hardcoded market', () => {
  assert.match(text, /^on:\n {2}workflow_call:/mu);
  assert.match(text, /runs-on:\n {8}description: 'Explicit JSON runner labels supplied by the caller'\n {8}type: string\n {8}required: true/u);
  assert.match(text, /catalog-repository:[\s\S]*?required: true/u);
  assert.doesNotMatch(text, /market\.561\.group|causeway-services\//u, 'the caller names its market; none is hardcoded');
  assert.doesNotMatch(text, /runs-on: ubuntu|runs-on: \[/u, 'no GitHub-hosted fallback');
});

test('every action is pinned to a commit and the x402 source is a pinned commit', () => {
  for (const [, use] of text.matchAll(/^\s*(?:- )?uses: (\S+)/gmu)) assert.match(use, /@[0-9a-f]{40}$/u, use);
  assert.match(text, /\^\[0-9a-f\]\{40\}\$/u);
  // The house rules test/advance.test.mjs applies to every workflow.
  assert.ok(!/\/tmp\//u.test(text), 'writes /tmp');
  assert.ok(!/push (-f|--force)\b/u.test(text), 'force-pushes');
});

test('the step that imports package code holds no token; the catalog write is a separate job', () => {
  const derive = text.slice(text.indexOf('  derive:'), text.indexOf('  propose:'));
  const propose = text.slice(text.indexOf('  propose:'));
  assert.equal((derive.match(/persist-credentials: false/gu) ?? []).length, 3);
  const run = derive.slice(derive.indexOf('id: reconcile'));
  assert.doesNotMatch(run.slice(0, run.indexOf('uses: actions/upload-artifact')), /secrets\./u);
  assert.match(propose, /GH_TOKEN: \$\{\{ secrets\.catalog-token \}\}/u);
  assert.doesNotMatch(propose, /gh pr merge|--admin|auto-merge/u, 'it proposes, it never merges');
  assert.match(text, /--ignore-scripts/u);
});
