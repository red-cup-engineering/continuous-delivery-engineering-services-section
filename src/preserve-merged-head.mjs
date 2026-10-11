// Receive a merged PR's source custody. GitHub owns its branch-deletion policy.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const sha=/^[a-f0-9]{40}$/;
export async function preserveMergedHead({github,context,core,repository,pr}) {
  const event=context.payload.pull_request;
  if(!pr.merged||!event?.merged||pr.head.sha!==event.head.sha||pr.head.repo?.id!==repository.id)return;
  if(!sha.test(pr.head.sha)||!sha.test(pr.merge_commit_sha)||!Number.isSafeInteger(pr.number)||pr.number<1)throw new Error('Exact merged source identity required');
  const mergedAt=new Date(pr.merged_at);
  if(!Number.isFinite(mergedAt.valueOf()))throw new Error('Provider merge time required');
  const archive=`refs/archive/${mergedAt.toISOString().slice(0,10)}/${pr.head.ref}`;
  const token=core.getInput('github-token',{required:true});
  core.setSecret(token);
  const encoded=Buffer.from(`x-access-token:${token}`).toString('base64');core.setSecret(encoded);
  const directory=mkdtempSync(join(process.env.GITHUB_WORKSPACE,'.agent-work-source-'));
  const env={PATH:process.env.PATH,HOME:directory,LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'https',
    GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${encoded}`,GIT_CONFIG_KEY_1:'gc.auto',GIT_CONFIG_VALUE_1:'0'};
  const git=(...args)=>execFileSync('git',['-C',directory,...args],{env,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
  try {
    git('init','--bare','--quiet');git('check-ref-format',archive);
    git('remote','add','origin',`https://github.com/${repository.full_name}.git`);
    // Read Git objects only; neither checkout nor candidate source execution occurs.
    git('fetch','--quiet','--filter=tree:0','origin',`refs/pull/${pr.number}/head:refs/agent-work/source`);
    if(git('rev-parse','refs/agent-work/source').trim()!==pr.head.sha)throw new Error('Pull source advanced beyond the exact merge event');
    const renewed=(await github.rest.repos.get(context.repo)).data;
    if(renewed.id!==repository.id)throw new Error('Repository identity changed');
    const refs=()=>new Map(git('ls-remote','origin',archive,`refs/heads/${pr.head.ref}`).trim().split('\n').filter(Boolean).map(line=>{const [value,ref]=line.split(/\s+/);return[ref,value];}));
    const prior=refs().get(archive);
    if(prior&&prior!==pr.head.sha)throw new Error('Archive already binds another source revision');
    if(!prior)git('push','--atomic','--porcelain',`--force-with-lease=${archive}:`,'origin',`${pr.head.sha}:${archive}`);
    const after=refs();if(after.get(archive)!==pr.head.sha)throw new Error('Independent archive readback differs');
    const receipt={repositoryId:repository.id,pull:pr.number,head:pr.head.sha,merge:pr.merge_commit_sha,
      archive,archivedHead:after.get(archive),currentBranch:after.get(`refs/heads/${pr.head.ref}`)??null,
      automaticBranchDeletion:repository.delete_branch_on_merge,sourceCodeExecuted:false};
    const marker=`<!-- agent-archive:${repository.id}:${pr.number}:${pr.head.sha} -->`;
    const body=marker+'\n\nMerged source tip `'+pr.head.sha+'` is preserved at Git ref `'+archive+'`. Independent Git readback confirmed its exact revision.\n\nReceipt:\n```json\n'+JSON.stringify(receipt,null,2)+'\n```\n\nRestore with standard Git by fetching the recorded archive ref. GitHub applies the repository’s configured branch-deletion policy. This receiver creates only the archive ref; source, operating and customer receiving remain separate.';
    const comments=await github.paginate(github.rest.issues.listComments,{...context.repo,issue_number:pr.number,per_page:100});
    if(!comments.some(c=>c.user?.login==='github-actions[bot]'&&c.body===body))
      await github.rest.issues.createComment({...context.repo,issue_number:pr.number,body});
    core.summary.addHeading('Merged source custody').addCodeBlock(JSON.stringify(receipt,null,2),'json');
  } finally {rmSync(directory,{recursive:true,force:true});}
}
