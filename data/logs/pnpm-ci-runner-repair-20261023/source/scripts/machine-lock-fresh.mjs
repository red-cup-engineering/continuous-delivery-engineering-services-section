#!/usr/bin/env node
// Does a machine snapshot's committed lock (dependencies.lock.yaml) still satisfy the workspace its pinned
// controller composes? The check resolves the way a release does (github-machine-release.scm, mode `resolve`):
// every pinned source at its exact commit, the pinned controller's `prepare-sources.mjs --manifests-only`, then
// pnpm 11.9.0 against the committed lock, frozen and lockfile-only, so nothing is downloaded. A plain pnpm run
// at the snapshot root cannot answer this: the lock belongs to the composed workspace, not to the repository.
//
// With `--base DIR` it is a ratchet: a stale head fails only when the base was fresh, so a pull request is not
// blocked by a main that is already stale (the summary still says so). An unreadable head always fails.
//
//   node scripts/machine-lock-fresh.mjs SNAPSHOT_DIR WORK_DIR [--base BASE_SNAPSHOT_DIR]
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const CONTROLLER='@red-cup-engineering/guix-machine-release-service';
// The release's own invocation (github-machine-release.scm): pnpm itself is pointed at the public registry too, so
// a runner's npm configuration (a house registry for every scope) never decides how the lock resolves.
const PNPM=['--registry=https://registry.npmjs.org/','exec','--yes','--package=pnpm@11.9.0','--','pnpm','--registry=https://registry.npmjs.org/'];

function run(program,args,options={}){
  const result=spawnSync(program,args,{encoding:'utf8',maxBuffer:256*1024*1024,...options});
  if(result.status!==0&&!options.allowFailure)throw new Error(`${program} ${args.join(' ')} failed (${result.status}): ${(result.stderr||result.stdout||'').slice(-2000)}`);
  return result;
}
const slug=repository=>repository.replace('/','_');

/** A repository at an exact commit, its blobs read on demand, as the release materializes it for prepare-sources. */
function materialize(directory,repository,commit){
  if(!existsSync(join(directory,'.git'))){
    mkdirSync(directory,{recursive:true});
    run('git',['clone','-q','--filter=blob:none','--no-checkout',`https://github.com/${repository}.git`,directory]);
  }
  if(run('git',['-C',directory,'cat-file','-e',`${commit}^{commit}`],{allowFailure:true}).status!==0)
    run('git',['-C',directory,'fetch','-q','--depth=1','origin',commit]);
  run('git',['-C',directory,'read-tree','--empty']);
  run('git',['-C',directory,'update-ref','--no-deref','HEAD',commit]);
}

/** Read one snapshot: fresh, stale (with pnpm's reason), or unreadable (the composition itself failed). */
export function readLock(snapshot,work,label='head'){
  const spec=JSON.parse(readFileSync(join(snapshot,'sources.json'),'utf8'));
  const lock=join(snapshot,'dependencies.lock.yaml');
  if(!existsSync(lock))return {state:'unreadable',reason:'the snapshot commits no dependencies.lock.yaml'};
  const owner=spec.owners?.[CONTROLLER];
  if(!owner?.repository)return {state:'unreadable',reason:`sources.json names no owner for ${CONTROLLER}`};
  const repositories=spec.repositories.map(source=>{
    const directory=join(work,'sources',slug(source.repository));
    materialize(directory,source.repository,source.commit);
    return {...source,directory};
  });
  const controller=repositories.find(r=>r.repository===owner.repository);
  if(!controller)return {state:'unreadable',reason:`the machine pins no source for its controller ${owner.repository}`};
  // The controller alone is checked out: its scripts run (the release materializes it the same way).
  run('git',['-C',controller.directory,'reset','-q','--hard',controller.commit]);
  const service=join(controller.directory,owner.path??'.');
  const workspace=join(work,label),plan=join(work,`${label}.prepare.json`);
  rmSync(workspace,{recursive:true,force:true});
  writeFileSync(plan,JSON.stringify({...spec,repositories,output:workspace}));
  const prepared=run(process.execPath,[join(service,'scripts/prepare-sources.mjs'),plan,'--manifests-only'],{allowFailure:true});
  if(prepared.status!==0)return {state:'unreadable',controller:controller.commit,reason:(prepared.stderr||prepared.stdout).slice(-2000)};
  copyFileSync(lock,join(workspace,'pnpm-lock.yaml'));
  const installed=run('npm',[...PNPM,'--dir',workspace,'install','--frozen-lockfile','--lockfile-only','--ignore-scripts','--cache-dir',join(work,'registry-cache')],{allowFailure:true});
  const output=`${installed.stdout}\n${installed.stderr}`;
  if(installed.status===0)return {state:'fresh',controller:controller.commit};
  const reason=output.slice(output.indexOf('ERR_PNPM')>=0?output.indexOf('ERR_PNPM'):-2000).slice(0,2000);
  return {state:/ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/.test(output)?'stale':'unreadable',controller:controller.commit,reason};
}

/** The ratchet: a stale head fails unless the base was already stale. An unreadable head is no reading, so it
 *  always fails: passing it would report a lock nobody checked. */
export function verdict(head,base){
  if(head.state==='fresh')return {fails:false,summary:'fresh'};
  if(head.state==='unreadable')return {fails:true,summary:'unreadable'};
  if(base&&base.state===head.state)return {fails:false,summary:`${head.state}, as the base already was`};
  return {fails:true,summary:head.state};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),at=args.indexOf('--base');
  const baseDir=at>=0?args[at+1]:undefined,[snapshot,work]=args.filter((a,i)=>!a.startsWith('--')&&(at<0||i!==at+1));
  if(!snapshot||!work){process.stderr.write('usage: machine-lock-fresh.mjs SNAPSHOT_DIR WORK_DIR [--base BASE_SNAPSHOT_DIR]\n');process.exit(2);}
  const head=readLock(resolve(snapshot),resolve(work),'head');
  const base=head.state!=='fresh'&&baseDir?readLock(resolve(baseDir),resolve(work),'base'):undefined;
  const result=verdict(head,base);
  process.stdout.write(JSON.stringify({kind:'machine-lock-freshness',head,...(base?{base}:{}),verdict:result.summary,fails:result.fails},null,2)+'\n');
  if(result.fails)process.exitCode=1;
}
