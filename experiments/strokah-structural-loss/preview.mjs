import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { StructuralController } from "./controller.mjs";
const scene = new T.Scene();
scene.background = new T.Color("#263740");
const camera = new T.PerspectiveCamera(
  38,
  (innerWidth - 300) / innerHeight,
  0.01,
  100,
);
const renderer = new T.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setSize(innerWidth - 300, innerHeight);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
document.body.append(renderer.domElement);
renderer.domElement.style.marginLeft = "300px";
addEventListener("resize", () => {
  camera.aspect = (innerWidth - 300) / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth - 300, innerHeight);
});
const orbit = new OrbitControls(camera, renderer.domElement);
scene.add(new T.HemisphereLight(0xdcefff, 0x747362, 3));
const light = new T.DirectionalLight(0xffffff, 3);
light.position.set(2, 4, 3);
light.castShadow = true;
light.shadow.mapSize.set(1024, 1024);
Object.assign(light.shadow.camera, {
  left: -2,
  right: 2,
  top: 2,
  bottom: -2,
  near: 0.1,
  far: 10,
});
light.shadow.normalBias = 0.002;
scene.add(light);
const ground = new T.Mesh(
  new T.PlaneGeometry(20, 20).rotateX(-Math.PI / 2),
  new T.MeshStandardMaterial({ color: 0x536569, roughness: 1 }),
);
ground.receiveShadow = true;
scene.add(ground);
const grid = new T.GridHelper(20, 100, 0x90a5a8, 0x697e82);
grid.position.y = 0.001;
scene.add(grid);
const gltf = await new GLTFLoader().loadAsync("/model.glb");
gltf.scene.traverse((n) => {
  if (n.isMesh) {
    n.castShadow = true;
    n.receiveShadow = true;
    n.material = new T.MeshStandardMaterial({
      color: 0xb1bec6,
      metalness: 0.4,
      roughness: 0.5,
    });
  }
});
const controller = new StructuralController(gltf, scene);
const $ = (id) => document.getElementById(id);
let paused = false;
function view(name = "quarter") {
  const angle = {
    quarter: 0.65,
    side: Math.PI / 2,
    rear: 2.5,
    opposite: -0.65,
  }[name];
  orbit.target.set(0, 0.42, controller.z);
  camera.position
    .copy(orbit.target)
    .add(new T.Vector3(Math.sin(angle) * 2.8, 0.5, Math.cos(angle) * 2.8));
  orbit.update();
}
function render() {
  if($("proof"))$("proof").textContent="Lost: "+Object.entries(controller.state.parts).filter(([id,p])=>p.lost).map(([id])=>id).join(" + ")+" · "+controller.metrics.mode+" · "+((controller.metrics.velocity??0)*100).toFixed(1)+" cm/s";
  renderer.render(scene, camera);
  $("status").textContent =
    Object.entries(controller.state.parts)
      .map(
        ([id, p]) =>
          `${id}: ${p.lost ? "DETACHED" : p.armor > 0 ? `armor ${p.armor}` : `exposed · ${p.hits}/3 hits`}`,
      )
      .join("\n") +
    `\n\n${controller.metrics.mode}\nWeapon ${controller.state.armed ? "online" : "lost"} · shots ${controller.fired}\nDebris ${controller.ownership.debris.length}\nForce ${(controller.metrics.force??0).toFixed(0)} N · speed ${((controller.metrics.velocity??0)*100).toFixed(1)} cm/s`;
}
$("hit").onclick = () => {
  controller.hit($("limb").value, 30);
  render();
};
$("weak").onclick = () => {
  controller.hit($("limb").value, 10);
  render();
};
$("reset").onclick = () => {
  controller.reset();
  view($("view").value);
  render();
};
$("fire").onclick = () => controller.fire();
$("view").onchange = () => {
  view($("view").value);
  render();
};
$("pause").onclick = () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
};
window.review = {
  controller,
  identity:{feature:"strokah-effort-drag",worktree:"8a6b",runtime:"three-0.180.0/cannon-es-0.20.0"},
  mask:(mask)=>{if($("combination"))$("combination").value=mask;controller.reset();["arm.L","arm.R","leg.L","leg.R"].forEach((id,i)=>{if(mask&(1<<i))for(let n=0;n<5;n++)controller.hit(id,30);});render();},
  view,
  render,
  pause: () => {
    paused = true;
    $("pause").textContent = "Resume";
  },
  step: (n = 1) => {
    for (let i = 0; i < n; i++)
      controller.update(1 / 60, {
        move: $("move").checked,
        aimYaw: (Number($("aim").value) * Math.PI) / 180,
      });
    render();
    return controller.metrics;
  },
  scenario: (id) => {
    controller.reset();
    for (let i = 0; i < 5; i++) controller.hit(id, 30);
    render();
  },
};
view();
let last = performance.now();
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.04);
  last = now;
  if (!paused) {
    controller.update(dt, {
      move: $("move").checked,
      aimYaw: (Number($("aim").value) * Math.PI) / 180,
    });
    render();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (!event.shiftKey) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ray = new T.Raycaster();
  ray.setFromCamera(
    new T.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((event.clientY - rect.top) / rect.height) * 2,
    ),
    camera,
  );
  const hit = controller.ownership.raycast(ray)[0];
  if (hit) {
    $("limb").value = hit.limb;
    controller.hit(hit.limb, 30);
    render();
  }
});

orbit.addEventListener("change", () => renderer.render(scene, camera));

const combination=document.createElement("select");combination.id="combination";for(let mask=0;mask<16;mask++){const option=document.createElement("option");option.value=mask;option.textContent=mask?"Lost: "+["arm.L","arm.R","leg.L","leg.R"].filter((id,i)=>mask&(1<<i)).join(" + "):"All limbs intact";combination.append(option);}document.querySelector("aside").insertBefore(combination,$("limb"));combination.onchange=()=>review.mask(Number(combination.value));
const shove=document.createElement("button");shove.textContent="External shove";shove.onclick=()=>controller.effortMotion.impulse(14);document.querySelector("aside").append(shove);

const proof=document.createElement("div");proof.id="proof";proof.style.cssText="position:absolute;left:320px;top:108px;padding:10px;background:#18252de0;color:#e7eff5;font:14px system-ui;pointer-events:none";document.body.append(proof);
