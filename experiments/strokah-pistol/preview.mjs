import * as T from "three";
import { StructuralController } from "../strokah-structural-loss/controller.mjs";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { PistolRig } from "./pistol-rig.mjs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { findRigNode as node } from "../strokah-structural-loss/vendor/mechanical-legs.mjs";
import { UpperBody } from "../strokah-structural-loss/vendor/upper-body.mjs";
const scene = new T.Scene();
scene.background = new T.Color("#24333c");
const camera = new T.PerspectiveCamera(
  35,
  innerWidth / innerHeight,
  0.005,
  100,
);
const renderer = new T.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const orbit = new OrbitControls(camera, renderer.domElement);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  render();
});
scene.add(new T.HemisphereLight(0xe0f3ff, 0x586052, 3));
for (const [x, z] of [
  [2, 3],
  [-3, -1],
]) {
  const l = new T.DirectionalLight(0xffffff, 3);
  l.position.set(x, 4, z);
  scene.add(l);
}
scene.add(new T.GridHelper(10, 50, 0x657680, 0x3f5059));
const gltf = await new GLTFLoader().loadAsync(
  "/output/structural-loss/model.glb",
);
scene.add(gltf.scene);
const root = gltf.scene;
root.traverse((n) => {
  if (n.isMesh)
    n.material = new T.MeshStandardMaterial({
      color: 0xb4c3ca,
      metalness: 0.45,
      roughness: 0.55,
    });
});
const neutral = [];
root.traverse((n) => {
  if (n.isBone) neutral.push({ n, q: n.quaternion.clone() });
});
root.updateMatrixWorld(true);
for (const [i, side] of ["L", "R"].entries())
  node(root, "upper_arm." + side).attach(
    node(root, `tripo_part_34.00${i + 2}`),
  );
const mixer = new T.AnimationMixer(root);
const locomotion = gltf.animations[0].clone();
locomotion.tracks = locomotion.tracks.filter(
  (t) =>
    !["tripo_part_34002", "tripo_part_34003"].some((n) =>
      t.name.startsWith(n + "."),
    ),
);
mixer.clipAction(locomotion).play();
mixer.setTime(1 / 24);
node(root, "Terrain_Walk_Test").visible = false;
const upper = new UpperBody(root);
upper.weapon.visible = false;
const pistol = new T.Group();
pistol.name = "StrokahPistol";
scene.add(pistol);
const parts = await (await fetch("/output/pistol/tripo-geometry.json")).json();
for (const p of parts) {
  let geo = new T.BufferGeometry();
  geo.setAttribute(
    "position",
    new T.Float32BufferAttribute(p.positions.flat(), 3),
  );
  if (p.indices) geo.setIndex(p.indices);
  geo = mergeVertices(geo);
  geo.computeVertexNormals();
  const mesh = new T.Mesh(
    geo,
    new T.MeshStandardMaterial({
      color: p.name.endsWith("_3") ? 0xc88932 : 0x3b4b59,
      metalness: 0.6,
      roughness: 0.4,
      side: T.DoubleSide,
    }),
  );
  mesh.name = p.name;
  pistol.add(mesh);
}
for (const mesh of pistol.children) {
  mesh.geometry.scale(0.4, 0.4, 0.4);
}
const rig = new PistolRig(root, upper, pistol, neutral);
const leftPistol = new T.Group();
leftPistol.name = "LeftPistol";
for (const child of pistol.children.filter((x) => x.isMesh))
  leftPistol.add(child.clone());
scene.add(leftPistol);
const leftRig = new PistolRig(root, upper, leftPistol, neutral, {
  rightRotation: rig.rightRotation,
});
leftPistol.visible = false;
const damagedGltf = await new GLTFLoader().loadAsync(
  "/output/structural-loss/model.glb",
);
const damagedRoot = damagedGltf.scene;
damagedRoot.traverse((n) => {
  if (n.isMesh)
    n.material = new T.MeshStandardMaterial({
      color: 0xb4c3ca,
      metalness: 0.45,
      roughness: 0.55,
    });
});
const damagedScene = new T.Group();
scene.add(damagedScene);
const crawl = new StructuralController(damagedGltf, damagedScene);
const crawlWeapon = new T.Group();
for (const child of pistol.children.filter((x) => x.isMesh))
  crawlWeapon.add(child.clone());
damagedScene.add(crawlWeapon);
const crawlRig = new PistolRig(damagedRoot, crawl.upper, crawlWeapon, neutral, {
  rightRotation: rig.rightRotation,
});
damagedScene.visible = false;
const saved = [];
root.traverse((n) =>
  saved.push({
    n,
    p: n.position.clone(),
    q: n.quaternion.clone(),
    s: n.scale.clone(),
  }),
);
const pos = (n) => n.getWorldPosition(new T.Vector3());
let paused = false,
  time = 0,
  state = "ready",
  side = "R",
  mode = "front",
  crawlTime = -1;
