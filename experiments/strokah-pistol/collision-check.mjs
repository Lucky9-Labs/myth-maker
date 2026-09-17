import fs from "node:fs";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { UpperBody } from "../strokah-structural-loss/vendor/upper-body.mjs";
import { findRigNode as node } from "../strokah-structural-loss/vendor/mechanical-legs.mjs";
import { PistolRig } from "./pistol-rig.mjs";
const bytes = fs.readFileSync("output/structural-loss/model.glb");
const g = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);
const mix = new T.AnimationMixer(g.scene);
mix.clipAction(g.animations[0]).play();
mix.setTime(1 / 24);
const upper = new UpperBody(g.scene),
  weapon = new T.Group();
new T.Scene().add(g.scene, weapon);
let grip;
for (const p of JSON.parse(
  fs.readFileSync("output/pistol/tripo-geometry.json"),
)) {
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(p.positions, 3));
  geo.scale(0.4, 0.4, 0.4);
  const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ side: T.DoubleSide }));
  mesh.name = p.name;
  weapon.add(mesh);
  if (p.name === "tripo_part_1") grip = mesh;
}
const rig = new PistolRig(g.scene, upper, weapon),
  ray = new T.Raycaster(),
  dirs = [
    new T.Vector3(1, 0.13, 0.07).normalize(),
    new T.Vector3(0.1, 1, 0.07).normalize(),
    new T.Vector3(0.09, 0.13, 1).normalize(),
  ];
const report = [];
for (const side of ["R", "L"]) {
  rig.update(0, "aim", side);
  for (const f of ["middle", "ring", "thumb"]) {
    let tested = 0,
      inside = 0,
      maxDepth = 0;
    const byMesh = {};
    const bbox = new T.Box3().setFromObject(grip);
    node(g.scene, `${f}.01.${side}`).traverse((mesh) => {
      if (!mesh.isMesh) return;
      const a = mesh.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const p = new T.Vector3()
          .fromBufferAttribute(a, i)
          .applyMatrix4(mesh.matrixWorld);
        tested++;
        if (!bbox.containsPoint(p)) continue;
        let votes = 0,
          depth = Infinity;
        for (const d of dirs) {
          ray.set(p, d);
          const hits = ray
            .intersectObject(grip, false)
            .filter(
              (h, j, arr) =>
                j === 0 || Math.abs(h.distance - arr[j - 1].distance) > 1e-6,
            );
          if (hits.length % 2) {
            votes++;
            depth = Math.min(depth, hits[0].distance);
          }
        }
        if (votes >= 2 && depth > 0.0005) {
          inside++;
          byMesh[mesh.name] = (byMesh[mesh.name] ?? 0) + 1;
          maxDepth = Math.max(maxDepth, depth);
        }
      }
    });
    report.push({ side, finger: f, tested, inside, maxDepth, byMesh });
    console.log(side, f, { tested, inside, maxDepth, byMesh });
  }
}

fs.writeFileSync(
  "output/pistol/review/collision-audit.json",
  JSON.stringify(report, null, 2),
);
if (report.some((r) => r.inside > 0)) process.exitCode = 1;
