import { Quaternion, Vector3 } from 'three';
import {WeaponGripRig} from './weapon-grip-rig.mjs';
import { findRigNode } from './mechanical-legs.mjs';

// Bind after sampling the accepted pose; glTF does not retain Blender constraints.
export class UpperBody {
  constructor(root) {
    this.root = root;
    this.waist = findRigNode(root, 'waist');
    this.hand = findRigNode(root, 'hand.R');
    this.weapon = findRigNode(root, 'RootNode');
    this.muzzle = findRigNode(root, 'tripo_part_7.004');
    if (!this.waist || !this.hand || !this.weapon) throw new Error('Missing accepted upper-body attachment nodes');
    root.updateMatrixWorld(true);

    this.shoulders = ['L', 'R'].map((side, index) => {
      const arm = findRigNode(root, `upper_arm.${side}`);
      const shell = findRigNode(root, `tripo_part_34.00${index + 2}`);
      arm.attach(shell);
      return { arm, shell };
    });
    this.chains=['L','R'].map(side=>{
      const nodes=['shoulder_mount','upper_arm','forearm','hand'].map(name=>findRigNode(root,`${name}.${side}`));
      return {nodes,base:nodes.map(node=>node.quaternion.clone())};
    });
    // Foregrip target is fixed in weapon space, above the old floating palm.
    this.leftGripLift=new Vector3(0,.04,0).applyQuaternion(this.weapon.getWorldQuaternion(new Quaternion()).invert());
    this.gripRig=new WeaponGripRig(root,this.waist,this.weapon,this.chains.map(c=>c.nodes[3]),this.leftGripLift);
    this.base = this.waist.quaternion.clone();
    this.basePosition = this.waist.position.clone();
  }
  // Restore the accepted arm pose before aim; procedural offsets never accumulate.
  restoreArms() {
    for(const [i,chain] of this.chains.entries())if(!this.disabledSides?.has(['L','R'][i]))chain.nodes.forEach((node,i)=>node.quaternion.copy(chain.base[i]));
    this.root.updateMatrixWorld(true);
  }
  weaponTuck(heading=0) { return new Vector3(-Math.sin(heading)*.035,0,-Math.cos(heading)*.035); }
  articulate(response,heading=0) {
    const rotation=node=>node.getWorldQuaternion(new Quaternion());
    const setWorld=(node,q)=>{node.quaternion.copy(rotation(node.parent).invert().multiply(q));this.root.updateMatrixWorld(true);};
    const tuck=this.weaponTuck(heading);
    this.gripRig.translateWorld(tuck);
    const targets=this.gripRig.targets();
    const carry=(response.carry??0)*(1-(response.weapon?.scope??0));
    if(carry>0){
      const center=targets[0].position.clone().add(targets[1].position).multiplyScalar(.5);
      const across=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),55*Math.PI/180*carry+(response.armSway??0)*2*(1-(response.weapon?.scope??0)));
      const barrel=this.barrelDirection().applyQuaternion(across);
      const pitchAxis=new Vector3(0,1,0).cross(barrel).normalize();
      const lowered=new Quaternion().setFromAxisAngle(pitchAxis,8*Math.PI/180*carry).multiply(across);
      const shift=new Vector3(-Math.sin(heading)*.065,.075,-Math.cos(heading)*.065).multiplyScalar(carry);
      shift.addScaledVector(new Vector3(Math.cos(heading),0,-Math.sin(heading)),(response.armSway??0)*(1-(response.weapon?.scope??0)));
      this.gripRig.rotateAround(center,lowered);
      this.gripRig.translateWorld(shift);
    }
    const action=response.weapon??{};
    const direction=this.barrelDirection();
    const lateral=new Vector3(0,1,0).cross(direction).normalize();
    const scope=action.scope??0;
    this.gripRig.translateWorld(new Vector3(0,.055*scope,0).addScaledVector(lateral,-.025*scope)
      .addScaledVector(direction,-.025*scope));
    if(action.aimPoint){
      const muzzle=this.muzzlePosition(),toward=action.aimPoint.clone().sub(muzzle).normalize();
      this.gripRig.rotateAround(muzzle,new Quaternion().setFromUnitVectors(this.barrelDirection(),toward));
    }
    const recoilDirection=this.barrelDirection();
    this.gripRig.translateWorld(new Vector3(recoilDirection.x,0,recoilDirection.z).normalize().multiplyScalar(-(action.recoil??0)));
    const weaponWorld=this.gripRig.worldMatrix();
    const right=new Vector3(Math.cos(heading),0,-Math.sin(heading));
    const tilt=new Quaternion().setFromAxisAngle(right,-8*Math.PI/180+(response.torsoPitch??0));
    const dashTilt=response.dashTilt??{x:0,z:0};
    const dashAngle=Math.hypot(dashTilt.x,dashTilt.z);
    if(dashAngle>0)tilt.premultiply(new Quaternion().setFromAxisAngle(new Vector3(dashTilt.z,0,-dashTilt.x).normalize(),dashAngle));
    setWorld(this.waist,tilt.multiply(rotation(this.waist)));
    this.gripRig.setWorld(weaponWorld);
    this.chains.forEach(({nodes},index)=>setWorld(nodes[0],new Quaternion().setFromAxisAngle(right,response.shoulderPitch?.[index]??0).multiply(rotation(nodes[0]))));
    this.solveGrips(response,heading);
  }
  solveGrips(response={},heading=0) {
    const position=node=>node.getWorldPosition(new Vector3());
    const rotation=node=>node.getWorldQuaternion(new Quaternion());
    const setWorld=(node,q)=>{node.quaternion.copy(rotation(node.parent).invert().multiply(q));this.root.updateMatrixWorld(true);};
    const targets=this.gripRig.targets();
    const reload=response.weapon?.reload??0;
    if(reload>0){
      // Release the support hand to the receiver service area, then re-grip.
      const service=targets[0].position.clone().lerp(targets[1].position,.5).add(new Vector3(0,-.045,0));
      targets[0].position.lerp(service,reload);
      targets[0].rotation.slerp(targets[1].rotation,.25*reload);
    }
    for(const [i,side] of ['L','R'].entries()){
      const override=response.gripOverrides?.[side];
      if(!override)continue;
      const weight=Math.max(0,Math.min(1,override.weight??1));
      if(override.position)targets[i].position.lerp(override.position,weight);
      if(override.rotation)targets[i].rotation.slerp(override.rotation,weight);
    }
    this.gripWeights=[1-reload,1];
    this.gripTargets=targets;
    this.armErrors=[];
    for(const [index,{nodes}] of this.chains.entries()) {
      if(this.disabledSides?.has(['L','R'][index]))continue;
      const [mount,arm,elbow,hand]=nodes,target=targets[index];
      // Arm root is a ball joint; elbow compensation is strictly local-X.
      for(let iteration=0;iteration<80;iteration++) {
        const pivot=position(elbow),axis=new Vector3(1,0,0).applyQuaternion(rotation(elbow));
        const a=position(hand).sub(pivot),b=target.position.clone().sub(pivot);
        a.addScaledVector(axis,-a.dot(axis));b.addScaledVector(axis,-b.dot(axis));
        if(a.lengthSq()>1e-12&&b.lengthSq()>1e-12){
          const angle=Math.atan2(axis.dot(a.clone().cross(b)),a.dot(b));
          elbow.rotateX(Math.max(-.12,Math.min(.12,angle)));this.root.updateMatrixWorld(true);
        }
        const origin=position(arm),from=position(hand).sub(origin).normalize(),to=target.position.clone().sub(origin).normalize();
        setWorld(arm,new Quaternion().setFromUnitVectors(from,to).multiply(rotation(arm)));
        if(position(hand).distanceTo(target.position)<1e-6)break;
      }
      setWorld(hand,target.rotation);
      this.armErrors.push(position(hand).distanceTo(target.position));
    }
  }
  aimWeaponAt(target,response={},heading=0) {
    const muzzle=this.muzzlePosition(),direction=target.clone().sub(muzzle);
    if(direction.length()<.05)return false;
    const rotation=new Quaternion().setFromUnitVectors(this.barrelDirection(),direction.normalize());
    this.gripRig.rotateAround(muzzle,rotation);this.solveGrips(response,heading);
    return true;
  }
  muzzlePosition() {
    this.muzzle.geometry.computeBoundingBox();
    const box = this.muzzle.geometry.boundingBox;
    return this.muzzle.localToWorld(new Vector3(box.min.x,(box.min.y+box.max.y)/2,(box.min.z+box.max.z)/2));
  }
  aimAt(target) {
    // Rotating the waist moves the muzzle, so converge after each correction.
    for (let i=0;i<16;i++) {
      this.root.updateMatrixWorld(true);
      const direction=target.clone().sub(this.muzzlePosition());
      if(direction.length()<.05) return false;
      if(this.barrelDirection().angleTo(direction)<.0001) return true;
      this.alignBarrel(direction);
    }
    return this.barrelDirection().angleTo(target.clone().sub(this.muzzlePosition()))<.001;
  }
  barrelDirection() {
    this.root.updateMatrixWorld(true);
    // The exported muzzle extends along mesh-local -X.
    return new Vector3(-1,0,0).transformDirection(this.muzzle.matrixWorld);
  }
  alignBarrel(direction) {
    if (direction.lengthSq() < 1e-10) return;
    const correction = new Quaternion().setFromUnitVectors(this.barrelDirection(),direction.clone().normalize());
    const world = this.waist.getWorldQuaternion(new Quaternion()).premultiply(correction);
    const parent = this.waist.parent.getWorldQuaternion(new Quaternion());
    this.waist.quaternion.copy(parent.invert().multiply(world));
    this.root.updateMatrixWorld(true);
  }
  respond(offset) {
    this.root.updateMatrixWorld(true);
    const world = this.waist.parent.localToWorld(this.basePosition.clone());
    world.add(new Vector3(offset.x, offset.y ?? 0, offset.z));
    this.waist.position.copy(this.waist.parent.worldToLocal(world));
    this.root.updateMatrixWorld(true);
  }
  aim(yaw, pitch = 0) {
    this.restoreArms();
    if(!this.disabledSides?.has('R'))this.gripRig.resetPose();
    this.root.updateMatrixWorld(true);
    const parent = this.waist.parent.getWorldQuaternion(new Quaternion());
    const worldTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch));
    this.waist.quaternion.copy(parent.clone().invert().multiply(worldTurn).multiply(parent).multiply(this.base));
    this.root.updateMatrixWorld(true);
  }
}
