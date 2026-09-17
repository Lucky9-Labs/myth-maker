import fs from "node:fs";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { UpperBody } from "../strokah-structural-loss/vendor/upper-body.mjs";
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
const rig = new PistolRig(g.scene, upper, weapon);
for (const side of ["R", "L"])
  for (let t = 0; t < 2.5; t += 0.2) {
    const m = rig.update(t, "reload", side);
    console.log(
      side,
      t.toFixed(1),
      m.supportError.toFixed(4),
      weapon.position.toArray().map((n) => n.toFixed(3)),
    );
  }
