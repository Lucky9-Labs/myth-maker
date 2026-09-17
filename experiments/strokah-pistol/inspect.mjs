import fs from "node:fs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Vector3, Box3, AnimationMixer } from "three";
const b = fs.readFileSync("output/structural-loss/model.glb");
const g = await new GLTFLoader().parseAsync(
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  "",
);
console.log(
  "clips",
  g.animations.map((x) => [x.name, x.duration]),
);
const m = new AnimationMixer(g.scene);
m.clipAction(g.animations[0]).play();
m.setTime(1 / 24);
g.scene.updateMatrixWorld(true);
g.scene.traverse((n) => {
  if (
    n.isBone &&
    /hand|arm|index|middle|ring|pinky|thumb|shoulder/.test(n.name)
  )
    console.log(
      n.name,
      JSON.stringify({
        p: n.getWorldPosition(new Vector3()).toArray(),
        q: n.quaternion.toArray(),
        local: n.position.toArray(),
        children: n.children.map((x) => x.name),
      }),
    );
});
