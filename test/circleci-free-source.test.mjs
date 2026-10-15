import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDocument} from 'yaml';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const source=readFileSync(new URL('../.circleci/config.yml',import.meta.url),'utf8');
const parsed=parseDocument(source,{uniqueKeys:true,merge:false});
if(parsed.errors.length||parsed.warnings.length)
  throw new Error('original CircleCI source has ambiguous YAML');
const cfg=parsed.toJS({maxAliasCount:0});
const job=cfg.jobs?.['verify-original-git-source'];
const steps=job?.steps;

test('free private CI executes native source tests without provider billing or deployment',()=>{
  assert.equal(cfg.version,2.1);
  assert.deepEqual(Object.keys(cfg.jobs),['verify-original-git-source']);
  assert.equal(job.resource_class,'small');
  assert.deepEqual(job.docker,[{image:'cimg/node:24'}]);
  assert.equal(job.working_directory,'~/project');
  assert.equal(steps.length,4);
  assert.equal(steps[0],'checkout');
  assert.equal(steps[3].run.command,'npm run verify');
  assert.equal(steps[3].run.no_output_timeout,'15m');
  const runtime=steps[2].run.command;
  assert.match(runtime,/process\.versions\.node/u);
  assert.match(runtime,/npm run check && npm test/u);
  assert.deepEqual(cfg.workflows,{'private-source-verification':{jobs:[
    {'verify-original-git-source':{filters:'pipeline.git.branch == "main"'}}
  ]}});
  // No Google billing, secret-bearing contexts, deployments, caches or artifacts.
  for(const prohibited of ['gcloud','wrangler','store_artifacts:',
    'save_cache:', 'setup_remote_docker:', 'context:', 'deploy:', 'aws-'])
    assert.equal(source.includes(prohibited),false,prohibited);
});

test('actual private Git source checkout is admitted only at its exact provider commit',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'circleci-private-source-'));
  const git=(...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  try{
    git('init','-q','-b','main');
    git('config','user.name','Original');
    git('config','user.email','original@example.invalid');
    writeFileSync(join(cwd,'package.json'),
      JSON.stringify({scripts:{verify:'npm run check && npm test'}}));
    git('add','package.json');git('commit','-qm','original');
    git('remote','add','origin','git@github.com:red-cup-engineering/git-services-section.git');
    const revision=git('rev-parse','HEAD');
    // GitHub App CIRCLE_PROJECT_* names refer to the CircleCI project,
    // not necessarily to the independently selected checkout source.
    const env={...process.env,CIRCLE_SHA1:revision,
      CIRCLE_PROJECT_USERNAME:'circleci-org-alias',
      CIRCLE_PROJECT_REPONAME:'different-project-display-name'};
    const observe=changes=>spawnSync('/usr/bin/bash',['-euc',steps[1].run.command],{
      cwd,env:{...env,...changes},encoding:'utf8',timeout:5000});
    assert.equal(observe({}).status,0);
    for(const bad of [
      {CIRCLE_SHA1:'a'.repeat(40)},{CIRCLE_SHA1:'HEAD'},{CIRCLE_SHA1:''},
      {CIRCLE_SHA1:'not-a-commit'}
    ])assert.notEqual(observe(bad).status,0,JSON.stringify(bad));
    // Different CircleCI project names do not change checkout identity.
    assert.equal(observe({CIRCLE_PROJECT_USERNAME:'',CIRCLE_PROJECT_REPONAME:''}).status,0);
    git('remote','set-url','origin','https://attacker.example/other.git');
    assert.notEqual(observe({}).status,0,'foreign Git checkout must refuse');
    git('remote','set-url','origin','git@github.com:red-cup-engineering/another-private-repo.git');
    assert.notEqual(observe({}).status,0,'other private checkout must refuse');
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
