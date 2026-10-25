import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import * as fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {renderCi,REF,REUSABLE} from '../generator/generate-ci.mjs';

const source=readFileSync(new URL('../.github/workflows/node-package.yml',import.meta.url),'utf8');
const workflow=parse(source);

test('existing callers keep install, check and npm test defaults',()=>{
  const inputs=workflow.on.workflow_call.inputs;
  assert.equal(inputs.install.default,true);
  assert.equal(inputs.check.default,true);
  assert.equal(inputs['test-script'].default,'test');
  assert.equal(inputs.install.type,'boolean');
  assert.equal(inputs.check.type,'boolean');
  assert.equal(inputs['test-script'].type,'string');
});

test('dependency-free source tests skip install and checks without changing the default workflow',()=>{
  const steps=workflow.jobs.package.steps;
  const install=steps.find(s=>s.name==='Install dependencies when needed');
  const check=steps.find(s=>s.name==='Check package when requested');
  const testStep=steps.find(s=>s.name==='Run selected named test script');
  assert.equal(install.if,"inputs.install && inputs.package-manager == 'npm'");
  assert.equal(check.if,'inputs.check');
  assert.equal(testStep.env.TEST_SCRIPT,'\${{ inputs.test-script }}');
  assert.match(testStep.run,/\['run','--if-present',script/);
  assert.match(testStep.run,/Invalid npm test script name/);
});

test('PNPM receiving binds immutable original source and confines registry secrets to installation',()=>{
  const inputs=workflow.on.workflow_call.inputs;
  assert.equal(inputs['package-manager'].default,'npm');
  assert.equal(inputs['supplier-ref'].default,'');
  const steps=workflow.jobs.package.steps;
  const source=steps.find(s=>s.name==='Receive exact PNPM installer source');
  assert.equal(source.with.repository,'red-cup-engineering/continuous-delivery-engineering-services-section');
  assert.equal(source.with.ref,'${{ inputs.supplier-ref }}');
  assert.equal(source.with['persist-credentials'],false);
  const install=steps.find(s=>s.name==='Install original frozen PNPM graph');
  assert.equal(install.if,"inputs.install && inputs.package-manager == 'pnpm'");
  assert.equal(install.env.REGISTRY_TOKEN,'${{ secrets.registry-token }}');
  assert.equal(install.env.REGISTRY_PASSWORD,'${{ secrets.registry-password }}');
  assert.ok(!workflow.jobs.package.env);
  for(const step of steps.filter(s=>/Check package|Run selected/.test(s.name??'')))
    assert.ok(!Object.keys(step.env??{}).some(name=>/TOKEN|PASSWORD/.test(name)));
});

test('caller cannot turn an npm script name into arbitrary shell',()=>{
  const run=workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run;
  assert.match(run,/a-zA-Z0-9:._-/);
  const root=nativePackage('node capture.mjs');
  fs.writeFileSync(path.join(root,'capture.mjs'),"import fs from 'node:fs';fs.writeFileSync('should-not-run','');");
  const rejected=executeNamedTest(root,[],{TEST_SCRIPT:'test; touch should-not-run'});
  assert.notEqual(rejected.status,0);assert.equal(fs.existsSync(path.join(root,'should-not-run')),false);
  assert.ok(!run.includes('eval '));
});

test('original caller generator binds PNPM source, supplier, paths and one named credential',()=>{
 const ref='a'.repeat(40);
 const produced=parse(renderCi({node:true,lean:[],content:false},{ref,runsOn:['self-hosted','Linux','X64','bare-cedar-fog'],
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',testArguments:['--test-concurrency=1'],paths:['lib/organizing'],registryUrl:'https://registry.example.test/',
   registryUsername:'reader',registryPasswordSecret:'SOURCE_REGISTRY_READ_PASSWORD'}}));
 const job=produced.jobs['node-package'];
 assert.equal(job.with['supplier-ref'],ref);
 assert.equal(job.with['source-commit'],'${{ github.sha }}');
 assert.equal(job.with['package-manager'],'pnpm');
 assert.equal(job.with['pnpm-version'],'11.28.5');
 assert.deepEqual(JSON.parse(job.with['test-arguments']),['--test-concurrency=1']);
 assert.deepEqual(JSON.parse(job.with.paths),['lib/organizing']);
 assert.equal(job.with.concurrency,1);
 assert.equal(job.secrets['registry-password'],'${{ secrets.SOURCE_REGISTRY_READ_PASSWORD }}');
 assert.equal(job.with['registry-username'],'reader');
});

