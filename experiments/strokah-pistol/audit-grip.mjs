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
const mixer = new T.AnimationMixer(g.scene);
mixer.clipAction(g.animations[0]).play();
mixer.setTime(1 / 24);
const upper = new UpperBody(g.scene),
  pistol = new T.Group();
const scene = new T.Scene();
scene.add(g.scene, pistol);
const rig = new PistolRig(g.scene, upper, pistol);
for (const side of ["R", "L"]) {
  const metrics = rig.update(0, "aim", side);
  console.log(side, metrics);
  const pos = (n) => n.getWorldPosition(new T.Vector3());
  const f = pos(node(g.scene, "hand." + side))
      .sub(pos(node(g.scene, "forearm." + side)))
      .normalize(),
    h = pos(node(g.scene, "middle.01." + side))
      .sub(pos(node(g.scene, "hand." + side)))
      .normalize();
  console.log("wrist bend degrees", (f.angleTo(h) * 180) / Math.PI);
  for (const finger of ["index", "middle", "ring", "thumb"])
    for (let j = 1; j <= 3; j++) {
      const n = node(g.scene, `${finger}.0${j}.${side}`);
      console.log(
        n.name,
        pistol
          .worldToLocal(pos(n))
          .toArray()
          .map((x) => +x.toFixed(4)),
      );
    }
}
