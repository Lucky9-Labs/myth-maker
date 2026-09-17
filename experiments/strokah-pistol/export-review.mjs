import fs from "node:fs/promises";
import {
  AnimationClip,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
  MeshStandardMaterial,
} from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadRig } from "./load-rig.mjs";
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((x) => {
      this.result = x;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((x) => {
      this.result =
        "data:application/octet-stream;base64," +
        Buffer.from(x).toString("base64");
      this.onloadend?.();
    });
  }
};
const { root, scene, mixer, rig, weapon } = await loadRig();
root.traverse((n) => {
  if (n.isMesh)
    n.material = new MeshStandardMaterial({
      color: 0xb4c3ca,
      metalness: 0.45,
      roughness: 0.55,
    });
});
const saved = [];
root.traverse((n) =>
  saved.push({
    n,
    p: n.position.clone(),
    q: n.quaternion.clone(),
    s: n.scale.clone(),
  }),
);
const nodes = saved
  .filter((x) => x.n.isBone)
  .map((x) => x.n)
  .concat([weapon, rig.magazine]);
const smooth = (x) => {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
};
const clips = [];
for (const side of ["R", "L"])
  for (const mode of ["actions", "walk", "sprint"]) {
    const duration = mode === "actions" ? 4.8 : 2,
      frames = Math.round(duration * 20),
      times = [],
      values = nodes.map(() => ({ p: [], q: [] }));
    for (let f = 0; f <= frames; f++) {
      const t = f / 20;
      times.push(t);
      for (const x of saved) {
        x.n.position.copy(x.p);
        x.n.quaternion.copy(x.q);
        x.n.scale.copy(x.s);
      }
      let state = mode,
        clock = t,
        options = {};
      if (mode === "actions") {
        if (t < 0.3) state = "ready";
        else if (t < 0.7) {
          state = "aim";
          clock = t - 0.3;
          options.aimWeight = smooth(clock / 0.4);
        } else if (t < 1.4) {
          state = "fire";
          clock = t - 0.7;
        } else if (t < 1.7) {
          state = "aim";
          clock = t - 1.4;
          options.aimWeight = 1 - smooth(clock / 0.3);
        } else if (t < 4.1) {
          state = "reload";
          clock = t - 1.7;
        } else {
          state = "ready";
          clock = t - 4.1;
        }
      } else mixer.setTime(t * (mode === "sprint" ? 1.65 : 1));
      rig.update(clock, state, side, options);
      nodes.forEach((n, i) => {
        values[i].p.push(...n.position.toArray());
        values[i].q.push(...n.quaternion.toArray());
      });
    }
    const tracks = [];
    nodes.forEach((n, i) => {
      tracks.push(
        new VectorKeyframeTrack(n.uuid + ".position", times, values[i].p),
        new QuaternionKeyframeTrack(n.uuid + ".quaternion", times, values[i].q),
      );
    });
    clips.push(new AnimationClip(`Pistol_${side}_${mode}`, duration, tracks));
  }
for (const x of saved) {
  x.n.position.copy(x.p);
  x.n.quaternion.copy(x.q);
  x.n.scale.copy(x.s);
}
rig.update(0, "ready", "R");
const glb = await new GLTFExporter().parseAsync(scene, {
  binary: true,
  onlyVisible: true,
  animations: clips,
  trs: true,
});
await fs.writeFile(
  "output/pistol/review/strokah-pistol-review.glb",
  Buffer.from(glb),
);
const readback = await new GLTFLoader().parseAsync(glb, "");
const receipt = {
  clips: readback.animations.map((c) => ({
    name: c.name,
    duration: c.duration,
  })),
  bytes: glb.byteLength,
  source: "Tripo 9bf49e1c-3a5b-4991-a0c2-607c51608b08",
  rightCheckpoint: "right-hand-approved",
};
await fs.writeFile(
  "output/pistol/review/export-readback.json",
  JSON.stringify(receipt, null, 2),
);
console.log(receipt);
