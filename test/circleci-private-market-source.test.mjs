import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = (await import("node:fs")).readFileSync(
  new URL("../.circleci/private-market.yml", import.meta.url), "utf8");
const parsed = parseDocument(source, { uniqueKeys: true, merge: false });
if (parsed.errors.length || parsed.warnings.length)
  throw new Error("Ambiguous original CircleCI private Market contract");
const config = parsed.toJS({ maxAliasCount: 0 });
const job = config.jobs?.["original-market-native"];
const steps = job?.steps;
const extractNode = script => {
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/u.exec(script);
  if (!match) throw new Error("original selected Market contract has no native Node verification");
  return match[1];
};

test("private Market CircleCI retains original source, authorized submodule and full native receiving", () => {
  assert.equal(config.version, 2.1);
  assert.deepEqual(Object.keys(config.jobs), ["original-market-native"]);
  assert.deepEqual(job.docker, [{ image: "cimg/node:24" }]);
  assert.equal(job.resource_class, "small");
  assert.equal(steps[0], "checkout");
  assert.match(steps[1].run.command, /CIRCLE_SHA1/u);
  assert.match(steps[1].run.command, /repository="red-cup-engineering\/market\.561\.group"/u);
  assert.match(steps[2].run.command, /git submodule update --init --checkout parameters/u);
  assert.match(steps[3].run.command, /cp package\.json \/tmp\/market-native\/source-package\.json/u);
  assert.match(steps[3].run.command, /pnpm\.cjs" install --frozen-lockfile/u);
  assert.match(steps[4].run.command, /npm run compile\nnpm run check\nnpm run check:catalog\nnpm test/u);
  assert.deepEqual(config.workflows["receive-private-market-main"].jobs, [
    { "original-market-native": { filters: 'pipeline.git.branch == "main"' } },
  ]);
  for (const mutation of ["wrangler deploy", "npm publish", "git push", "sudo ", "gcloud", "setup_remote_docker:"])
    assert.equal(source.includes(mutation), false, "no unauthorized private-source or payment effects");
});

test("the actual CircleCI source admission accepts exact current Market CVE edition and rejects erased provenance", t => {
  const dir = mkdtempSync(join(tmpdir(), "native-market-source-selection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test/cve-change-set-market.test.mjs"), "// original-required consumer\n");
  const script = extractNode(steps[1].run.command);
  const supplier = "@red-cup-engineering/jsnode-package-vulnerability-triage-services-section";
  const receive = (version, haveTests = true) => {
    const record = { name: "@causeway-services/market.561.group",
      dependencies: { [supplier]: version },
      receivingTests: haveTests ? ["test/cve-change-set-market.test.mjs"] : [] };
    writeFileSync(join(dir, "package.json"), JSON.stringify(record));
    return spawnSync(process.execPath, ["--input-type=module"], {
      cwd: dir, encoding: "utf8", input: script,
      env: { ...process.env, CIRCLE_SHA1: "a".repeat(40) },
    });
  };
  assert.equal(receive("0.2.0-dev.27").status, 0, "current observed source edition must be admitted");
  assert.equal(receive("0.2.0-dev.51").status, 0, "future exact original suppliers must not require a CD source patch");
  assert.notEqual(receive("workspace:*").status, 0);
  assert.notEqual(receive("^0.2.0").status, 0);
  assert.notEqual(receive(undefined).status, 0);
  assert.notEqual(receive("0.2.0-dev.27", false).status, 0);
});

test("post-pinning native acceptance compares the selected supplier against original exact source", () => {
  const script = extractNode(steps[3].run.command);
  assert.match(script, /source-package\.json/u);
  assert.match(script, /pkg\.dependencies\?\.\[cve\]!==source\.dependencies\[cve\]/u);
  assert.match(script, /receipt\.packages\[0\]\.applied!==true/u);
  assert.doesNotMatch(script, /0\.2\.0-dev\.24/u,
    "the obsolete supplier version must not survive in the live receiver");
});
