import test from "node:test";
import assert from "node:assert/strict";
import {parseDocument} from "yaml";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

const source=readFileSync(new URL("../.circleci/private-organizing.yml",import.meta.url),"utf8");
const parsed=parseDocument(source,{uniqueKeys:true,merge:false});
if(parsed.errors.length||parsed.warnings.length)throw Error("Ambiguous original Organizing CI source");
const cfg=parsed.toJS({maxAliasCount:0});
const job=cfg.jobs?.["qualify-original-organizing-dispatch"];
const steps=job?.steps;

test("original private Organizing dispatch is received by existing free CircleCI owner",()=>{
  assert.equal(cfg.version,2.1);
  assert.deepEqual(Object.keys(cfg.jobs),["qualify-original-organizing-dispatch"]);
  assert.deepEqual(job.docker,[{image:"cimg/node:24"}]);
  assert.equal(job.resource_class,"small");
  assert.equal(steps.length,5);
  assert.equal(steps[0],"checkout");
  assert.match(steps[1].run.command,/CIRCLE_SHA1/u);
  assert.match(steps[1].run.command,/red-cup-engineering\/agent-organization-engine/u);
  assert.match(steps[1].run.command,/fix\/delegated-work-source-context-20261020/u);
  assert.match(steps[2].run.command,/@red-cup-engineering\/organizing/u);
  assert.match(steps[2].run.command,/test\/dispatch-unallocated-contract\.test\.mjs/u);
  assert.match(steps[3].run.command,/pnpm@11\.28\.5/u);
  assert.match(steps[3].run.command,/install --frozen-lockfile/u);
  assert.match(steps[3].run.command,/\$pnpm test/u);
  assert.match(steps[4].run.command,/pack --pack-destination/u);
  assert.match(steps[4].run.command,/receivingTests/u);
  assert.match(steps[4].run.command,/xargs node --test --test-concurrency=1/u);
  assert.deepEqual(cfg.workflows,{"private-original-organizing-receiving":{jobs:[
    {"qualify-original-organizing-dispatch":{filters:'pipeline.git.branch == "main" or pipeline.git.branch == "fix/delegated-work-source-context-20261020"'}}
  ]}});
  for(const forbidden of ["gcloud","store_artifacts:","save_cache:","context:","deploy:","setup_remote_docker:","wrangler","ssh-add","aws-","sudo "]){
    assert.equal(source.includes(forbidden),false,forbidden);
  }
  const incumbent=readFileSync(new URL("../.circleci/config.yml",import.meta.url),"utf8");
  assert.match(incumbent,/repository="red-cup-engineering\/git-engineering-services-section"/u);
  assert.doesNotMatch(incumbent,/agent-organization-engine/u,"do not alter incumbent first consumer");
});

test("only original exact Git commit, repository and selected branch enter private Organizing receiving",()=>{
  const cwd=mkdtempSync(join(tmpdir(),"circleci-original-organizing-"));
  const git=(...args)=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8"}).trim();
  try{
    git("init","-q","-b","main");
    git("config","user.name","Original Test Source");
    git("config","user.email","source@example.invalid");
    writeFileSync(join(cwd,"source"),"original");
    git("add","source");
    git("commit","-qm","original");
    git("remote","add","origin","git@github.com:red-cup-engineering/agent-organization-engine.git");
    const sha=git("rev-parse","HEAD");
    const run=changed=>spawnSync("/usr/bin/bash",["-euc",steps[1].run.command],{
      cwd,env:{...process.env,CIRCLE_SHA1:sha,CIRCLE_BRANCH:"main",...changed},
      encoding:"utf8",timeout:5000
    });
    assert.equal(run({}).status,0);
    assert.equal(run({CIRCLE_BRANCH:"fix/delegated-work-source-context-20261020"}).status,0);
    for(const denied of [
      {CIRCLE_SHA1:""},{CIRCLE_SHA1:"HEAD"},{CIRCLE_SHA1:"a".repeat(40)},
      {CIRCLE_BRANCH:"other-development-branch"},{CIRCLE_BRANCH:""}]){
      assert.notEqual(run(denied).status,0,JSON.stringify(denied));
    }
    git("remote","set-url","origin","https://github.com/red-cup-engineering/agent-organization-engine.git");
    assert.equal(run({}).status,0);
    git("remote","set-url","origin","git@github.com:red-cup-engineering/git-engineering-services-section.git");
    assert.notEqual(run({}).status,0);
    git("remote","set-url","origin","https://example.invalid/agent-organization-engine.git");
    assert.notEqual(run({}).status,0);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
