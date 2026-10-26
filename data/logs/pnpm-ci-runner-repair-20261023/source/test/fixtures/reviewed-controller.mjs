// Source-only provider admission for the integration assay, before import.
// Compute the actual complete Git tree directly from local regular bytes/modes.
import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
export const REVIEWED_TREE='6e2ac8f54ddf9fadb5254a7914949377d34706d1';
const oid=(type,body)=>createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest();
export function reviewedControllerTree(directory){
  const root=resolve(directory);if(root!==realpathSync(root))throw new Error('reviewed controller source is redirected');
  let files=0;
  const walk=(directory,top=false)=>{
    const rows=readdirSync(directory).filter(name=>!top||name!=='.git').map(name=>{
      const file=join(directory,name),stat=lstatSync(file);
      if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())throw new Error('reviewed controller source has a nonregular entry');
      if(stat.isDirectory())return {name,key:name+'/',mode:'40000',hash:walk(file)};
      if(++files>10000)throw new Error('reviewed controller source inventory exceeds bound');
      return {name,key:name,mode:stat.mode&0o111?'100755':'100644',hash:oid('blob',readFileSync(file))};
    }).sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
    return oid('tree',Buffer.concat(rows.flatMap(row=>[Buffer.from(row.mode+' '+row.name+'\0'),row.hash])));
  };
  return walk(root,true).toString('hex');
}
