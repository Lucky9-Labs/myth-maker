import fs from "node:fs";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { Box3, Vector3 } from "three";
const bytes = fs.readFileSync("output/pistol/tripo-9bf49e1c.fbx");
const g = new FBXLoader().parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);
g.updateMatrixWorld(true);
console.log("bounds", new Box3().setFromObject(g));
const parts = [];
g.traverse((n) => {
  if (n.isMesh) {
    const geo = n.geometry.clone().applyMatrix4(n.matrixWorld);
    parts.push({
      name: n.name,
      positions: Array.from(geo.attributes.position.array),
      indices: geo.index ? Array.from(geo.index.array) : null,
    });
    console.log(n.name, geo.attributes.position.count, !!geo.index);
  }
});
fs.writeFileSync("output/pistol/tripo-geometry.json", JSON.stringify(parts));
