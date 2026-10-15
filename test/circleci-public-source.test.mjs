import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDocument} from 'yaml';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const source=readFileSync(new URL('../.circleci/public-source.yml',import.meta.url),'utf8');
const doc=parseDocument(source,{uniqueKeys:true,merge:false});
if(doc.errors.length||doc.warnings.length)throw new Error('ambiguous CircleCI original public source');
const cfg=doc.toJS({maxAliasCount:0});
const job=cfg.jobs?.['public-engineering-source'];
const steps=job?.steps;

test('public OSS compute does not consume or expose private Git Services',()=>{
  assert.equal(cfg.version,2.1);
  assert.deepEqual(Object.keys(cfg.jobs),['public-engineering-source']);
  assert.deepEqual(job.docker,[{image:'cimg/node:24'}]);
  assert.equal(job.resource_class,'small');
  assert.equal(steps.length,4);
  assert.equal(steps[0],'checkout');
  assert.match(steps[2].run.command,/npm ci --legacy-peer-deps --ignore-scripts/u);
  assert.equal(steps[3].run.command,'npm run test:public-source-contract');
  assert.deepEqual(cfg.workflows,{'public-source-contract':{jobs:[
    {'public-engineering-source':{filters:'pipeline.git.branch == "main"'}}
  ]}});
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  assert.match(manifest.scripts['test:public-source-contract'],/test\/circleci-public-source\.test\.mjs/u);
  assert.equal(manifest.scripts['test:public-source-contract'].split('test/placement.test.mjs').length-1,1);
  for(const banned of ['red-cup-engineering/git-services-section',
    'gcloud','wrangler','store_artifacts:','save_cache:','context:',
    'setup_remote_docker:','deploy:','ssh-add'])
    assert.equal(source.includes(banned),false,banned);
});

test('native public checkout rejects foreign and private source revisions',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'oss-source-ci-'));
  const git=(...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  try{
    git('init','-q','-b','main');
    git('config','user.name','Original');
    git('config','user.email','original@example.invalid');
    writeFileSync(join(cwd,'README.md'),'source contract\n');
    git('add','README.md');git('commit','-qm','original');
    git('remote','add','origin','git@github.com:red-cup-engineering/continuous-delivery-services-section.git');
    const sha=git('rev-parse','HEAD'),env={...process.env,CIRCLE_SHA1:sha};
    const observe=change=>spawnSync('/usr/bin/bash',['-euc',steps[1].run.command],
      {cwd,env:{...env,...change},encoding:'utf8',timeout:5000});
    assert.equal(observe({}).status,0);
    for(const other of [{CIRCLE_SHA1:''},{CIRCLE_SHA1:'HEAD'},{CIRCLE_SHA1:'a'.repeat(40)}])
      assert.notEqual(observe(other).status,0);
    git('remote','set-url','origin','git@github.com:red-cup-engineering/git-services-section.git');
    assert.notEqual(observe({}).status,0);
    git('remote','set-url','origin','https://evil.invalid/pretend.git');
    assert.notEqual(observe({}).status,0);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
