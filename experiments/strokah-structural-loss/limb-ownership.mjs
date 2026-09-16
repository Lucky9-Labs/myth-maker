import {Group,Vector3,Quaternion,Box3} from 'three';
import * as C from 'cannon-es';
import {findRigNode} from './vendor/mechanical-legs.mjs';
const cv=v=>new C.Vec3(v.x,v.y,v.z);
class LimitedHinge extends C.HingeConstraint {
 constructor(a,b,options){super(a,b,options);this.restAxis=new C.Vec3();this.axisA.tangents(this.restAxis,new C.Vec3());this.limit=new C.RotationalEquation(a,b);this.limit.maxAngle=.45;this.limit.minForce=-1e5;this.limit.maxForce=0;this.equations.push(this.limit);}
 update(){super.update();this.bodyA.vectorToWorldFrame(this.restAxis,this.limit.axisA);this.bodyB.vectorToWorldFrame(this.restAxis,this.limit.axisB);}
}
export class LimbOwnership {
 constructor(root,scene,upper){this.root=root;this.scene=scene;this.upper=upper;this.records=new Map();this.debris=[];
 this.world=new C.World({gravity:new C.Vec3(0,-9.81,0),allowSleep:true});this.world.solver.iterations=32;this.world.defaultContactMaterial.contactEquationStiffness=1e8;this.world.defaultContactMaterial.friction=.65;this.world.defaultContactMaterial.restitution=.12;
 const floor=new C.Body({mass:0,shape:new C.Plane()});floor.quaternion.setFromEuler(-Math.PI/2,0,0);this.world.addBody(floor);

 for(const kind of ['arm','leg'])for(const side of ['L','R']){const names=kind==='arm'?['upper_arm','forearm','hand']:['thigh','shin','lower_shin'];const nodes=names.map(n=>findRigNode(root,`${n}.${side}`));if(kind==='arm'&&side==='R')nodes.push(upper.gripRig.control);this.records.set(`${kind}.${side}`,nodes.map(node=>({node,parent:node.parent,position:node.position.clone(),quaternion:node.quaternion.clone(),scale:node.scale.clone()})));}}
 detach(id,impulse=new Vector3(.6,.7,-.35)){
 if(this.debris.some(d=>d.id===id))return false;const records=this.records.get(id);if(!records)throw Error(`Unknown limb ${id}`);this.root.updateMatrixWorld(true);
 const group=new Group();group.name=`DEBRIS_${id}`;this.scene.add(group);const links=[],constraints=[],colliders=[];
 // Descendant joints become independently simulated links, preserving the exact
 // separation pose. The rifle remains a rigid attachment to the lost hand.
 const segments=records.slice(0,3);const pivots=segments.map(r=>r.node.getWorldPosition(new Vector3()));const axes=segments.map(r=>new Vector3(1,0,0).applyQuaternion(r.node.getWorldQuaternion(new Quaternion())));
 for(let i=2;i>=0;i--){const r=segments[i],visual=new Group();visual.name=`RAG_${id}_${i}`;visual.position.copy(pivots[i]);group.add(visual);visual.updateMatrixWorld(true);visual.attach(r.node);if(i===2&&records[3])visual.attach(records[3].node);
 const collisionGroup=2<<['arm.L','arm.R','leg.L','leg.R'].indexOf(id);
 const body=new C.Body({collisionFilterGroup:collisionGroup,collisionFilterMask:~collisionGroup,mass:i===0?6:i===1?4:2,position:cv(pivots[i]),linearDamping:.12,angularDamping:.3,sleepSpeedLimit:.06,sleepTimeLimit:.7});
 visual.updateMatrixWorld(true);
 // One convex box per rigid visual cluster (plus the rifle cluster on its hand).
 // Keep the real mesh list for precise ray hits and ownership accounting.
 for(const cluster of [r.node,...(i===2&&records[3]?[records[3].node]:[])]){
   const box=new Box3().setFromObject(cluster),half=box.getSize(new Vector3()).multiplyScalar(.5),center=box.getCenter(new Vector3()).sub(pivots[i]);
   body.addShape(new C.Box(new C.Vec3(Math.max(.004,half.x),Math.max(.004,half.y),Math.max(.004,half.z))),cv(center));
   cluster.traverse(mesh=>{if(mesh.isMesh){mesh.userData.collisionOwner=id;colliders.push(mesh.uuid);}});
 }
 // Convert the hit delta-v to a mass-weighted physical impulse per link.
 body.applyImpulse(cv(impulse).scale(body.mass));body.angularVelocity.set(.7,id.endsWith('L')?-.6:.6,id.endsWith('L')?-1.4:1.4);this.world.addBody(body);links[i]={body,visual};}
 for(let i=1;i<3;i++){const a=links[i-1].body,b=links[i].body;const hinge=new LimitedHinge(a,b,{pivotA:cv(pivots[i].clone().sub(pivots[i-1])),pivotB:new C.Vec3(),axisA:cv(axes[i]),axisB:cv(axes[i]),collideConnected:false,maxForce:1e5});this.world.addConstraint(hinge);constraints.push(hinge);}
 this.debris.push({id,group,links,constraints,colliders,settled:false});return true;
 }
 raycast(raycaster){const active=[];for(const [id,records]of this.records){if(this.debris.some(d=>d.id===id))continue;const roots=[records[0],...(records[3]?[records[3]]:[])];for(const r of roots){r.node.updateWorldMatrix(true,true);for(const hit of raycaster.intersectObject(r.node,true))active.push({...hit,limb:id});}}return active.sort((a,b)=>a.distance-b.distance);}

 update(dt){if(dt>0)this.world.step(1/240,dt,16);for(const d of this.debris){for(const {body,visual}of d.links){visual.position.copy(body.position);visual.quaternion.copy(body.quaternion);}d.group.updateMatrixWorld(true);d.settled=d.links.every(l=>l.body.sleepState===C.Body.SLEEPING);}}
 reset(){for(const d of this.debris){for(const c of d.constraints)this.world.removeConstraint(c);for(const l of d.links)this.world.removeBody(l.body);}for(const records of this.records.values())for(const r of records){r.parent.add(r.node);r.node.position.copy(r.position);r.node.quaternion.copy(r.quaternion);r.node.scale.copy(r.scale);r.node.traverse(n=>delete n.userData.collisionOwner);}for(const d of this.debris)this.scene.remove(d.group);this.debris=[];this.world.time=0;this.world.accumulator=0;this.root.updateMatrixWorld(true);}
}
