import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const release=JSON.parse(await fs.readFile(new URL('./asset-release.json',import.meta.url),'utf8'));
export function verifyAsset(buffer,expected=release.sha256){
 const actual=crypto.createHash('sha256').update(buffer).digest('hex');
 if(actual!==expected)throw Error(`Asset hash mismatch: expected ${expected}, got ${actual}`);
 return buffer;
}
export async function hydrate(source){
 const target=new URL('../../output/structural-loss/model.glb',import.meta.url);
 if(!source){
  try{verifyAsset(await fs.readFile(target));return;}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 let buffer;
 if(source)buffer=verifyAsset(await fs.readFile(source));
 else{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'strokah-hydrate-'));
  try{
   const archive=path.join(temp,'release.zip');
   execFileSync('aws',['s3api','get-object','--bucket',release.bucket,'--key',release.object_key,'--version-id',release.version_id,archive],{stdio:['ignore','ignore','pipe']});
   verifyAsset(await fs.readFile(archive),release.archive_sha256);
   buffer=verifyAsset(execFileSync('unzip',['-p',archive,release.member],{maxBuffer:32*1024*1024}));
  }finally{await fs.rm(temp,{recursive:true,force:true});}
 }
 await fs.mkdir(new URL('./',target),{recursive:true});
 await fs.writeFile(target,buffer);
 console.log(`ASSET_HYDRATED ${release.asset_id}/${release.release} ${release.sha256}`);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await hydrate(process.argv[2]);
