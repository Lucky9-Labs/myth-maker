import assert from 'node:assert/strict';
import {Quaternion} from 'three';
import {findRigNode} from './mechanical-legs.mjs';
export function captureHingeFrames(root) {
  return ['shin','lower_shin','ball','heel','toe'].flatMap(part=>['L','R'].map(side=>{
    const node=findRigNode(root,`${part}.${side}`);
    return {node,bind:node.quaternion.clone()};
  }));
}
export function assertHingeLocks(frames, label='') {
  for(const {node,bind} of frames) {
    const delta=bind.clone().invert().multiply(node.quaternion).normalize();
    const twist=new Quaternion(delta.x,0,0,delta.w).normalize();
    const swing=delta.angleTo(twist)*180/Math.PI;
    assert.ok(swing < .1, `${label} ${node.name}: ${swing} degrees outside actual local-X hinge`);
  }
}
