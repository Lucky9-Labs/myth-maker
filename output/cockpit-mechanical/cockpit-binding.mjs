import * as T from 'three';
import {CockpitMotion,panelOffset,panelAngle} from './cockpit-motion.mjs';

/** Bind once after sampling the actor neutral pose. Subsequent waist movement is inherited. */
export function createCockpitRig(root,config,onChange=()=>{}) {
 root.updateMatrixWorld(true);
 const bindings=config.parts.map(p=>{
  const node=root.getObjectByName(p.node);
  if(!node)throw new Error(`Missing cockpit panel ${p.node}`);
  return {p,node,parent:node.parent.matrixWorld.clone(),inverse:node.parent.matrixWorld.clone().invert(),neutral:node.matrix.clone()};
 });
 const motion=new CockpitMotion(amount=>{
  for(const b of bindings){
   if(amount===0){b.neutral.decompose(b.node.position,b.node.quaternion,b.node.scale);continue;}
   const pivot=new T.Vector3(...(b.p.pivot??[0,0,0]));
   const offset=new T.Vector3(...panelOffset(b.p,amount,config.clearanceEnd));
   const transform=new T.Matrix4().makeTranslation(pivot.x+offset.x,pivot.y+offset.y,pivot.z+offset.z)
    .multiply(new T.Matrix4().makeRotationAxis(new T.Vector3(...(b.p.axis??[1,0,0])).normalize(),panelAngle(b.p,amount,config.clearanceEnd)))
    .multiply(new T.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
   b.inverse.clone().multiply(transform).multiply(b.parent).multiply(b.neutral)
    .decompose(b.node.position,b.node.quaternion,b.node.scale);
  }
  onChange(amount);
 },config);
 return {motion,bindings};
}
