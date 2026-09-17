import fs from "node:fs/promises";
import {
  AnimationMixer,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Group,
  Scene,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { UpperBody } from "../strokah-structural-loss/vendor/upper-body.mjs";
import { findRigNode } from "../strokah-structural-loss/vendor/mechanical-legs.mjs";
import { PistolRig } from "./pistol-rig.mjs";
export async function loadRig() {
  const bytes = await fs.readFile(
    new URL("../../output/structural-loss/model.glb", import.meta.url),
  );
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  const root = gltf.scene,
    scene = new Scene();
  scene.add(root);
  const bind = [];
  root.traverse((n) => {
    if (n.isBone) bind.push({ n, q: n.quaternion.clone() });
  });
  root.updateMatrixWorld(true);
  for (const [i, side] of ["L", "R"].entries())
    findRigNode(root, "upper_arm." + side).attach(
      findRigNode(root, `tripo_part_34.00${i + 2}`),
    );
  const mixer = new AnimationMixer(root);
  const locomotion = gltf.animations[0].clone();
  locomotion.tracks = locomotion.tracks.filter(
    (t) =>
      !["tripo_part_34002", "tripo_part_34003"].some((n) =>
        t.name.startsWith(n + "."),
      ),
  );
  mixer.clipAction(locomotion).play();
  mixer.setTime(1 / 24);
  findRigNode(root, "Terrain_Walk_Test").visible = false;
  const upper = new UpperBody(root);
  upper.weapon.visible = false;
  const weapon = new Group();
  weapon.name = "StrokahPistol_Tripo_9bf49e1c";
  scene.add(weapon);
  for (const part of JSON.parse(
    await fs.readFile(
      new URL("../../output/pistol/tripo-geometry.json", import.meta.url),
    ),
  )) {
    let geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(part.positions, 3));
    geo.scale(0.4, 0.4, 0.4);
    geo = mergeVertices(geo);
    geo.computeVertexNormals();
    const mesh = new Mesh(
      geo,
      new MeshStandardMaterial({
        color: part.name === "tripo_part_3" ? 0xc88932 : 0x3b4b59,
        metalness: 0.6,
        roughness: 0.4,
      }),
    );
    mesh.name = part.name;
    weapon.add(mesh);
  }
  const rig = new PistolRig(root, upper, weapon, bind);
  return { gltf, root, scene, mixer, upper, weapon, rig, bind };
}
