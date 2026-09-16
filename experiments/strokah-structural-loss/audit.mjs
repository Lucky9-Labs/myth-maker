import fs from "node:fs/promises";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Scene } from "three";
import { StructuralController } from "./controller.mjs";
const b = await fs.readFile(
  new URL("../../output/structural-loss/model.glb", import.meta.url),
);
const g = await new GLTFLoader().parseAsync(
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  "",
);
const c = new StructuralController(g, new Scene());
console.log("initial", JSON.stringify(c.metrics));
for (let i = 0; i < 5; i++) c.hit("leg.L", 30);
for (let i = 0; i < 150; i++) {
  c.update(1 / 60);
  if (i % 30 === 29) console.log(i + 1, JSON.stringify(c.metrics));
}
