import fs from 'node:fs/promises';import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';import {Scene,Box3} from 'three';import {StructuralController} from './controller.mjs';import {captureHingeFrames,assertHingeLocks} from './vendor/hinge-lock-check.mjs';
const bytes=await fs.readFile(new URL('../../output/structural-loss/model.glb',import.meta.url));const results=[];
for(let mask=1;mask<16;mask++){
 if(process.argv[2]&&mask!==Number(process.argv[2]))continue;
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');const hinges=captureHingeFrames(gltf.scene);const c=new StructuralController(gltf,new Scene());for(const [i,id]of ['arm.L','arm.R','leg.L','leg.R'].entries())if(mask&(1<<i))for(let hit=0;hit<5;hit++)c.hit(id,30);
 const row={mask,distance:0,maxSpeed:0,minTorso:Infinity,maxRestTorso:0,minHand:Infinity,maxJointStep:0,invalidPlant:0,forces:0,phases:new Set(),maxJointGap:0,minDebris:Infinity};const last=new Map();
 for(let frame=0;frame<660;frame++){
  const m=c.update(1/60);row.phases.add(m.phase);row.maxSpeed=Math.max(row.maxSpeed,m.velocity);if(frame>90){row.minTorso=Math.min(row.minTorso,m.torsoClearance);if(m.phase==='recover')row.maxRestTorso=Math.max(row.maxRestTorso,m.torsoClearance);for(const hand of Object.values(m.hands))row.minHand=Math.min(row.minHand,hand.clearance);if(!m.contactValid)row.invalidPlant++;if(m.force>0)row.forces++;}
  const living=hinges.filter(h=>c.root.getObjectById(h.node.id));assertHingeLocks(living,`mask ${mask} frame ${frame}`);
  c.root.traverse(n=>{if(last.has(n.id))row.maxJointStep=Math.max(row.maxJointStep,n.quaternion.clone().normalize().angleTo(last.get(n.id)));last.set(n.id,n.quaternion.clone().normalize());});
  for(const d of c.ownership.debris){for(const joint of d.constraints){const a=joint.bodyA.pointToWorldFrame(joint.pivotA),b=joint.bodyB.pointToWorldFrame(joint.pivotB);row.maxJointGap=Math.max(row.maxJointGap,a.distanceTo(b));}if(frame>90)row.minDebris=Math.min(row.minDebris,new Box3().setFromObject(d.group).min.y);}
 }
 row.distance=c.z;row.phases=[...row.phases];results.push(row);console.log(JSON.stringify(row));
}
await fs.writeFile(new URL('../../output/structural-loss/weak-final/matrix-audit.json',import.meta.url),JSON.stringify(results,null,2));
