import fs from "node:fs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Vector3, Box3, Quaternion } from "three";
import { findRigNode as node } from "../strokah-structural-loss/vendor/mechanical-legs.mjs";
const bytes = fs.readFileSync("output/structural-loss/model.glb");
const g = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);
g.scene.updateMatrixWorld(true);
const pos = (n) => n.getWorldPosition(new Vector3());
const report = {
  source: "hash-verified accepted Strokah GLB",
  pose: "unsampled exported bind transforms",
  pairs: [],
  hands: {},
};
for (const name of [
  "shoulder_mount",
  "upper_arm",
  "forearm",
  "hand",
  "index.01",
  "index.02",
  "index.03",
  "middle.01",
  "middle.02",
  "middle.03",
  "ring.01",
  "ring.02",
  "ring.03",
  "thumb.01",
  "thumb.02",
  "thumb.03",
]) {
  const l = node(g.scene, name + ".L"),
    r = node(g.scene, name + ".R");
  const rp = pos(r);
  rp.x *= -1;
  report.pairs.push({
    name,
    mirrorPositionError: pos(l).distanceTo(rp),
    leftDeterminant: l.matrixWorld.determinant(),
    rightDeterminant: r.matrixWorld.determinant(),
  });
}
for (const side of ["L", "R"]) {
  const h = node(g.scene, "hand." + side);
  let vertices = 0,
    meshes = 0;
  h.traverse((n) => {
    if (n.isMesh) {
      meshes++;
      vertices += n.geometry.attributes.position.count;
    }
  });
  report.hands[side] = {
    meshes,
    vertices,
    bounds: new Box3().setFromObject(h),
    handLocalRotation: h.quaternion.toArray(),
    forearmLength: pos(h).distanceTo(pos(node(g.scene, "forearm." + side))),
  };
}
report.maxMirrorJointError = Math.max(
  ...report.pairs.map((x) => x.mirrorPositionError),
);
report.note =
  "Bind geometry inventory only. Knuckle limits, shell pinning, wrist alignment and mesh/grip collision still require visual and posed validation with the intended pistol.";
fs.writeFileSync(
  "output/pistol/bind-inspection.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    { maxMirrorJointError: report.maxMirrorJointError, hands: report.hands },
    null,
    2,
  ),
);
