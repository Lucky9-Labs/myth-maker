import { AnimationMixer, Vector3, Quaternion, Box3 } from "three";
import { MechanicalLegs, findRigNode, meshClearance } from "./vendor/mechanical-legs.mjs";
import { UpperBody } from "./vendor/upper-body.mjs";
import { StructuralState } from "./structural-state.mjs";
import {EffortMotion} from "./effort-motion.mjs";
import { LimbOwnership } from "./limb-ownership.mjs";
const smooth = (x) => {
  x = Math.max(0, Math.min(1, x));
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const pos = (n) => n.getWorldPosition(new Vector3());
export class StructuralController {
  constructor(gltf, scene, config = {}) {
    this.root = gltf.scene;
    scene.add(this.root);
    const rest = MechanicalLegs.captureRest(this.root);
    const mixer = new AnimationMixer(this.root);
    mixer.clipAction(gltf.animations[0]).play();
    mixer.setTime(1 / 24);
    findRigNode(this.root, "Terrain_Walk_Test").visible = false;
    this.legs = new MechanicalLegs(this.root, rest);
    this.allLegs = [...this.legs.legs];
    this.upper = new UpperBody(this.root);
    const {effort,...structural}=config;
    this.state = new StructuralState(structural);
    this.ownership = new LimbOwnership(this.root, scene, this.upper);
    this.effortMotion = new EffortMotion(effort);
    this.saved = [];
    this.root.traverse((n) =>
      this.saved.push({
        n,
        p: n.position.clone(),
        q: n.quaternion.clone(),
        s: n.scale.clone(),
      }),
    );
    this.reset();
  }
  reset() {
    this.ownership.reset();
    for (const { n, p, q, s } of this.saved) {
      n.position.copy(p);
      n.quaternion.copy(q);
      n.scale.copy(s);
    }
    this.state.reset();
    this.legs.legs = [...this.allLegs];
    this.legs.resetMotion();
    this.upper.disabledSides = new Set();
    this.effortMotion.reset();
    this.contactValid=true;
    this.time = 0;
    this.crawlClock = 0;
    this.lossTime = null;
    this.entryFeet = null;
    this.entryHands = null;
    this.z = 0;
    this.fired = 0;
    this.recoil = 0;
    this.contacts = {};
    this.lastEffortPhase=null;this.lastEffortSequence=null;this.lastEffortActor=null;this.effortPlant=null;
    this.root.updateMatrixWorld(true);
    this.initialFeet = Object.fromEntries(
      this.allLegs.map((l) => [l.suffix, pos(l.ball)]),
    );
    for (const p of Object.values(this.initialFeet)) p.y = 0.035;
    this.initialHands = Object.fromEntries(
      this.upper.chains.map((c, i) => [["L", "R"][i], pos(c.nodes[3])]),
    );
    this.handRotations = Object.fromEntries(
      this.upper.chains.map((c, i) => [
        ["L", "R"][i],
        c.nodes[3].getWorldQuaternion(new Quaternion()),
      ]),
    );
    this.supportRotations = {};
    this.supportHeights = {};
    for (const side of ["L", "R"]) {
      const hand = findRigNode(this.root, `hand.${side}`),
        middle = findRigNode(this.root, `middle.01.${side}`),
        index = findRigNode(this.root, `index.01.${side}`);
      const origin = pos(hand),
        along = pos(middle).sub(origin).normalize(),
        across = pos(index).sub(pos(middle)).normalize();
      const normal = new Vector3().crossVectors(along, across).normalize();
      const q = new Quaternion().setFromUnitVectors(
        along,
        new Vector3(0, 0, 1),
      );
      const rotated = normal.applyQuaternion(q);
      rotated.z = 0;
      rotated.normalize();
      const roll = new Quaternion().setFromUnitVectors(
        rotated,
        new Vector3(0, -1, 0),
      );
      const rotation = roll.multiply(q).multiply(this.handRotations[side]);
      this.supportRotations[side] = rotation;
      const old = hand.quaternion.clone();
      hand.quaternion.copy(
        hand.parent
          .getWorldQuaternion(new Quaternion())
          .invert()
          .multiply(rotation),
      );
      this.root.updateMatrixWorld(true);
      this.supportHeights[side] =
        origin.y - new Box3().setFromObject(hand).min.y + 0.003;
      hand.quaternion.copy(old);
      this.root.updateMatrixWorld(true);
    }
    this.metrics = {};
    this.update(0);
  }
  hit(id, power = 30) {
    const result = this.state.hit(id, power);
    if (result.detached) {
      this.ownership.detach(
        id,
        new Vector3(Math.sign(pos(this.ownership.records.get(id)[0].node).x-pos(this.upper.waist).x||1)*.8, 0.35, -.3).multiplyScalar(Math.min(3, Math.max(.5,power/30))),
      );
      this.upper.disabledSides = new Set(
        ["L", "R"].filter((s) => this.state.parts[`arm.${s}`].lost),
      );
      this.legs.legs = this.allLegs.filter(
        (l) => !this.state.parts[`leg.${l.suffix}`].lost,
      );
      if (this.lossTime === null) {
        this.lossTime = this.time;
        this.entryFeet = Object.fromEntries(
          this.allLegs.map((l) => [l.suffix, pos(l.ball)]),
        );
        this.entryHands = Object.fromEntries(
          this.upper.chains.map((c, i) => [["L", "R"][i], pos(c.nodes[3])]),
        );
      }
    }
    return result;
  }
  fire() {
    if (!this.state.armed || this.metrics.weaponBracing) return false;
    this.fired++;
    this.recoil = 0.012;
    return true;
  }
  update(dt, { move = true, aimYaw = 0, slope = 0, purchase = 1 } = {}) {
    this.time += dt;
    this.recoil *= Math.exp(-dt*18);
    const damaged = this.state.events.length > 0;
    const age = this.lossTime===null ? 0 : this.time-this.lossTime;
    const blend = damaged ? smooth(age/this.state.config.transitionSeconds) : 0;
    const e = this.effortMotion.update(dt,{parts:this.state.parts,enabled:blend>.999,move,slope,purchase:purchase*(this.contactValid?1:0)});
    this.z = e.z;
    this.legs.moveBody({x:0,z:this.z},-.44*blend);
    this.upper.aim(aimYaw,0);
    if(this.state.armed)this.upper.alignBarrel(new Vector3(Math.sin(aimYaw),0,Math.cos(aimYaw)));
    this.upper.respond({x:0,z:.15*blend});
    // Keep the gun frame independent while the chassis rolls forward onto its belly.
    const pitch=(1.08-.07*e.effort)*blend;
    if(this.state.armed)this.upper.articulate({torsoPitch:pitch,weapon:{recoil:this.recoil}},0);
    else {
      const waist=this.upper.waist;
      const q=waist.getWorldQuaternion(new Quaternion()).premultiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),pitch-.14));
      waist.quaternion.copy(waist.parent.getWorldQuaternion(new Quaternion()).invert().multiply(q));
    }
    this.root.updateMatrixWorld(true);
    const hull=new Box3();
    for(const node of [...this.upper.waist.children,...this.upper.waist.parent.children])if(node.isMesh){node.geometry.computeBoundingBox();hull.union(node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld));}
    // The torso is the grounded support during recovery and single-limb motion.
    const lift=(.004+.007*e.effort-hull.min.y)*blend;
    this.legs.body.position.y+=lift;
    this.root.updateMatrixWorld(true);
    if(e.phase==='reach' && (this.lastEffortPhase!=='reach'||this.lastEffortActor!==e.actor))this.effortPlant=null;
    this.lastEffortPhase=e.phase;this.lastEffortActor=e.actor;
    const feet=this.legs.legs.map(l=>{
      const initial=(this.entryFeet??this.initialFeet)[l.suffix];
      const side=l.suffix;
      const drag=new Vector3(this.initialFeet[side].x,.035,this.z-.50);
      let target=initial.clone().lerp(drag,blend),phase='drag';
      if(e.actor===`leg.${side}`&&e.phase==='recover'&&this.effortPlant)target=this.effortPlant.clone().lerp(drag,smooth(this.effortMotion.clock/.9));
      if(e.actor===`leg.${side}`&&e.phase!=='recover'){
        if(!this.effortPlant)this.effortPlant=new Vector3(drag.x,.035,this.z-.32);
        if(e.phase==='reach'){target.lerp(this.effortPlant,smooth(e.progress));target.y+=.025*Math.sin(Math.PI*e.progress);phase='reach';}
        else{target.copy(this.effortPlant);target.z-=.018*e.slip;phase=e.phase;}
      }
      // A dragging foot stays flat during the desperate draw-in; a walking toe
      // pitch would dig its heel into the floor and lift the grounded chassis.
      return {side:l.side,position:target,dragPose:{pitch:0},phase:phase==='reach'?'swing':'stance',progress:e.phase==='reach'?e.progress:0,yaw:0,landings:0,target:{ankle:target,heel:{y:0},toe:{y:0},yaw:0}};
    });
    const priorLegs=new Map(this.legs.legs.flatMap(l=>[l.thigh,l.shin,l.lower,l.ball,l.heel,l.toe]).map(n=>[n,n.quaternion.clone()]));
    this.footMetrics=this.legs.solve({mode:'drag',lockBody:damaged,feet,gait:{coordinated:true,dt:dt||1/60}},0,()=>0);
    if(damaged&&dt>0){
      for(const [node,prior]of priorLegs){const angle=prior.clone().normalize().angleTo(node.quaternion.clone().normalize());if(angle>8.4*dt)node.quaternion.copy(prior.slerp(node.quaternion,8.4*dt/angle));}
      this.root.updateMatrixWorld(true);
      let penetration=0;for(const leg of this.legs.legs)for(const n of [leg.ball,leg.heel,leg.toe])penetration=Math.max(penetration,.002-meshClearance(n,()=>0));
      if(penetration>0)this.legs.body.position.y+=penetration;
      this.root.updateMatrixWorld(true);
      for(const f of this.footMetrics){const leg=this.legs.legs.find(l=>l.side===f.side),target=new Vector3().fromArray(f.target);f.error=pos(leg.ball).distanceTo(target);f.clearance=Math.min(...[leg.ball,leg.heel,leg.toe].map(n=>meshClearance(n,()=>0)));}
    }
    this.root.updateMatrixWorld(true);
    const overrides={};this.handPhases={};
    for(const side of ['L','R']){
      if(this.state.parts[`arm.${side}`].lost)continue;
      const selected=e.actor===`arm.${side}`&&e.phase!=='recover';
      const free=side==='L'||!this.state.armed;
      if(!free&&!selected)continue;
      const shoulder=pos(this.upper.chains[side==='L'?0:1].nodes[1]);
      const rest=new Vector3(side==='L'?.23:-.23,this.supportHeights[side],this.z+.17);
      let target=rest,rotation=this.supportRotations[side],weight=blend;
      if(e.actor===`arm.${side}`&&e.phase==='recover'&&this.effortPlant)target=this.effortPlant.clone().lerp(rest,smooth(this.effortMotion.clock/.9));
      if(selected){
        if(!this.effortPlant){
          const nodes=this.upper.chains[side==='L'?0:1].nodes;
          const elbow=pos(nodes[2]),hand=pos(nodes[3]);
          const axis=new Vector3(1,0,0).applyQuaternion(nodes[2].getWorldQuaternion(new Quaternion()));
          const upper=elbow.clone().sub(shoulder),fore=hand.clone().sub(elbow);
          // Maximum radius allowed by the elbow hinge, including its axial offset.
          const axial=upper.dot(axis)+fore.dot(axis);
          const radial=upper.addScaledVector(axis,-upper.dot(axis)).length()+fore.addScaledVector(axis,-fore.dot(axis)).length();
          const reach=Math.sqrt(axial*axial+radial*radial)-.002;
          const dy=this.supportHeights[side]-shoulder.y,dx=rest.x-shoulder.x;
          this.effortPlant=new Vector3(rest.x,this.supportHeights[side],shoulder.z+Math.sqrt(Math.max(0,reach*reach-dy*dy-dx*dx)));
        }
        if(e.phase==='reach'){target=rest.clone().lerp(this.effortPlant,smooth(e.progress));target.y+=.10*Math.sin(Math.PI*e.progress);}
        else target=this.effortPlant.clone().add(new Vector3(0,0,-.02*e.slip));
      }
      if(!damaged)continue;
      this.handPhases[side]=selected?e.phase:'drag';
      overrides[side]={position:(this.entryHands??this.initialHands)[side].clone().lerp(target,blend),rotation:this.handRotations[side].clone().slerp(rotation,blend),weight:1};
    }
    const braceWeight=e.actor==='arm.R'?(e.phase==='reach'?smooth(e.progress):e.phase==='recover'?1-smooth(this.effortMotion.clock/.9):1):0;
    if(this.state.armed && braceWeight===0)this.upper.gripRig.rotateAround(this.upper.gripRig.targets()[1].position,new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.045*e.effort));
    if(braceWeight>0&&this.state.armed){
      // Brace with the hand still attached to its trigger frame: translate and
      // lower the common gun control; never pull the hand away from the rifle.
      const target=(overrides.R?.position??this.effortPlant??new Vector3(-.23,this.supportHeights.R,this.z+.17)).clone(),grip=this.upper.gripRig.targets()[1];
      this.upper.gripRig.rotateAround(grip.position,new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3*braceWeight));
      const weaponFloor=new Box3().setFromObject(this.upper.weapon).min.y;target.y=Math.max(target.y,grip.position.y-weaponFloor+.006);
      // The rifle raises the supporting hand: use the extra horizontal reach
      // available at that height rather than keeping the bare-palm target.
      if(this.effortPlant){
        const shoulder=pos(this.upper.chains[1].nodes[1]),radius=shoulder.distanceTo(this.effortPlant);
        const dy=target.y-shoulder.y,dx=target.x-shoulder.x;
        const far=shoulder.z+Math.sqrt(Math.max(0,radius*radius-dy*dy-dx*dx));
        target.z+=(far-target.z)*braceWeight;
      }
      this.upper.gripRig.translateWorld(target.clone().sub(grip.position).multiplyScalar(braceWeight));
      delete overrides.R;
    }
    this.upper.solveGrips({gripOverrides:overrides});
    this.ownership.update(dt);this.root.updateMatrixWorld(true);
    this.contactValid=true;
    if(e.actor && ['plant','pull','push'].includes(e.phase)){
      if(e.actor.startsWith('leg')){
        const leg=this.legs.legs.find(l=>e.actor===`leg.${l.suffix}`),f=this.footMetrics.find(f=>f.side===leg?.side);
        this.contactValid=!!f && f.error<.012 && f.clearance>-.004 && f.clearance<.014;
      }else {
        const side=e.actor.endsWith('L')?'L':'R',hand=this.upper.chains[side==='L'?0:1].nodes[3];
        const floor=new Box3().setFromObject(side==='R'?this.upper.weapon:hand).min.y;
        const target=this.upper.gripTargets[side==='L'?0:1].position;
        this.contactValid=floor>-.005 && floor<.014 && pos(hand).distanceTo(target)<.012;
      }
    }
    const torsoBox=new Box3();for(const node of this.upper.waist.children)if(node.isMesh)torsoBox.union(node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld));
    this.metrics={blend,z:this.z,velocity:e.velocity,force:e.force,contactValid:this.contactValid,phase:e.phase,actor:e.actor,effort:e.effort,weaponBracing:braceWeight>.05,armed:this.state.armed,mobile:this.state.mobile,mode:damaged?`${e.phase} · ${e.actor??'grounded'}`:'standing',debris:this.ownership.debris.length,gripErrors:this.upper.armErrors,torsoClearance:torsoBox.min.y,feet:this.footMetrics.map(f=>({side:f.side,error:f.error,clearance:f.clearance})),hands:Object.fromEntries(['L','R'].filter(s=>!this.state.parts[`arm.${s}`].lost).map(s=>{const n=this.upper.chains[s==='L'?0:1].nodes[3];return [s,{phase:this.handPhases[s]??'aim',position:pos(n).toArray(),clearance:new Box3().setFromObject(n).min.y}];}))};
    return this.metrics;
  }
}
