import {UpperBody} from './accepted-runtime/upper-body.mjs';
import {createCockpitRig} from './cockpit-binding.mjs';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
const scene=new T.Scene();scene.background=new T.Color('#202a35');
const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(1);document.body.append(renderer.domElement);
const camera=new T.PerspectiveCamera(35,innerWidth/innerHeight,.001,50),orbit=new OrbitControls(camera,renderer.domElement);
scene.add(new T.HemisphereLight(0xe2efff,0x60564a,2.5));for(const [x,y,z] of [[2,4,-3],[-2,2,1]]){const l=new T.DirectionalLight(0xffffff,2);l.position.set(x,y,z);scene.add(l)}
const gltf=await new GLTFLoader().loadAsync('./working/cockpit-glass-preview.glb');const mech=gltf.scene;scene.add(mech);const mixer=new T.AnimationMixer(mech);mixer.clipAction(gltf.animations[0]).play();mixer.setTime(1/24);
const upper=new UpperBody(mech);upper.gripRig.translateWorld(new T.Vector3(0,-.1,-.12));upper.solveGrips();
const palette={'tripo_part_61001':0x5ecdec,'tripo_part_57004':0xf5b552,'tripo_part_57005':0xf5b552,'tripo_part_new_0001':0xe07367,'tripo_part_108001':0xa887db};
mech.traverse(n=>{if(n.isMesh){if(n.name==='Terrain_Walk_Test')n.visible=false;n.material=new T.MeshStandardMaterial({color:palette[n.name]??0xa6b0ba,roughness:.65,metalness:.25,side:T.DoubleSide});}});
const config=await (await fetch('./mechanism.json')).json();
const {motion,bindings}=createCockpitRig(mech,config,amount=>{document.querySelector('#amount').value=amount;document.querySelector('#caption').textContent=`${(amount*100).toFixed(0)}% open · ${amount<.3?'seam clearance':'panel travel'}`;});
for(const action of ['open','close','hold'])document.getElementById(action).onclick=()=>motion[action]();
document.querySelector('#amount').oninput=e=>motion.seek(+e.target.value);
const center=new T.Vector3(0,1.025,.035);
function view(v){orbit.target.copy(v==='full'?new T.Vector3(0,.6,0):center);camera.position.copy(orbit.target).add(new T.Vector3(...({front:[0,.015,1.35],side:[1.35,.05,0],quarter:[.85,.2,1.1],full:[1.1,.45,1.7]}[v])));orbit.update();renderer.render(scene,camera)}
for(const v of ['front','side','quarter','full'])document.getElementById(v).onclick=()=>view(v);
document.querySelector('#colors').onchange=e=>{mech.traverse(n=>{if(n.isMesh)n.material.color.setHex(e.target.checked?(palette[n.name]??0xa6b0ba):0xa6b0ba)})};
let mosaic=false;const proofCameras=['front','side','quarter','full'].map(v=>{const c=camera.clone();const target=v==='full'?new T.Vector3(0,.6,0):center;c.position.copy(target).add(new T.Vector3(...({front:[0,.015,1.35],side:[1.35,.05,0],quarter:[.85,.2,1.1],full:[1.1,.45,1.7]}[v])));c.lookAt(target);return c;});
function draw(){if(!mosaic){renderer.setScissorTest(false);renderer.setViewport(0,0,innerWidth,innerHeight);renderer.render(scene,camera);return;}renderer.setScissorTest(true);for(let i=0;i<4;i++){const x=(i%2)*innerWidth/2,y=i<2?innerHeight/2:0;renderer.setViewport(x,y,innerWidth/2,innerHeight/2);renderer.setScissor(x,y,innerWidth/2,innerHeight/2);renderer.render(scene,proofCameras[i]);}}
function setMosaic(value){mosaic=value;document.querySelector('#panel').style.display=value?'none':'';document.querySelectorAll('.proof-label').forEach(n=>n.remove());if(value){['FRONT','SIDE','THREE-QUARTER','FULL MECH'].forEach((text,i)=>{const label=document.createElement('div');label.className='proof-label';label.textContent=text;label.style.cssText=`position:absolute;left:${i%2*50+2}%;top:${Math.floor(i/2)*50+2}%;font:12px system-ui;letter-spacing:2px;color:#b5c5d0`;document.body.append(label);});}draw();}
view('quarter');let last=performance.now();function render(){requestAnimationFrame(render);const now=performance.now();motion.update(Math.min((now-last)/1000,.1));last=now;orbit.update();draw()}render();
window.review={setMosaic,draw,upper,motion,bindings,config,scene,mech,camera,renderer,view,parts:()=>{let a=[];mech.traverse(n=>{if(n.isMesh&&n.parent?.name==='waist'){const b=new T.Box3().setFromObject(n);a.push({name:n.name,min:b.min.toArray(),max:b.max.toArray()})}});return a;}};
