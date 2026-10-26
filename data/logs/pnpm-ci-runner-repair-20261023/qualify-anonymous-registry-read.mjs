import fs from 'node:fs';
const evidence=[];
for(const name of ['@red-cup-engineering/jsnode-package-services-section/0.5.0','@red-cup-engineering/computer-data-engineering-services-section/0.7.0']){
 const url='https://registry.561.group/'+name;
 const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
 const receipt={url,authorizationHeader:false,cookieHeader:false,status:response.status};
 if(response.ok){const metadata=await response.json();receipt.version=metadata.version;receipt.integrity=metadata.dist?.integrity;
  const archive=await fetch(metadata.dist.tarball,{headers:{range:'bytes=0-0'},signal:AbortSignal.timeout(15000)});
  receipt.tarballStatus=archive.status;await archive.body?.cancel();
 }
 evidence.push(receipt);
}
fs.writeFileSync("/home/emsenn/info/lib/emsenn/services/561-group/services/engineering-services-section/services/computer-engineering-services-section/services/computer-systems-engineering-services-section/services/computer-code-development-system-services-section/services/continuous-delivery-services-section/data/logs/pnpm-ci-runner-repair-20261023/anonymous-registry-read.json",JSON.stringify({at:new Date().toISOString(),evidence},null,2)+'\n');
console.log(JSON.stringify(evidence));

