import test from "node:test";
import assert from "node:assert/strict";
import { receiveAgentWork, refreshAgentWorkMetadata } from "../src/agent-work.mjs";

function fixture(status, existingOnRetry = [], existingOnFirst = []) {
  const sha = "a".repeat(40), calls = [];
  let pullsRead = 0, failure;
  const summary = {
    addHeading() { return this; },
    addTable() { return this; },
    addRaw(value) { calls.push(["summary", value]); return this; },
    addLink() { return this; },
    async write() { calls.push(["summary-write"]); },
  };
  const core = {
    summary,
    info(message) { calls.push(["info", message]); },
    setFailed(message) { failure = message; calls.push(["failure", message]); },
  };
  const github = {
    rest: {
      repos: {
        async get() { return { data: { id: 321, default_branch: "main" } }; },
        async compareCommitsWithBasehead() {
          return { data: { ahead_by: 1, behind_by: 0, base_commit: { sha: "b".repeat(40) } } };
        },
      },
      git: {
        async getRef() { return { data: { object: { sha } } }; },
      },
      pulls: {
        async list() { pullsRead++; return pullsRead === 1 ? existingOnFirst : existingOnRetry; },
        async update(payload) { calls.push(["pull-update", payload]); return { data: {} }; },
        async create() { calls.push(["pull-create"]); throw Object.assign(new Error("not admitted"), { status }); },
      },
      issues: {
        async getLabel() { return { data: {} }; },
        async createLabel() { throw new Error("unexpected label creation"); },
        async addLabels({ issue_number, labels }) { calls.push(["label", issue_number, labels]); },
        async create() { throw new Error("unexpected fallback issue"); },
        async listForRepo() { throw new Error("unexpected fallback issue search"); },
      },
    },
    async paginate(fn, options) { return fn(options); },
  };
  const context = {
    repo: { owner: "red-cup-engineering", repo: "fixture" },
    eventName: "push",
    payload: { deleted: false },
    ref: "refs/heads/agent/qualified-work",
    sha,
  };
  return { github, context, core, calls, getFailure: () => failure };
}

test("PR permission refusal leaves the original branch without creating a duplicate issue", async () => {
  const f = fixture(403);
  await receiveAgentWork(f);
  assert.match(f.getFailure(), /no duplicate issue created/);
  assert.ok(f.calls.some(([kind, value]) => kind === "summary" && value.includes("No fallback issue created")));
});

test("race with another draft PR receiver converges on that PR instead of an issue", async () => {
  const f = fixture(422, [{ number: 17 }]);
  await receiveAgentWork(f);
  assert.equal(f.getFailure(), undefined);
  assert.ok(f.calls.some(([kind, number, labels]) =>
    kind === "label" && number === 17 && labels.includes("agent:work")));
});

test("existing received PR refreshes only its stale generated revision lines", async () => {
  const old = "c".repeat(40), olderBase = "d".repeat(40);
  const body = [
    "<!-- agent-work:321:agent/qualified-work -->",
    "Receive this work and preserve the review.",
    `Observed head: \`${old}\`. Compare base: \`${olderBase}\`.`,
    "5 commits ahead; 2 behind.",
    "Independent review still required.\nCustom receiver notes must survive."
  ].join("\n\n");
  const f = fixture(undefined, [], [{ number: 42, body }]);
  await receiveAgentWork(f);
  const updates = f.calls.filter(([kind]) => kind === "pull-update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1].pull_number, 42);
  const refreshed = updates[0][1].body;
  assert.match(refreshed, new RegExp("Observed head: `" + "a".repeat(40) + "`"));
  assert.match(refreshed, new RegExp("Compare base: `" + "b".repeat(40) + "`"));
  assert.match(refreshed, /1 commits ahead; 0 behind/u);
  assert.match(refreshed, /Custom receiver notes must survive/u);
  assert.ok(!f.calls.some(([kind]) => kind === "pull-create"));
  assert.equal(refreshAgentWorkMetadata(refreshed, {
    repositoryId: 321, branch: "agent/qualified-work",
    headSha: "a".repeat(40), baseSha: "b".repeat(40), ahead: 1, behind: 0
  }), null);
});

test("unowned or reviewer-rewritten PR descriptions are never rewritten", async () => {
  const legacy = "Custom review with observed revision not in generated fields.";
  const same = "<!-- agent-work:321:agent/qualified-work -->\n\n" + legacy;
  const differentOwner = "<!-- agent-work:999:agent/qualified-work -->\n\n" +
    `Observed head: \`${"c".repeat(40)}\`. Compare base: \`${"d".repeat(40)}\`.\n\n3 commits ahead; 0 behind.`;
  for (const body of [legacy, same, differentOwner]) {
    const f = fixture(undefined, [], [{ number: 41, body }]);
    await receiveAgentWork(f);
    assert.ok(!f.calls.some(([kind]) => kind === "pull-update"));
  }
});
