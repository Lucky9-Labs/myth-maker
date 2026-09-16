// A contact effort produces force. Travel is the resulting mass/friction response,
// never a prescribed speed. Rest intervals and missed/slipping purchase are explicit.
export const EFFORT_DEFAULTS=Object.freeze({mass:70,pullForce:82,pushForce:70,staticFriction:45,slidingFriction:30,drag:90,reachSeconds:.62,plantSeconds:.24,effortSeconds:.62,recoverSeconds:1.5});
export class EffortMotion {
 constructor(config={}){this.config={...EFFORT_DEFAULTS,...config};this.reset();}
 reset(){this.z=0;this.velocity=0;this.phase='recover';this.clock=0;this.actor=null;this.sequence=0;this.force=0;this.slip=0;this.externalImpulse=0;this.distanceByEffort=0;this.effort=0;}
 available(parts){const free=!parts['arm.L'].lost?['arm.L']:[];const legs=['leg.L','leg.R'].filter(id=>!parts[id].lost);return [...free,...legs,...(!parts['arm.R'].lost?['arm.R']:[])];}
 choose(parts){const available=this.available(parts);if(!available.length)return null;
 // Prefer the free hand; let a surviving leg attempt a weaker shove every other
 // cycle. A weapon hand yields aim only when no other actuator is available.
 const ordinary=available.filter(id=>id!=='arm.R');const choices=ordinary.length?ordinary:available;return choices[this.sequence%choices.length];}
 impulse(value){this.externalImpulse+=value;}
 update(dt,{parts,enabled,move=true,slope=0,purchase=1}={}){
 const c=this.config;this.velocity+=this.externalImpulse/c.mass;this.externalImpulse=0;this.force=0;this.effort=0;this.slip=0;
 if(!enabled){this.velocity=0;return this.snapshot();}
 if(this.actor&&parts[this.actor].lost){this.phase='recover';this.clock=0;this.actor=null;}
 this.clock+=dt;
 const durations={reach:c.reachSeconds,plant:c.plantSeconds,pull:c.effortSeconds,push:c.effortSeconds,recover:c.recoverSeconds+(this.sequence%3)*.23};
 if(this.clock>=durations[this.phase]){this.clock-=durations[this.phase];if(this.phase==='recover'){this.actor=move?this.choose(parts):null;if(this.actor)this.phase='reach';else this.clock=0;}else if(this.phase==='reach')this.phase='plant';else if(this.phase==='plant')this.phase=this.actor.startsWith('arm')?'pull':'push';else{this.phase='recover';this.sequence++;}}
 const progress=Math.min(1,this.clock/durations[this.phase]);
 if(this.phase==='pull'||this.phase==='push'){
  this.effort=Math.sin(Math.PI*progress);const weak=1-.12*(this.sequence%3);const grip=Math.max(0,Math.min(1,purchase));
  this.slip=(1-grip)*this.effort+.65*this.effort*(this.sequence%3===2?1:0);
  this.force=(this.phase==='pull'?c.pullForce:c.pushForce)*weak*this.effort*grip*(1-.45*this.slip);
 }
 const applied=this.force+c.mass*9.81*Math.sin(slope);const friction=Math.abs(this.velocity)<.001?c.staticFriction:c.slidingFriction;
 if(Math.abs(this.velocity)<.001&&Math.abs(applied)<=friction)this.velocity=0;
 else{const direction=Math.abs(this.velocity)>.001?Math.sign(this.velocity):Math.sign(applied);const next=this.velocity+(applied-direction*friction-c.drag*this.velocity)/c.mass*dt;this.velocity=next*direction<0&&Math.abs(applied)<=friction?0:next;}
 const dz=this.velocity*dt;this.z+=dz;if(this.force>0)this.distanceByEffort+=dz;
 return this.snapshot(progress);
 }
 snapshot(progress=0){return {phase:this.phase,progress,actor:this.actor,z:this.z,velocity:this.velocity,force:this.force,effort:this.effort,slip:this.slip,sequence:this.sequence,weaponBracing:this.actor==='arm.R'&&this.phase!=='recover'};}
}
