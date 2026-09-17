import {Object3D,Vector3,Quaternion,Matrix4} from 'three';
import {findRigNode as node} from '../strokah-structural-loss/vendor/mechanical-legs.mjs';
const V=(x=0,y=0,z=0)=>new Vector3(x,y,z);
const pos=n=>n.getWorldPosition(V()),rot=n=>n.getWorldQuaternion(new Quaternion());
const mirrorQ=q=>new Quaternion(q.x,-q.y,-q.z,q.w);
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
export const RELOAD_SECONDS=2.4;
// Right-handed, rigid weapon-local metres; left ownership reflects anchors and
// rotations, never model scales. The weapon owns all common motion.
export class PistolRig{
 constructor(root,upper,weapon,bindPose=[],contract={}){
  this.root=root;this.upper=upper;this.weapon=weapon;this.side='R';
  root.updateMatrixWorld(true);
  this.rightRotation=contract.rightRotation?.clone()??rot(node(root,'hand.R'));
  this.neutralWrist=bindPose.find(x=>x.n.name===node(root,'hand.R').name)?.q.clone()??new Quaternion(.03420230746269226,-.018773404881358147,-.0005773977609351277,.9992384314537048);
  this.fingers=[];
  for(const finger of ['index','middle','ring','thumb'])for(let j=1;j<=3;j++){
   const r=node(root,`${finger}.0${j}.R`),l=node(root,`${finger}.0${j}.L`);
   this.fingers.push({r,l,q:r.quaternion.clone(),left:l.quaternion.clone(),rest:bindPose.find(x=>x.n.name===r.name)?.q.clone()??r.quaternion.clone()});
  }
  this.anchors={};for(const side of ['L','R']){
   const a=new Object3D();a.name=`GRIP_pistol_${side}`;a.position.set(side==='R'?-.068:.068,.008,-.155);a.quaternion.copy(side==='R'?this.rightRotation:mirrorQ(this.rightRotation));weapon.add(a);this.anchors[side]=a;
  }
  this.trigger=new Object3D();this.trigger.name='TRIGGER';this.trigger.position.set(0,0,-.018);weapon.add(this.trigger);
  this.magwell=new Object3D();this.magwell.name='MAGWELL';this.magwell.position.set(0,-.034,.044);weapon.add(this.magwell);
  this.muzzle=new Object3D();this.muzzle.name='MUZZLE';this.muzzle.position.set(0,.067,.2);weapon.add(this.muzzle);
  this.rifle=upper.gripRig;
  // Shape the trigger index separately from the load-bearing fingers.
  const fingerDirections={
   index:[V(.013,0,.028),V(.033,-.006,.016),V(.018,-.005,-.012)],
   middle:[V(.005,0,.035),V(.023,0,.031),V(.025,0,.008)],
   ring:[V(0,0,.033),V(.028,0,.022),V(.025,0,.003)],
   thumb:[V(.028,.010,.028),V(.030,.003,.012),V(.025,0,0)],
  };
  for(const [finger,directions] of Object.entries(fingerDirections)){
   let parent=this.rightRotation.clone();
   for(let j=1;j<=3;j++){
    const f=this.fingers.find(f=>f.r===node(root,`${finger}.0${j}.R`));
    const world=parent.clone().multiply(f.q);
    world.premultiply(new Quaternion().setFromUnitVectors(V(0,1,0).applyQuaternion(world),directions[j-1].normalize()));
    f.q.copy(parent.clone().invert().multiply(world));parent=world;
   }
  }
  this.magazine=weapon.children.find(n=>n.name==='tripo_part_3');

 }
 update(time,state='ready',side='R',options={}){
  if(!['L','R'].includes(side))throw Error('Pistol ownership must be L or R');
  this.side=side;const disabled=options.disabledSides??this.upper.disabledSides??new Set();
  const supportSide=side==='R'?'L':'R';
  if(disabled.has(side)||options.weaponBracing){
   const hand=node(this.root,'hand.'+side),anchor=this.anchors[side];hand.updateWorldMatrix(true,false);anchor.updateMatrix();
   const world=hand.matrixWorld.clone().multiply(anchor.matrix.clone().invert());
   if(this.weapon.parent)world.premultiply(this.weapon.parent.matrixWorld.clone().invert());
   world.decompose(this.weapon.position,this.weapon.quaternion,this.weapon.scale);this.weapon.updateMatrixWorld(true);
   return this.metrics={side,state,armed:!disabled.has(side),canFire:false,weaponBracing:!!options.weaponBracing,gripError:pos(hand).distanceTo(pos(anchor)),supportOverrideWeight:0,magazineExtraction:0};
  }
  const sign=side==='R'?-1:1,aim=options.aimWeight??(['aim','fire'].includes(state)?1:0),reload=state==='reload'&&!disabled.has(supportSide);
  for(const f of this.fingers){if(!disabled.has('R'))f.r.quaternion.copy(f.q);if(!disabled.has('L'))f.l.quaternion.copy(mirrorQ(f.q));}
  // Mirror the accepted mechanical elbow starting branch before each solve.
  const r=this.upper.chains[1],l=this.upper.chains[0];
  for(let j=1;j<4;j++){if(!disabled.has('R'))r.nodes[j].quaternion.copy(r.base[j]);if(!disabled.has('L'))l.nodes[j].quaternion.copy(mirrorQ(r.base[j]));}
  const phase=time%RELOAD_SECONDS,u=phase/RELOAD_SECONDS;
  const reach=reload?smooth(u/.16)*(1-smooth((u-.82)/.18)):0;
  const extraction=reload?(u<.42?smooth((u-.25)/.17):1-smooth((u-.58)/.18)):0;
  const recoil=state==='fire'?Math.exp(-((time% .72)/.095))*Math.sin(Math.min(1,(time%.72)/.035)*Math.PI/2):0;
  const bob=state==='walk'?Math.sin(time*8)*.012:state==='sprint'?Math.sin(time*12)*.018:Math.sin(time*2)*.002;
  this.weapon.position.set(0,0,0);
  this.weapon.quaternion.setFromAxisAngle(V(1,0,0),(options.pitch??(state==='sprint'?.75:.28+(-.025-.28)*aim))+bob);
  if(reload){this.weapon.quaternion.premultiply(new Quaternion().setFromAxisAngle(V(1,0,0),-.75*reach));this.weapon.quaternion.multiply(new Quaternion().setFromAxisAngle(V(0,0,1),sign*.25*reach));this.weapon.quaternion.premultiply(new Quaternion().setFromAxisAngle(V(0,1,0),-sign*.25*reach));}
  this.weapon.quaternion.multiply(new Quaternion().setFromAxisAngle(V(1,0,0),-recoil*.12));
  this.weapon.updateMatrixWorld(true);
  // Project the common weapon frame onto the reachable wrist-aligned pose.
  // The chosen elbow angle is a bounded local-X hinge delta; all segment
  // lengths and shoulder origins remain the exported values.
  const activeChain=this.upper.chains[side==='R'?1:0];
  const [mount,arm,elbow,hand]=activeChain.nodes;
  const localElbow=(side==='R'?r.base[2].clone():mirrorQ(r.base[2]));
  localElbow.multiply(new Quaternion().setFromAxisAngle(V(1,0,0),(options.elbow??(.65*aim+(state==='sprint'?-.15:reload?-.35*reach:0)*(1-aim)))-recoil*.13));
  const neutral=side==='R'?this.neutralWrist:mirrorQ(this.neutralWrist);
  const desiredHand=rot(this.anchors[side]);
  const desiredForearm=desiredHand.clone().multiply(neutral.clone().invert());
  const desiredArm=desiredForearm.clone().multiply(localElbow.clone().invert());
  const wrist=pos(arm).add(elbow.position.clone().applyQuaternion(desiredArm)).add(hand.position.clone().applyQuaternion(desiredForearm));
  this.weapon.position.copy(wrist).sub(this.anchors[side].position.clone().applyQuaternion(this.weapon.quaternion));
  this.weapon.updateMatrixWorld(true);
  const targets=['L','R'].map(s=>({position:pos(this.anchors[s]),rotation:rot(this.anchors[s])}));
  const support=side==='R'?0:1,active=1-support;
  for(const f of this.fingers){if(disabled.has(supportSide))continue;const n=side==='R'?f.l:f.r;const rest=side==='R'?mirrorQ(f.rest):f.rest;const grasp=side==='R'?mirrorQ(f.q):f.q;n.quaternion.copy(rest).slerp(grasp,reach);if(options.supportFingerPose?.[n.name])n.quaternion.copy(options.supportFingerPose[n.name]);}

  const free=pos(this.upper.chains[support].nodes[1]).add(V(-sign*.1,-.32,.06+(state==='walk'?Math.sin(time*8)*.055:0)));
  const service=this.weapon.localToWorld(V(-sign*.060,.005-extraction*.11,-.047));
  if(this.magazine)this.magazine.position.y=-extraction*.11;
  targets[support].position.copy(free).lerp(service,reach);
  targets[support].rotation.copy(rot(this.anchors[side==='R'?'L':'R']));
  targets[support].rotation.premultiply(new Quaternion().setFromAxisAngle(V(1,0,0),.8*(1-reach)));
  if(options.supportOverride){targets[support].position.lerp(options.supportOverride.position,options.supportOverride.weight??1);if(options.supportOverride.rotation)targets[support].rotation.copy(options.supportOverride.rotation);}
  this.upper.gripRig={targets:()=>targets};
  const previousDisabled=this.upper.disabledSides;this.upper.disabledSides=disabled;try{this.upper.solveGrips();}finally{this.upper.gripRig=this.rifle;this.upper.disabledSides=previousDisabled;}
  arm.quaternion.copy(rot(arm.parent).invert().multiply(desiredArm));elbow.quaternion.copy(localElbow);hand.quaternion.copy(neutral);this.root.updateMatrixWorld(true);
  this.upper.armErrors[side==='R'?1:0]=pos(hand).distanceTo(pos(this.anchors[side]));
  this.metrics={side,state,armed:true,canFire:!reload,weaponBracing:false,reloadPhase:u,supportOverrideWeight:reach,magazineExtraction:extraction,gripError:pos(hand).distanceTo(pos(this.anchors[side])),supportError:disabled.has(supportSide)?0:pos(this.upper.chains[support].nodes[3]).distanceTo(targets[support].position),recoil};
  return this.metrics;
 }
}
