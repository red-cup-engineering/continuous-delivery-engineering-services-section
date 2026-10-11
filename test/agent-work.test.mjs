import test from "node:test";
import assert from "node:assert/strict";
import { receiveAgentWork } from "../src/agent-work.mjs";

function fixture(status, existingOnRetry = []) {
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
        async list() { pullsRead++; return pullsRead === 1 ? [] : existingOnRetry; },
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