test('caller generation refuses ambiguous secrets, unbound identity and shell-like secret names',()=>{
 for(const delta of [{registryPasswordSecret:'BAD;COMMAND'},{registryPasswordSecret:'PASSWORD',registryTokenSecret:'TOKEN'},
  {registryPasswordSecret:'PASSWORD',registryUrl:undefined}, {paths:['../outside']}])
  assert.throws(()=>renderCi({node:true,lean:[],content:false},{ref:'a'.repeat(40),runsOn:['self-hosted','bare-cedar-fog'],
   nodePackage:{packageManager:'pnpm',paths:['lib/organizing'],registryUrl:'https://registry.example.test/',registryUsername:'reader',...delta}}));
});

const caseRoot=new URL('../data/logs/node-package-options-fixtures/',import.meta.url);
fs.mkdirSync(caseRoot,{recursive:true});
const nativeRoots=[];test.after(()=>{for(const root of nativeRoots)fs.rmSync(root,{recursive:true,force:true});});
function nativePackage(script){
 const root=fs.mkdtempSync(new URL('case-',caseRoot));nativeRoots.push(root);
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({private:true,type:'module',scripts:{test:script}}));
 return root;
}
function executeNamedTest(root,args,extra={}){
 const environment={...process.env,TEST_SCRIPT:'test',TEST_ARGUMENTS:JSON.stringify(args),...extra};
 delete environment.NODE_TEST_CONTEXT;
 return spawnSync('bash',['-c',workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run],{
  cwd:root,encoding:'utf8',timeout:15000,env:environment});
}
test('native descriptor bounds actual Node workers before original glob; appended npm flags do not',()=>{
 const original='node --test "test/**/*.test.mjs"';
 const root=nativePackage(original);
 fs.mkdirSync(path.join(root,'test/nested'),{recursive:true});
 for(const index of [0,1]){
  const source=`import test from 'node:test';import fs from 'node:fs';import path from 'node:path';import {setTimeout} from 'node:timers/promises';
test('file worker is serial',async()=>{
 const root=process.env.SERIAL_ROOT;
 if(process.env.PARALLEL_CONTROL==='true'){
  fs.writeFileSync(path.join(root,'started-${index}'),'');
  const deadline=Date.now()+5000;while(!fs.existsSync(path.join(root,'started-${1-index}'))){if(Date.now()>deadline)throw Error('parallel native control did not start');await setTimeout(5);}
 }
 const lock=path.join(root,'worker.lock');const fd=fs.openSync(lock,'wx');
 try{await setTimeout(300);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
});`;
  fs.writeFileSync(path.join(root,'test/nested',index+'.test.mjs'),source);
 }
 const parallel=executeNamedTest(root,['--test-concurrency=2'],{SERIAL_ROOT:root,PARALLEL_CONTROL:'true'});
 assert.equal(parallel.status,1,parallel.stdout+parallel.stderr);
 assert.match(parallel.stdout+parallel.stderr,/EEXIST/);
 const serial=executeNamedTest(root,[],{SERIAL_ROOT:root,PARALLEL_CONTROL:'false',
  NODE_TEST:JSON.stringify({expectedScript:original,files:['test/**/*.test.mjs'],concurrency:1})});
 assert.equal(serial.status,0,serial.stdout+serial.stderr);
 assert.match(serial.stdout,/tests 2/);
});
test('native descriptor refuses changed script, lifecycle hooks, argv mixing and escaped patterns before execution',()=>{
 const original='node --test "test/**/*.test.mjs"';
 const root=nativePackage(original);
 const descriptor={expectedScript:original,files:['test/**/*.test.mjs'],concurrency:1};
 for(const delta of [{expectedScript:'node other.mjs'},{files:['../other.test.mjs']},{concurrency:0},{extra:true}]){
  const result=executeNamedTest(root,[],{NODE_TEST:JSON.stringify({...descriptor,...delta})});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
 }
 const mixed=executeNamedTest(root,['--test-concurrency=1'],{NODE_TEST:JSON.stringify(descriptor)});
 assert.notEqual(mixed.status,0);
 for(const scripts of [{test:'node changed.mjs'},{test:original,pretest:'node hook.mjs'},{test:original,posttest:'node hook.mjs'}]){
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module',scripts}));
  const result=executeNamedTest(root,[],{NODE_TEST:JSON.stringify(descriptor)});
  assert.notEqual(result.status,0);assert.match(result.stderr,/differs from original script or lifecycle hooks/);
 }
});
test('generator preserves the exact original native script and places its resource limit in a closed descriptor',()=>{
 const nodeTest={expectedScript:'node --test "test/**/*.test.mjs"',files:['test/**/*.test.mjs'],concurrency:1};
 const options={ref:'a'.repeat(40),runsOn:['self-hosted','bare-cedar-fog'],
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',paths:['lib/organizing'],nodeTest}};
 const produced=parse(renderCi({node:true,lean:[],content:false},options));
 assert.deepEqual(JSON.parse(produced.jobs['node-package'].with['node-test']),nodeTest);
 for(const delta of [{expectedScript:'node other.mjs'},{files:['../outside']},{concurrency:0},{unexpected:'field'}])
  assert.throws(()=>renderCi({node:true,lean:[],content:false},{...options,nodePackage:{...options.nodePackage,nodeTest:{...nodeTest,...delta}}}));
});
test('structured arguments remain literal through native npm and malformed vectors never start a script',()=>{
 const root=nativePackage('node capture.mjs');
 fs.writeFileSync(path.join(root,'capture.mjs'),"import fs from 'node:fs';fs.writeFileSync('received.json',JSON.stringify(process.argv.slice(2)));");
 const argument='$(touch SHOULD_NOT_EXIST); echo fixture';
 const result=executeNamedTest(root,[argument]);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'received.json'))),[argument]);assert.equal(fs.existsSync(path.join(root,'SHOULD_NOT_EXIST')),false);
 fs.rmSync(path.join(root,'received.json'));
 const malformed=spawnSync('bash',['-c',workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script').run],{
  cwd:root,encoding:'utf8',env:{...process.env,TEST_SCRIPT:'test',TEST_ARGUMENTS:'{"not":"argv"}'}});
 assert.notEqual(malformed.status,0);assert.equal(fs.existsSync(path.join(root,'received.json')),false);
});


