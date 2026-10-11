// GitHub event receiving. No branch code, issue prose, or artifact is executed.
const persistent = /^(?:release\/|claim\/|rescue\/|emergency-snapshot|gh-pages$|automation-state$)/;
const sha = /^[a-f0-9]{40}$/;
export async function receiveAgentWork({github, context, core}) {
  const {owner, repo}=context.repo;
  const repository=(await github.rest.repos.get({owner,repo})).data;
  const ensureLabel=async(name,color,description)=>{
    try {await github.rest.issues.getLabel({owner,repo,name});}
    catch(e) {if(e.status!==404)throw e;try{await github.rest.issues.createLabel({owner,repo,name,color,description});}catch(race){if(race.status!==422)throw race;}}
  };
  await ensureLabel('agent:work','1d76db','Work with a branch, source revision and explicit receiving criteria');
  await ensureLabel('agent:blocked','b60205','An independently recorded execution or receiving obstruction');
  await ensureLabel('agent:received','0e8a16','Source merged; operating and customer receiving remain separate');
  const label=async(number,name)=>github.rest.issues.addLabels({owner,repo,issue_number:number,labels:[name]});
  if(context.eventName==='pull_request_target') {
    const event=context.payload.pull_request;
    // Read the current provider object rather than trusting stale event state.
    const pr=(await github.rest.pulls.get({owner,repo,pull_number:event.number})).data;
    if(pr.head.repo?.id!==repository.id)return;
    await label(pr.number,pr.merged?'agent:received':'agent:work');
    if(pr.merged) {try{await github.rest.issues.removeLabel({owner,repo,issue_number:pr.number,name:'agent:blocked'});}catch(e){if(e.status!==404)throw e;}}
    core.summary.addHeading('Agent source receiving').addTable([
      [{data:'Pull',header:true},{data:'Exact head',header:true},{data:'State',header:true}],
      [`#${pr.number}`,pr.head.sha,pr.merged?'merged':pr.state]
    ]).addRaw('Source merge is separate from installation, deployment and receiver acceptance.\n');
    await core.summary.write();return;
  }
  if(context.eventName!=='push'||context.payload.deleted)return;
  const branch=context.ref.replace(/^refs\/heads\//,'');
  if(branch===repository.default_branch||persistent.test(branch)||!sha.test(context.sha))return;
  const observed=(await github.rest.git.getRef({owner,repo,ref:`heads/${branch}`})).data;
  if(observed.object.sha!==context.sha){core.info('Branch advanced beyond this event; the later event owns intake.');return;}
  const existing=await github.paginate(github.rest.pulls.list,{owner,repo,state:'open',head:`${owner}:${branch}`,per_page:100});
  if(existing.length){await label(existing[0].number,'agent:work');return;}
  const comparison=(await github.rest.repos.compareCommitsWithBasehead({owner,repo,basehead:`${repository.default_branch}...${context.sha}`})).data;
  if(!comparison.ahead_by){core.info('No unreceived commits.');return;}
  const marker=`<!-- agent-work:${repository.id}:${branch} -->`;
  const title=`Receive branch: ${branch}`.slice(0,240);
  const body=[marker,`Receive the work on branch \`${branch}\` against \`${repository.default_branch}\`.`,
    `Observed head: \`${context.sha}\`. Compare base: \`${comparison.base_commit.sha}\`.`,
    `${comparison.ahead_by} commits ahead; ${comparison.behind_by} behind.`,
    'Review the changed source and its actual consumers. Preserve useful capabilities and reconcile competing source owners.',
    'Record the original requirement, intended result, source evidence and any independent obstruction in this pull. A successful check or source merge does not establish operating or customer receiving.',
    'GitHub removes the head branch after merging when repository policy permits.'] .join('\n\n');
  try{
    const pr=(await github.rest.pulls.create({owner,repo,head:branch,base:repository.default_branch,title,body,draft:true})).data;
    await label(pr.number,'agent:work');core.summary.addLink('Received into draft pull request',pr.html_url);await core.summary.write();
  }catch(error){
    // Missing PR-creation permission is visible, and work remains in a durable issue.
    if(![403,422].includes(error.status))throw error;
    if(error.status===422) {
      // Another push receiver may already have opened the same draft pull.
      const raced=await github.paginate(github.rest.pulls.list,{owner,repo,state:'open',head:`${owner}:${branch}`,per_page:100});
      if(raced.length){await label(raced[0].number,'agent:work');core.info(`Branch ${branch} already has pull #${raced[0].number}; no duplicate created.`);return;}
    }
    // The original branch is itself durable. A blocked PR must not spawn a
    // second, unowned issue that a scheduled agent cannot later clean up.
    core.summary.addRaw(`Draft pull request unavailable (GitHub HTTP ${error.status}); branch \`${branch}\` remains preserved. No fallback issue created.\\n`);
    await core.summary.write();
    core.setFailed(`Draft pull request unavailable (${error.status}); retained branch ${branch}, no duplicate issue created.`);
  }
}
