/** Filter-free committed bytes, index and inventory; ports are Node builtins. */
export function verifyCommittedSource({directory,commit,tree,gitExecutable,allowGitlinks=false},
  {readFileSync,readdirSync,lstatSync,realpathSync,resolve,join,spawnSync,createHash,environmentPath=''}){
  const refuse=()=>{throw new Error('trusted source identity or bytes refused');};
  const root=resolve(directory),stat=lstatSync(root);
  if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(root)!==root||!gitExecutable?.startsWith('/'))refuse();
  const git=args=>{
    const result=spawnSync(gitExecutable,['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',timeout:15000,maxBuffer:32*1024*1024,
      env:{PATH:environmentPath,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''}});
    if(result.error||result.status!==0)refuse();return result.stdout;
  };
  const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(git(['rev-parse','--show-toplevel']).trim()!==root||git(['rev-parse','HEAD']).trim()!==commit
    ||git(['rev-parse','HEAD^{tree}']).trim()!==tree)refuse();
  const records=git(['ls-tree','-r','-z',commit]).split('\0').filter(Boolean);if(!records.length)refuse();
  const tracked=new Set(),links=new Set(),index=[];
  for(const record of records){
    const tab=record.indexOf('\t'),[mode,type,hash]=record.slice(0,tab).split(' '),relative=record.slice(tab+1);
    if(!relative||relative.startsWith('/')||relative.split('/').some(part=>['.','..','.git'].includes(part)))refuse();
    index.push(`${mode} ${hash} 0\t${relative}`);
    if(allowGitlinks&&mode==='160000'&&type==='commit'){links.add(relative);continue;}
    const file=join(root,relative),entry=lstatSync(file);
    if(type!=='blob'||!['100644','100755'].includes(mode)||!entry.isFile()||entry.isSymbolicLink()||realpathSync(file)!==file
      ||blob(readFileSync(file))!==hash||Boolean(entry.mode&0o111)!==(mode==='100755'))refuse();
    tracked.add(relative);
  }
  if(git(['ls-files','--stage','-z'])!==index.join('\0')+'\0')refuse();
  const walk=directory=>{for(const name of readdirSync(join(root,directory))){
    if(name==='.git'){if(directory)refuse();continue;}
    const path=directory?directory+'/'+name:name;
    const entry=lstatSync(join(root,path));
    if(links.has(path)){if(!entry.isDirectory()||entry.isSymbolicLink())refuse();continue;}
    if(entry.isDirectory())walk(path);
    else if(!tracked.has(path))refuse();
  }};walk('');
  return {root,tracked};
}

/** Trusted owner policy, run before importing any selected controller code. */
export async function verifyTrustedSource(directory,identity,{gitExecutable,channelsBlob,controller=false,sourcePolicy='controller-admission-v1'}={}){
  const fs=await import('node:fs'),path=await import('node:path'),child=await import('node:child_process'),crypto=await import('node:crypto');
  const {readFileSync,lstatSync,realpathSync}=fs,{join}=path;
  const refuse=()=>{throw new Error('trusted source identity or bytes refused');};
  if(!['controller-admission-v1','refuse-declared-sql-before-bootstrap-v1'].includes(sourcePolicy))refuse();
  const {root,tracked}=verifyCommittedSource({directory,...identity,gitExecutable,allowGitlinks:!controller},{...fs,...path,...child,...crypto,environmentPath:process.env.PATH??''});
  const blob=bytes=>crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(controller){
    if(identity.repository!=='red-cup-engineering/guix-machine-release-service'
      ||JSON.parse(readFileSync(join(root,'package.json'),'utf8')).name!=='@red-cup-engineering/guix-machine-release-service')refuse();
  }else{
    const definition=identity.definition;
    if(!(definition==='.'||typeof definition==='string'&&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(definition)
      &&definition.split('/').every(part=>!['.','..','.git'].includes(part))))refuse();
    const selected=join(root,definition);if(realpathSync(selected)!==selected||!lstatSync(selected).isDirectory())refuse();
    for(const name of ['machine.json','machine.scm','channels.scm','dependencies.lock.yaml'])if(!tracked.has(definition==='.'?name:definition+'/'+name))refuse();
    if(JSON.parse(readFileSync(join(selected,'machine.json'),'utf8')).repository!==identity.repository)refuse();
    const channelFile=join(selected,'channels.scm');
    if(blob(readFileSync(channelFile))!==channelsBlob)refuse();
    if(sourcePolicy==='refuse-declared-sql-before-bootstrap-v1'){
      if(!tracked.has('.gitmodules'))refuse();
      for(const file of [join(root,'.gitmodules'),join(selected,'machine.json'),join(selected,'dependencies.lock.yaml')])
        if(/sqlite|sql[.]js|@libsql/i.test(readFileSync(file,'utf8')))throw new Error('Source acquisition refused: SQLite is declared in current source or dependency data.');
    }
  }
  return root;
}

/** Fixed owner source only; generated callers never import selected checkout code. */
export const trustedSourceVerifierSource=()=>verifyCommittedSource.toString()+'\n'+verifyTrustedSource.toString();