test('exact Node supplier flows through original generator and reusable workflow without changing defaults',()=>{
 assert.equal(workflow.on.workflow_call.inputs['node-version'].default,'24');
 assert.equal(workflow.jobs.package.steps.find(s=>s.uses?.startsWith('actions/setup-node@')).with['node-version'],'${{ inputs.node-version }}');
 const options={ref:'a'.repeat(40),runsOn:['ubuntu-24.04'],publicRepository:true,
  nodePackage:{packageManager:'pnpm',pnpmVersion:'11.28.5',nodeVersion:'24.19.0',paths:['services/pnpm-services-section']}};
 assert.equal(parse(renderCi({node:true,lean:[],content:false},options)).jobs['node-package'].with['node-version'],'24.19.0');
 for(const version of ['24','latest','24.x','>=24.19.0','24.19.0; touch injected',['24.19.0'],null,{},24])
  assert.throws(()=>renderCi({node:true,lean:[],content:false},{...options,nodePackage:{...options.nodePackage,nodeVersion:version}}));
});

const noInstallOptions=()=>({ref:REF,runsOn:['ubuntu-24.04'],publicRepository:true,
 workflows:['ci'],checks:['node-package'],nodePackage:{packageManager:'npm',paths:['.'],install:false,check:false,
  nodeVersion:'24.21.0',testScript:'test:component',timeoutMinutes:15,
  nodeTest:{expectedScript:'node --test "test/component.test.mjs"',files:['test/component.test.mjs'],concurrency:1}}});
