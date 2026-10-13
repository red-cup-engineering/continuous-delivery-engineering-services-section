import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDocument} from 'yaml';

const text=readFileSync(new URL('../cloudbuild.yaml',import.meta.url),'utf8');
const parsed=parseDocument(text,{uniqueKeys:true,merge:false});
const config=parsed.toJS({maxAliasCount:0});

test('Cloud Build receives the existing CD tests in the eligible default pool',()=>{
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
});
test('provider source revision is checked before any dependency or test execution',()=>{
  const command=config.steps[0].args[1];
  assert.equal(config.steps[0].args[0],'-euc');
  const checkCommit=command.indexOf('test "$$revision" = "$COMMIT_SHA"');
  const install=command.indexOf('npm ci');
  const check=command.indexOf('npm test');
  assert.ok(command.includes('revision="$$(git rev-parse --verify HEAD)"'));
  assert.ok(command.includes('test -n "$COMMIT_SHA"'));
  assert.ok(checkCommit>=0&&checkCommit<install&&install<check);
  assert.match(command,/npm ci --ignore-scripts --no-audit --no-fund/);
});
test('no unconditional privilege, mutable image, artifact publication, or deploy is implicit',()=>{
  assert.equal(config.substitutions,undefined,'the trigger must explicitly bind a digest-pinned image');
  assert.equal(config.serviceAccount,undefined,'the authenticated provider trigger binds the runtime principal');
  for(const field of ['availableSecrets','secrets','secretEnv','artifacts','images']) assert.equal(config[field],undefined);
  assert.deepEqual(Object.keys(config),['timeout','options','steps']);
  assert.match(text,/must use a dedicated read-only build identity/i);
  assert.doesNotMatch(config.steps[0].args[1],/gcloud|kubectl|wrangler|docker|gh\s/);
});
