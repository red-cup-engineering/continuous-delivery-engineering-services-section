import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDocument} from 'yaml';

const text=readFileSync(new URL('../cloudbuild.yaml',import.meta.url),'utf8');
const parsed=parseDocument(text,{uniqueKeys:true,merge:false});
const config=parsed.toJS({maxAliasCount:0});
const command=config.steps[0].args[1];

test('native Cloud Build is bounded to the free-eligible default worker pool',()=>{
  assert.equal(parsed.errors.length,0);
  assert.equal(parsed.warnings.length,0);
  assert.equal(config.timeout,'900s');
  assert.equal(config.options.machineType,'E2_STANDARD_2');
  assert.equal(config.options.logging,'CLOUD_LOGGING_ONLY');
  assert.deepEqual(config.options.sourceProvenanceHash,['SHA256']);
  assert.equal(config.options.pool,undefined);
  assert.equal(config.steps.length,1);
  assert.equal(config.steps[0].id,'source-and-test');
  assert.equal(config.steps[0].name,'${_NODE_IMAGE}');
  assert.equal(config.steps[0].entrypoint,'bash');
  assert.deepEqual(config.steps[0].env,['BUILDER_IMAGE=${_NODE_IMAGE}']);
  assert.equal(config.steps[0].args[0],'-euc');
});

test('Cloud Build substitutions do not accidentally consume shell variables',()=>{
  // Cloud Build processes $NAME in inline scripts. Shell-only dollar signs
  // need $$ until the provider has resolved its substitution pass.
  assert.ok(command.includes('source_commit="$COMMIT_SHA"'));
  assert.ok(command.includes('[[ "$$source_commit" =~ ^[a-f0-9]{40}$$ ]]'));
  assert.ok(command.includes('[[ "$$BUILDER_IMAGE" =~ @sha256:[0-9a-f]{64}$$ ]]'));
  assert.match(command,/exact source commit required/);
  assert.match(command,/unpinned builder/);
});

test('source comes from the immutable owning Git revision even without workspace .git',()=>{
  const pinnedSource=command.indexOf('source_commit="$COMMIT_SHA"');
  const fetch=command.indexOf('git -C "$$source_root" -c credential.helper= fetch');
  const origin=command.indexOf('https://github.com/red-cup-engineering/continuous-delivery-services-section.git');
  const readHead=command.indexOf('rev-parse --verify FETCH_HEAD');
  const compare=command.indexOf('test "$$revision" = "$$source_commit"');
  const checkout=command.indexOf('checkout --quiet --detach "$$revision"');
  const install=command.indexOf('npm ci');
  const testRun=command.indexOf('npm test');
  assert.ok([pinnedSource,fetch,origin,readHead,compare,checkout,install,testRun].every(x=>x>=0));
  assert.ok(pinnedSource<fetch && fetch<origin && origin<readHead && readHead<compare);
  assert.ok(compare<checkout && checkout<install && install<testRun);
  assert.ok(command.includes('trap \'rm -rf "$$source_root"\' EXIT'));
  assert.match(command,/npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund/);
});

test('no mutable source, extra artifact push, credentials, cloud administration or deploy',()=>{
  assert.equal(config.substitutions,undefined,'source trigger supplies a pinned build image');
  assert.equal(config.serviceAccount,undefined,'the qualified trigger binds its restricted identity');
  for(const field of ['availableSecrets','secrets','secretEnv','artifacts','images']) assert.equal(config[field],undefined);
  assert.deepEqual(Object.keys(config),['timeout','options','steps']);
  assert.match(text,/must use a dedicated read-only build identity/i);
  assert.doesNotMatch(command,/\b(?:gcloud|kubectl|wrangler|docker|gh)\s/);
  assert.doesNotMatch(command,/git\s+push/);
});