const allDetected={node:true,lean:['.'],content:true};
test('generic no-install profile excludes unrelated installers and pins its exact original native command',()=>{
 const options=noInstallOptions(),doc=parse(renderCi(allDetected,options));
 assert.deepEqual(Object.keys(doc.jobs),['node-package']);
 assert.deepEqual(doc.permissions,{contents:'read'});
 const job=doc.jobs['node-package'];
 assert.equal(job.uses,`${REUSABLE}/node-package.yml@${REF}`);
 assert.equal(job.with['supplier-ref'],REF);
 assert.equal(job.with['source-commit'],'${{ github.sha }}');
 assert.equal(job.with.install,false);assert.equal(job.with.check,false);
 assert.equal(job.with['native-no-install'],true);
 assert.equal(job.with['node-version'],'24.21.0');assert.equal(job.with['timeout-minutes'],15);
 assert.equal(job.with['test-script'],'test:component');assert.equal(job.with['package-manager'],'npm');
 assert.deepEqual(JSON.parse(job.with.paths),['.']);assert.equal(job.with.concurrency,1);
 assert.deepEqual(JSON.parse(job.with['node-test']),options.nodePackage.nodeTest);
 assert.equal(job.secrets,undefined);
 assert.ok(!Object.keys(job.with).some(name=>/registry|pnpm|arguments/.test(name)));
});
test('closed no-install profile refuses missing, credential-bearing, install and mixed inputs',()=>{
 const original=noInstallOptions();
 const deltas=[{install:true},{check:true},{install:'false'},{check:0},{nodeTest:undefined},{testScript:undefined},
  {nodeVersion:undefined},{timeoutMinutes:undefined},{nodeTest:{}},{testArguments:[]},{testArguments:['anything']},
  {pnpmVersion:'11.28.5'},{registryUrl:'https://registry.example.test/'},{registryUsername:'reader'},
  {registryTokenSecret:'TOKEN'},{registryPasswordSecret:'PASSWORD'},{unexpected:true},
  {paths:[]},{paths:['.','.']},{paths:['../outside']},{paths:['a/../outside']},{paths:['/outside']},
  {paths:['${{ github.workspace }}']},{paths:['a\\b']},{paths:new Array(1)},{paths:['a\nname']},
  {nodeVersion:'24'},{testScript:null},{nodeTest:null}];
 for(const delta of deltas)assert.throws(()=>renderCi(allDetected,{...original,nodePackage:{...original.nodePackage,...delta}}),JSON.stringify(delta));
 for(const key of Object.keys(original.nodePackage)){
  const nodePackage={...original.nodePackage};delete nodePackage[key];
  assert.throws(()=>renderCi(allDetected,{...original,nodePackage}),key);
 }
 for(const checks of [undefined,['node-package','content'],['content']])
  assert.throws(()=>renderCi(allDetected,{...original,checks}));
 assert.throws(()=>renderCi(allDetected,{...original,ref:'a'.repeat(40)}),/generator source commit/);
});
test('timeout defaults preserve old behavior; both jobs receive finite caller bounds',()=>{
 assert.equal(workflow.on.workflow_call.inputs['timeout-minutes'].default,360);
 assert.equal(workflow.on.workflow_call.inputs['timeout-minutes'].type,'number');
 for(const job of Object.values(workflow.jobs))
  assert.equal(job['timeout-minutes'],'${{ inputs.timeout-minutes >= 1 && inputs.timeout-minutes <= 360 && inputs.timeout-minutes || 360 }}');
 for(const timeoutMinutes of [1,15,360]){
  const options=noInstallOptions();options.nodePackage.timeoutMinutes=timeoutMinutes;
  assert.equal(parse(renderCi(allDetected,options)).jobs['node-package'].with['timeout-minutes'],timeoutMinutes);
 }
 for(const timeoutMinutes of [0,-1,1.5,361,Infinity,NaN,'15',null]){
  const options=noInstallOptions();options.nodePackage.timeoutMinutes=timeoutMinutes;
  assert.throws(()=>renderCi(allDetected,options));
 }
 const pnpm={ref:REF,runsOn:['self-hosted','existing-runner'],nodePackage:{packageManager:'pnpm',paths:['.']}};
 assert.equal(parse(renderCi({node:true,lean:[],content:false},pnpm)).jobs['node-package'].with['timeout-minutes'],undefined);
});
test('no-install preflight rejects credentials, missing native input, unbounded timeout and bad paths before checkout',()=>{
 const step=workflow.jobs.discover.steps[0];assert.equal(step.name,'Admit bounded package inputs');
 assert.equal(step.env.REGISTRY_CONFIGURED,"${{ inputs.registry-url != '' || inputs.registry-username != '' || secrets.registry-token != '' || secrets.registry-password != '' }}");
 const env={...process.env,TIMEOUT_MINUTES:'15',INSTALL:'false',NATIVE_NO_INSTALL:'true',CHECK:'false',PACKAGE_MANAGER:'npm',
  PNPM_VERSION:'',NODE_VERSION:'24.21.0',PATHS:'["."]',TEST_SCRIPT:'test:component',TEST_ARGUMENTS:'[]',
  NODE_TEST:JSON.stringify(noInstallOptions().nodePackage.nodeTest),SUPPLIER_REF:REF,SOURCE_COMMIT:'b'.repeat(40),REGISTRY_CONFIGURED:'false'};
 const run=delta=>spawnSync('bash',['-c',step.run],{encoding:'utf8',timeout:5000,env:{...env,...delta}});
 assert.equal(run({}).status,0);
 for(const delta of [{TIMEOUT_MINUTES:'0'},{TIMEOUT_MINUTES:'361'},{TIMEOUT_MINUTES:'1.5'},{INSTALL:'true'},
  {PACKAGE_MANAGER:'pnpm'},{CHECK:'true'},{PNPM_VERSION:'11.28.5'},{REGISTRY_CONFIGURED:'true'},
  {SOURCE_COMMIT:'main'},{SUPPLIER_REF:''},{NODE_VERSION:'24'},{TEST_SCRIPT:'test;whoami'},
  {NODE_TEST:''},{TEST_ARGUMENTS:'["arg"]'},{PATHS:'[]'},{PATHS:'[".","."]'},
  {PATHS:'["../outside"]'},{PATHS:'["${{ github.workspace }}"]'},{PATHS:'not-json'}])
  assert.notEqual(run(delta).status,0,JSON.stringify(delta));
 // Existing normal callers preserve default discovery and script behavior.
 for(const INSTALL of ['true','false'])
  assert.equal(run({INSTALL,NATIVE_NO_INSTALL:'false',PATHS:'',NODE_VERSION:'24',NODE_TEST:'',SOURCE_COMMIT:'',SUPPLIER_REF:''}).status,0);
});
test('both no-install checkout phases assert exact source rather than treating input text as a receipt',()=>{
 const discovery=workflow.jobs.discover.steps.find(s=>s.name==='Verify no-install discovery source');
 assert.equal(discovery.if,'inputs.native-no-install');assert.match(discovery.run,/git rev-parse HEAD/);
 const packageGate=workflow.jobs.package.steps.find(s=>s.name==='Validate package manager and source supplier');
 assert.equal(packageGate.env.NATIVE_NO_INSTALL,'${{ inputs.native-no-install }}');
 assert.match(packageGate.run,/if \[ "\$NATIVE_NO_INSTALL" = 'true' \]/);
 assert.match(packageGate.run,/Exact no-install source checkout required/);
 for(const job of Object.values(workflow.jobs)){
  const checkout=job.steps.find(s=>s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref,'${{ inputs.source-commit || github.sha }}');
  assert.equal(checkout.with['persist-credentials'],false);
 }
});
test('no-install executes the named native test and refuses missing descriptor, Node drift and lifecycle hooks',()=>{
 const script='node --test "test/component.test.mjs"',root=nativePackage(script);
 fs.mkdirSync(path.join(root,'test'));fs.writeFileSync(path.join(root,'test/component.test.mjs'),
  "import test from 'node:test';import assert from 'node:assert/strict';test('selected component',()=>assert.equal(2+2,4));\n");
 const native={NATIVE_NO_INSTALL:'true',NODE_VERSION:process.versions.node,NODE_TEST:JSON.stringify({expectedScript:script,files:['test/component.test.mjs'],concurrency:1})};
 const good=executeNamedTest(root,[],native);assert.equal(good.status,0,good.stdout+good.stderr);assert.match(good.stdout,/selected component/);
 for(const delta of [{NODE_TEST:''},{NODE_VERSION:'0.0.0'}])assert.notEqual(executeNamedTest(root,[],{...native,...delta}).status,0);
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module',scripts:{test:script,pretest:'node hook.mjs'}}));
 const hook=executeNamedTest(root,[],native);assert.notEqual(hook.status,0);assert.match(hook.stderr,/lifecycle hooks/);
});