function view(v) {
  mode = v;
  let target = new T.Vector3(0, 0.64, 0.1),
    offset = new T.Vector3(1.05, 0.34, 1.9);
  if (state === "crawl") {
    target.y = 0.24;
    target.z = 0.18;
  }
  if (v === "side") offset.set(2.0, 0.26, 0);
  if (v === "opposite") offset.set(-1.2, 0.32, 1.8);
  if (v === "action") {
    target.set(0, 0.78, 0.16);
    offset.set(side === "R" ? -0.95 : 0.95, 0.22, 1.4);
  }
  if (v === "close") {
    target.copy(pos(node(root, "hand." + (side === "Dual" ? "L" : side))));
    offset.set(side === "R" ? -0.35 : 0.35, 0.15, 0.5);
  }
  if (v === "weapon") {
    target.copy(pistol.position);
    offset.set(0, 0.15, 0.6);
  }
  orbit.target.copy(target);
  camera.position.copy(target).add(offset);
  orbit.update();
}
function render() {
  renderer.render(scene, camera);
}
function sample(t = 0, s = "ready", hand = "R", options = {}) {
  if (hand === "Dual" && ["reload", "crawl"].includes(s)) s = "ready";
  for (const option of document.querySelectorAll("#state option"))
    option.disabled =
      hand === "Dual" && ["reload", "crawl"].includes(option.value);
  document.querySelector("h1").innerHTML =
    "Strokah<br>" + (hand === "Dual" ? "Dual pistols" : "Single-hand pistol");
  leftPistol.visible = hand === "Dual" && !["neutral", "rifle"].includes(s);
  time = t;
  state = s;
  side = hand;
  damagedScene.visible = s === "crawl";
  root.visible = s !== "crawl";
  pistol.visible = s !== "neutral" && s !== "crawl" && s !== "rifle";
  upper.weapon.visible = s === "rifle";
  if (s !== "crawl") crawlTime = -1;
  if (s === "crawl") {
    if (crawlTime < 0 || t < crawlTime) {
      crawl.reset();
      for (const limb of ["leg.L", "leg.R"])
        for (let i = 0; i < 5; i++) crawl.hit(limb, 30);
      crawlTime = -1.4;
    }
    for (let i = 0; i < Math.round((t - crawlTime) * 60); i++) {
      for (const x of crawl.saved)
        if (/^(index|middle|ring|thumb)/.test(x.n.name))
          x.n.quaternion.copy(x.q);
      crawl.update(1 / 60);
    }
    crawlTime = t;
    const support = crawl.upper.gripTargets[0];
    const p = support.position.clone(),
      q = support.rotation.clone();
    if (hand === "L") {
      p.x = -p.x;
      q.set(q.x, -q.y, -q.z, q.w);
    }
    const supportFingerPose = {};
    for (const f of crawlRig.fingers) {
      const q = crawl.saved.find((x) => x.n === f.l).q.clone();
      if (hand === "L") q.set(q.x, -q.y, -q.z, q.w);
      supportFingerPose[hand === "R" ? f.l.name : f.r.name] = q;
    }
    crawl.upper.weapon.visible = false;
    crawlRig.update(t, "ready", hand, {
      pitch: -0.15,
      elbow: -0.85,
      supportFingerPose,
      supportOverride: { position: p, rotation: q, weight: 1 },
    });
    document.querySelector("#status").textContent =
      `${hand} HAND · CRAWL\nActual structural-loss controller\nSupport contact retained`;
    render();
    return;
  }
  for (const x of saved) {
    x.n.position.copy(x.p);
    x.n.quaternion.copy(x.q);
    x.n.scale.copy(x.s);
  }
  if (s === "neutral") for (const x of neutral) x.n.quaternion.copy(x.q);
  if (["walk", "sprint"].includes(s))
    mixer.setTime(t * (s === "sprint" ? 1.65 : 1));
  root.updateMatrixWorld(true);
  if (s !== "neutral" && s !== "rifle") {
    if (hand === "Dual") {
      rig.update(t, s, "R", options);
      const rightNodes = [
        ...upper.chains[1].nodes,
        ...rig.fingers.map((f) => f.r),
      ];
      const rightPose = rightNodes.map((n) => n.quaternion.clone());
      leftRig.update(t + (s === "fire" ? 0.36 : 0), s, "L", options);
      rightNodes.forEach((n, i) => n.quaternion.copy(rightPose[i]));
      root.updateMatrixWorld(true);
    } else rig.update(t, s, hand, options);
  }
  document.getElementById("side").value = hand;
  document.getElementById("state").value = s;
  document.querySelector("#status").textContent =
    `${hand === "Dual" ? "DUAL" : hand === "R" ? "RIGHT HAND" : "LEFT HAND"} · ${s.toUpperCase()}\n${t.toFixed(2)} s\nTripo 9bf49e1c · exact source\nAccepted Strokah model`;
  render();
}
window.review = {
  sample,
  sequence: (t, hand) => {
    const smooth = (x) => {
      x = Math.max(0, Math.min(1, x));
      return x * x * (3 - 2 * x);
    };
    if (t < 0.3) sample(t, "ready", hand);
    else if (t < 0.7)
      sample(t - 0.3, "aim", hand, { aimWeight: smooth((t - 0.3) / 0.4) });
    else if (t < 1.4) sample(t - 0.7, "fire", hand);
    else if (t < 1.7)
      sample(t - 1.4, "aim", hand, { aimWeight: 1 - smooth((t - 1.4) / 0.3) });
    else if (t < 4.1) sample(t - 1.7, "reload", hand);
    else sample(t - 4.1, "ready", hand);
  },
  view,
  render,
  root,
  pistol,
  rig,
  crawl,
  crawlRig,
  upper,
  neutral,
  saved,
  scene,
  camera,
};
for (const [id, v] of [
  ["front", "front"],
  ["sideview", "side"],
  ["opposite", "opposite"],
  ["close", "close"],
  ["weapon", "weapon"],
])
  document.getElementById(id).onclick = () => {
    view(v);
    render();
  };
document.getElementById("pause").onclick = () => (paused = !paused);
for (const id of ["side", "state"])
  document.getElementById(id).onchange = () => {
    side = document.getElementById("side").value;
    state = document.getElementById("state").value;
    sample(0, state, side);
    view(mode);
  };
view("front");
let last = performance.now();
function tick(now) {
  if (!paused) sample(time + (now - last) / 1000, state, side);
  last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
review.pause = () => (paused = true);
