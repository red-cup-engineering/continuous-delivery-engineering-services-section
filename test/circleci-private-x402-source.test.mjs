import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const text = readFileSync(new URL("../.circleci/private-x402.yml", import.meta.url), "utf8");
const parsed = parseDocument(text, { uniqueKeys: true, merge: false });
if (parsed.errors.length || parsed.warnings.length)
  throw Error("Ambiguous original x402 private CI config");
const config = parsed.toJS({ maxAliasCount: 0 });
const job = config.jobs?.["verify-original-x402-native-package"];
const steps = job?.steps;

test("private x402 CI selects the original Code service and Free small runner, never a public source copy", () => {
  assert.equal(config.version, 2.1);
  assert.deepEqual(Object.keys(config.jobs), ["verify-original-x402-native-package"]);
  assert.deepEqual(job.docker, [{ image: "cimg/node:24" }]);
  assert.equal(job.resource_class, "small");
  assert.equal(steps.length, 5);
  assert.equal(steps[0], "checkout");
  assert.match(steps[1].run.command, /CIRCLE_SHA1/u);
  assert.match(steps[1].run.command, /repository="red-cup-engineering\/x402-services-section"/u);
  assert.match(steps[2].run.command, /@red-cup-engineering\/x402-services-section/u);
  assert.match(steps[2].run.command, /required-field-handoff\.test\.mjs/u);
  assert.match(steps[3].run.command, /npm install --ignore-scripts --no-audit --no-fund/u);
  assert.match(steps[3].run.command, /sha256sum package-lock\.json/u);
  assert.match(steps[4].run.command, /npm run check\nnpm test/u);
  assert.deepEqual(config.workflows, { "private-x402-native-receiving": {
    jobs: [{ "verify-original-x402-native-package": {
      filters: 'pipeline.git.branch == "main"',
    } }],
  } });
  for (const forbidden of [
    "gcloud", "wrangler deploy", "store_artifacts:", "save_cache:",
    "setup_remote_docker:", "context:", "deploy:", "aws-", "sudo ", "curl |",
    "gh auth", "npm publish", "git push", "workflow_dispatch",
  ]) assert.equal(text.includes(forbidden), false, forbidden);
  const gitServices = readFileSync(new URL("../.circleci/config.yml", import.meta.url), "utf8");
  const inference = readFileSync(new URL("../.circleci/private-inference.yml", import.meta.url), "utf8");
  assert.match(gitServices, /repository="red-cup-engineering\/git-services-section"/u);
  assert.match(inference, /repository="red-cup-engineering\/computer-inference-engine"/u);
  assert.doesNotMatch(gitServices, /x402-services-section/u);
  assert.doesNotMatch(inference, /x402-services-section/u);
});

test("exact private x402 Git commit and original checkout are both required", () => {
  const dir = mkdtempSync(join(tmpdir(), "private-x402-receiving-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Source Receiver");
    git("config", "user.email", "receiver@example.invalid");
    writeFileSync(join(dir, "package.json"), '{"name":"@red-cup-engineering/x402-services-section"}\n');
    git("add", "package.json"); git("commit", "-qm", "source");
    git("remote", "add", "origin", "git@github.com:red-cup-engineering/x402-services-section.git");
    const sha = git("rev-parse", "HEAD");
    const env = { ...process.env, CIRCLE_SHA1: sha };
    const receive = changed => spawnSync("/usr/bin/bash", ["-euc", steps[1].run.command], {
      cwd: dir, env: { ...env, ...changed }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(receive({}).status, 0);
    for (const patch of [
      { CIRCLE_SHA1: "" }, { CIRCLE_SHA1: "HEAD" },
      { CIRCLE_SHA1: "a".repeat(40) }, { CIRCLE_SHA1: "wrong" },
    ]) assert.notEqual(receive(patch).status, 0);
    git("remote", "set-url", "origin", "git@github.com:red-cup-engineering/git-services-section.git");
    assert.notEqual(receive({}).status, 0);
    git("remote", "set-url", "origin", "https://unrelated.example/private.git");
    assert.notEqual(receive({}).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admission requires the original complete x402 check/test/receiving selectors", () => {
  const contract = steps[2].run.command;
  assert.match(contract, /pkg\.name !== "@red-cup-engineering\/x402-services-section"/u);
  assert.match(contract, /pkg\.scripts\.test\.includes\(fieldTest\)/u);
  assert.match(contract, /pkg\.scripts\.test\.includes\(originalTest\)/u);
  assert.match(contract, /pkg\.receivingTests\.includes\(fieldTest\)/u);
  assert.match(contract, /pkg\.receivingTests\.includes\(originalTest\)/u);
  assert.match(contract, /startsWith\("workspace:"\)/u);
  assert.match(contract, /startsWith\("file:"\)/u);
  assert.equal(steps[4].run.no_output_timeout, "15m");
});