test('strict native receiving is opt-in and disables automatic package-manager cache without altering legacy callers',()=>{
 const inputs=workflow.on.workflow_call.inputs;
 assert.equal(inputs['native-no-install'].default,false);
 assert.equal(inputs['native-no-install'].type,'boolean');
 const setup=workflow.jobs.package.steps.find(s=>s.uses?.startsWith('actions/setup-node@'));
 assert.equal(setup.uses,'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444');
 assert.equal(setup.with['package-manager-cache'],'${{ !inputs.native-no-install }}');
 assert.equal(setup.with.cache,undefined,'no explicit cache may bypass the opt-in guard');
 const run=workflow.jobs.package.steps.find(s=>s.name==='Run selected named test script');
 assert.equal(run.env.NATIVE_NO_INSTALL,'${{ inputs.native-no-install }}');
 // These fixtures exercise native receiving with no lockfile and no package
 // manager subprocess. The action input assertion above is static supplier
 // conformance, not a simulated successful GitHub Actions execution.
 for(const packageManager of ['npm@11.0.0','pnpm@11.28.5']){
  const script='node --test "test/component.test.mjs"',root=nativePackage(script);
  const manifest={type:'module',packageManager,scripts:{test:script}};
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(manifest));
  fs.mkdirSync(path.join(root,'test'));fs.writeFileSync(path.join(root,'test/component.test.mjs'),
   "import test from 'node:test';test('dependency-free component',()=>{});\n");
  const descriptor={files:['test/component.test.mjs'],expectedScript:script,concurrency:1};
  const result=executeNamedTest(root,[],{NATIVE_NO_INSTALL:'true',NODE_VERSION:process.versions.node,NODE_TEST:JSON.stringify(descriptor)});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),manifest);
  assert.deepEqual(fs.readdirSync(root).sort(),['package.json','test']);
 }
 const legacy=nativePackage('node capture.mjs');
 fs.writeFileSync(path.join(legacy,'capture.mjs'),"import fs from 'node:fs';fs.writeFileSync('legacy-ran','');");
 const result=executeNamedTest(legacy,[],{INSTALL:'false',NATIVE_NO_INSTALL:'false',NODE_TEST:'',NODE_VERSION:'24'});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(fs.existsSync(path.join(legacy,'legacy-ran')),true);
});

