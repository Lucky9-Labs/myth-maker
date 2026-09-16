// Rigid two-stage paths evaluated from immutable neutral transforms, never accumulated.
export function smooth(t) { t=Math.max(0,Math.min(1,t)); return t*t*t*(t*(t*6-15)+10); }
export function panelOffset(part,amount,clearanceEnd=.3) {
 const a=smooth(amount/clearanceEnd),b=smooth((amount-clearanceEnd)/(1-clearanceEnd));
 if(amount<=0)return [0,0,0];
 return part.clearance.map((v,i)=>v*a+part.travel[i]*(part.travelRanges?smooth((amount-part.travelRanges[i][0])/(part.travelRanges[i][1]-part.travelRanges[i][0])):b));
}
export class CockpitMotion {
 constructor(apply,{duration=1.65}={}) { if(!(duration>0))throw new Error('duration must be positive');this.duration=duration;this.apply=apply;this.amount=0;this.target=0;this.apply(0); }
 get state(){return this.amount===0?'closed':this.amount===1?'open':this.amount===this.target?'held':this.target>this.amount?'opening':'closing';}
 open(){this.target=1;}
 close(){this.target=0;}
 hold(){this.target=this.amount;}
 seek(amount){if(!Number.isFinite(amount))throw new Error('amount must be finite');this.amount=Math.max(0,Math.min(1,amount));this.target=this.amount;this.apply(this.amount);}
 update(dt){if(!Number.isFinite(dt)||dt<0)throw new Error('dt must be finite and nonnegative');const step=Math.min(dt/this.duration,Math.abs(this.target-this.amount));this.amount+=Math.sign(this.target-this.amount)*step;if(Math.abs(this.amount-this.target)<1e-12)this.amount=this.target;this.apply(this.amount);return this.amount;}
}

export function panelAngle(part,amount,clearanceEnd=.3){const [start,end]=part.rotationRange??[clearanceEnd,1];return (part.angle??0)*smooth((amount-start)/(end-start));}
