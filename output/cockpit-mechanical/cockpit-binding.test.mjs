import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';import {AnimationMixer} from 'three';import {createCockpitRig} from './cockpit-binding.mjs';import {UpperBody} from './accepted-runtime/upper-body.mjs';
test('actual accepted rig: rigid panels, unchanged limbs/grips, closed reseating after reversals',async()=>{
 const b=await fs.readFile(new URL('./working/accepted.glb',import.meta.url));const g=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');const root=g.scene,mix=new AnimationMixer(root);mix.clipAction(g.animations[0]).play();mix.setTime(1/24);
 const upper=new UpperBody(root);upper.gripRig.translateWorld({x:0,y:-.1,z:-.12});upper.solveGrips();assert(Math.max(...upper.armErrors)<1e-6);
 const cfg=JSON.parse(await fs.readFile(new URL('./mechanism.json',import.meta.url)));const {motion,bindings}=createCockpitRig(root,cfg);root.updateMatrixWorld(true);const all=[];root.traverse(n=>all.push([n,n.matrix.clone()]));
 for(let i=0;i<200;i++){motion.open();motion.update(.83);motion.close();motion.update(.19);motion.hold();motion.update(4);motion.open();motion.update(3);for(const {node} of bindings)assert(Math.max(...node.scale.toArray().map(v=>Math.abs(v-1)))<1e-6);motion.close();motion.update(3);}
 root.updateMatrixWorld(true);for(const [node,rest]of all)assert(Math.max(...rest.elements.map((v,i)=>Math.abs(v-node.matrix.elements[i])))<1e-12,node.name+' drift');
 const waist=root.getObjectByName('waist');waist.rotateY(.3);motion.seek(.6);root.updateMatrixWorld(true);motion.seek(0);root.updateMatrixWorld(true);for(const {node,neutral}of bindings)assert(Math.max(...neutral.elements.map((v,i)=>Math.abs(v-node.matrix.elements[i])))<1e-12);
});
