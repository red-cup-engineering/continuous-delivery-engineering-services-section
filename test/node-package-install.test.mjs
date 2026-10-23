import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {planPnpmInstall,installPnpm} from '../scripts/node-package-install.mjs';
const fixtureRoot=new URL('../data/logs/node-package-install-fixtures/',import.meta.url);
fs.mkdirSync(fixtureRoot,{recursive:true});
const roots=[];
function fixture(pin='pnpm@11.28.5'){
 const root=fs.mkdtempSync(new URL('case-',fixtureRoot));roots.push(root);
 const directory=path.join(root,'source'),temporary=path.join(root,'runner-temp');
 fs.mkdirSync(directory);fs.mkdirSync(temporary);
 fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'fixture',packageManager:pin}));
 fs.writeFileSync(path.join(directory,'pnpm-lock.yaml'),"lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
 return {directory,temporary};
}
test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
for(const pin of [undefined,'pnpm@latest','pnpm@^11.28.5','pnpm@11.28.5-dev.1','npm@11.28.5'])
 test('refuses absent or non-exact stable PNPM pin '+pin,()=>{
  const input=fixture(pin);
  if(pin===undefined)fs.writeFileSync(path.join(input.directory,'package.json'),'{}');
  assert.throws(()=>installPnpm(input,{run:()=>assert.fail('must refuse before execution')}),/exact stable pnpm/);
 });
test('exact source pin controls bounded original frozen install',()=>{
 const input=fixture();let invoked=0;
 const result=installPnpm(input,{environment:{PATH:'/fixture',NODE_OPTIONS:'--unsafe',NPM_TOKEN:'not-for-tests'},run:(command,args,options)=>{
  invoked++;assert.equal(command,'npm');
  for(const arg of ['--package=pnpm@11.28.5','--frozen-lockfile','--ignore-scripts','--network-concurrency=4','--child-concurrency=1'])assert.ok(args.includes(arg));
  assert.ok(args.slice(0,args.indexOf('--')).includes('--ignore-scripts'));
  assert.ok(!args.some(arg=>arg.startsWith('--registry=')),'the original native npm configuration selects the bootstrap registry');
  assert.equal(options.cwd,fs.realpathSync(input.directory));
  assert.equal(options.env.NODE_OPTIONS,'--max-old-space-size=512');
  assert.equal(options.env.NPM_TOKEN,undefined);
  assert.equal(options.env.XDG_CACHE_HOME,path.join(input.temporary,'node-package-cache'));
  assert.ok(args.includes('--store-dir='+path.join(input.temporary,'node-package-store')));
  return {status:0};
 }});
 assert.equal(invoked,1);assert.equal(result.version,'11.28.5');
 assert.deepEqual(fs.readdirSync(input.temporary),[]);
});
test('an exact source workflow pin receives immutable packages without packageManager rewrites',()=>{
 const input=fixture();fs.writeFileSync(path.join(input.directory,'package.json'),'{"name":"immutable-published-package"}');
 const result=installPnpm({...input,pnpmVersion:'11.28.5'},{run:()=>({status:0})});
 assert.equal(result.version,'11.28.5');assert.equal(result.pinSource,'workflow');
 assert.equal(fs.readFileSync(path.join(input.directory,'package.json'),'utf8'),'{"name":"immutable-published-package"}');
 assert.throws(()=>installPnpm({...fixture(),pnpmVersion:'11.19.0'},{run:()=>assert.fail('conflicting source pins')}),/pins conflict/);
 assert.throws(()=>installPnpm({...input,pnpmVersion:'latest'},{run:()=>assert.fail('floating version')}),/exact stable/);
});
test('origin-scoped private credentials exist only during install and are removed before return',()=>{
 const input={...fixture(),registry:'https://registry.example.test/private/',username:'reader',password:'fixture-private-password'};
 let configPath;
 installPnpm(input,{environment:{REGISTRY_PASSWORD:input.password,NODE_AUTH_TOKEN:'other',NPM_PUBLISHER_PASSWORD:'another'},run:(_command,args,{env})=>{
  configPath=args.find(arg=>arg.startsWith('--config.userconfig=')).slice('--config.userconfig='.length);
  assert.equal(fs.statSync(configPath).mode&0o777,0o600);
  const config=fs.readFileSync(configPath,'utf8');
  assert.match(config,/\/\/registry\.example\.test\/private\/:username=reader/);
  assert.ok(config.includes(Buffer.from(input.password).toString('base64')));
  for(const name of ['REGISTRY_PASSWORD','NODE_AUTH_TOKEN','NPM_PUBLISHER_PASSWORD'])assert.equal(env[name],undefined);
  assert.ok(!args.some(arg=>arg.includes(input.password)));
  return {status:0};
 }});
 assert.equal(fs.existsSync(configPath),false);
});
test('failed subprocess also destroys private authentication',()=>{
 const input={...fixture(),registry:'https://registry.example.test/',token:'fixture-only-token'};
 let configPath;
 assert.throws(()=>installPnpm(input,{run:(_c,args)=>{
  configPath=args.find(arg=>arg.startsWith('--config.userconfig=')).slice('--config.userconfig='.length);
  assert.ok(fs.existsSync(configPath));return {status:42};
 }}),/exit 42/);
 assert.equal(fs.existsSync(configPath),false);
});
test('credential origin and credential dialect refuse ambiguity before execution',()=>{
 for(const override of [{registry:'http://registry.example.test/',token:'x'},{token:'x'},
  {registry:'https://user:password@registry.example.test/',token:'x'},
  {registry:'https://registry.example.test/',password:'x'},
  {registry:'https://registry.example.test/',token:'x',password:'y'},
  {registry:'https://registry.example.test/',token:'x\ninjected=true'}])
  assert.throws(()=>installPnpm({...fixture(),...override},{run:()=>assert.fail('unadmitted credential execution')}));
});
test('frozen source mutation fails receiving',()=>{
 const input=fixture();
 assert.throws(()=>installPnpm(input,{run:()=>{
  fs.appendFileSync(path.join(input.directory,'pnpm-lock.yaml'),'# changed\n');return {status:0};
 }}),/changed source package or lock/);
 assert.deepEqual(fs.readdirSync(input.temporary),[]);
});
test('source registry policy and workspace release-age exclusions remain untouched',()=>{
 const input=fixture();const npmrc='@fixture:registry=https://registry.example.test/\n';
 const workspace='minimumReleaseAgeExclude:\n  - "@fixture/*"\n';
 fs.writeFileSync(path.join(input.directory,'.npmrc'),npmrc);
 fs.writeFileSync(path.join(input.directory,'pnpm-workspace.yaml'),workspace);
 installPnpm(input,{run:()=>({status:0})});
 assert.equal(fs.readFileSync(path.join(input.directory,'.npmrc'),'utf8'),npmrc);
 assert.equal(fs.readFileSync(path.join(input.directory,'pnpm-workspace.yaml'),'utf8'),workspace);
});

