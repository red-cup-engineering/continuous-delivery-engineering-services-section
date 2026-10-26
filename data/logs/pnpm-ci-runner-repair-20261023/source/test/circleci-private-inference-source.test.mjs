import test from "node:test";
import assert from "node:assert/strict";
import {parseDocument} from "yaml";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

const source = readFileSync(new URL("../.circleci/private-inference.yml", import.meta.url), "utf8");
const doc = parseDocument(source, {uniqueKeys:true, merge:false});
if (doc.errors.length || doc.warnings.length) throw Error("ambiguous original private inference CI");
const cfg = doc.toJS({maxAliasCount:0});
const job = cfg.jobs?.["verify-original-inference-work-placement"];
const steps = job?.steps;

test("separate inference consumer is a source-verified private CircleCI Free test, never a paid runner", () => {
  assert.equal(cfg.version, 2.1);
  assert.deepEqual(Object.keys(cfg.jobs), ["verify-original-inference-work-placement"]);
  assert.equal(job.resource_class, "small");
  assert.deepEqual(job.docker, [{image:"cimg/node:24"}]);
  assert.equal(steps.length, 5);
  assert.equal(steps[0], "checkout");
  assert.match(steps[1].run.command, /CIRCLE_SHA1/u);
  assert.match(steps[1].run.command, /red-cup-engineering\/computer-inference-engine/u);
  assert.match(steps[2].run.command, /@red-cup-engineering\/computer-inference-engine/u);
  assert.match(steps[2].run.command, /test\/dispatch\/attention-work-placement\.test\.mjs/u);
  assert.match(steps[3].run.command, /pnpm@10\.18\.3/u);
  assert.match(steps[3].run.command, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(steps[4].run.command, /node --test test\/dispatch\/attention-work-placement\.test\.mjs test\/dispatch\/resource-control-time\.test\.mjs/u);
  assert.equal(steps[4].run.no_output_timeout, "15m");
  assert.deepEqual(cfg.workflows, {"private-inference-source-verification":{jobs:[
    {"verify-original-inference-work-placement":{filters:'pipeline.git.branch == "main"'}}
  ]}});
  for (const disallowed of ["gcloud","store_artifacts:","save_cache:","setup_remote_docker:",
    "context:","deploy:","aws-","wrangler","sudo ","curl |","ssh-add"]) {
    assert.equal(source.includes(disallowed), false, disallowed);
  }
  const previous = readFileSync(new URL("../.circleci/config.yml", import.meta.url), "utf8");
  assert.match(previous, /repository="red-cup-engineering\/git-services-section"/u);
  assert.doesNotMatch(previous, /computer-inference-engine/u, "do not weaken or modify existing Git Services source admission");
});

test("only the original Git source and exact commit can enter inference CI", () => {
  const cwd = mkdtempSync(join(tmpdir(), "circleci-private-inference-"));
  const git = (...args) => execFileSync("git", ["-C",cwd,...args], {encoding:"utf8"}).trim();
  try {
    git("init","-q","-b","main");
    git("config","user.name","Source Consumer");
    git("config","user.email","source@example.invalid");
    writeFileSync(join(cwd,"package.json"),'{"name":"@red-cup-engineering/computer-inference-engine"}\n');
    git("add","package.json"); git("commit","-qm","source");
    git("remote","add","origin","git@github.com:red-cup-engineering/computer-inference-engine.git");
    const sha = git("rev-parse","HEAD");
    const environment = {...process.env,CIRCLE_SHA1:sha};
    const check = changed => spawnSync("/usr/bin/bash",["-euc",steps[1].run.command],{
      cwd,env:{...environment,...changed},encoding:"utf8",timeout:5000,
    });
    assert.equal(check({}).status, 0);
    for (const bad of [{CIRCLE_SHA1:""},{CIRCLE_SHA1:"HEAD"},
      {CIRCLE_SHA1:"a".repeat(40)},{CIRCLE_SHA1:"bad"}]) {
      assert.notEqual(check(bad).status, 0);
    }
    git("remote","set-url","origin","git@github.com:red-cup-engineering/git-services-section.git");
    assert.notEqual(check({}).status,0,"the other authorized private CI repo must not be accepted here");
    git("remote","set-url","origin","https://attacker.example/wrong");
    assert.notEqual(check({}).status,0,"no arbitrary provider origin is admitted");
  } finally { rmSync(cwd,{recursive:true,force:true}); }
});
