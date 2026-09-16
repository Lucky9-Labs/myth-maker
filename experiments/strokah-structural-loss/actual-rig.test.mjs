import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Scene } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { StructuralController } from "./controller.mjs";
import {
  captureHingeFrames,
  assertHingeLocks,
} from "./vendor/hinge-lock-check.mjs";
async function load() {
  const b = await fs.readFile(
    new URL("../../output/structural-loss/model.glb", import.meta.url),
  );
  const g = await new GLTFLoader().parseAsync(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    "",
  );
  const hinges = captureHingeFrames(g.scene);
  const c = new StructuralController(g, new Scene());
  for (const chain of c.upper.chains)
    hinges.push({
      node: chain.nodes[2],
      bind: chain.nodes[2].quaternion.clone(),
    });
  return { c, hinges };
}
for (const id of ["arm.L", "arm.R", "leg.L", "leg.R"])
  test(`actual rig: ${id} ownership, contacts, local hinges, weapon, reset`, async () => {
    const { c, hinges } = await load();
    const original = c.saved.map((r) => [
      r.n,
      r.n.parent,
      r.n.position.clone(),
      r.n.scale.clone(),
      r.n.quaternion.clone(),
    ]);
    const meshes = [];
    c.root.traverse((n) => {
      if (n.isMesh) meshes.push(n);
    });
    const count = meshes.length;
    for (let i = 0; i < 5; i++) c.hit(id, 30);
    const debris = c.ownership.debris[0];
    const detachedNodes = [];
    debris.group.traverse((n) => detachedNodes.push(n));
    assert.ok(detachedNodes.some((n) => n.isMesh));
    const attached = [];
    c.root.traverse((n) => {
      if (n.isMesh) attached.push(n);
    });
    assert.equal(attached.length + debris.colliders.length, count);
    assert.ok(!attached.some((n) => detachedNodes.includes(n)));
    for (let i = 0; i < 10; i++) c.hit(id, 100);
    assert.equal(c.ownership.debris.length, 1);
    assert.equal(c.fire(), id !== "arm.R");
    const ownedRoot = debris.group.children[0];
    const detachedLocal = ownedRoot.quaternion.clone();
    let maxHand = 0,
      maxGrip = 0,
      maxJointStep = 0;
    const previous = new Map();
    for (let frame = 0; frame < 360; frame++) {
      c.update(1 / 60);
      assertHingeLocks(
        hinges.filter((h) => !detachedNodes.includes(h.node)),
        `${id} ${frame}`,
      );
      assert.ok(
        ownedRoot.quaternion
          .toArray()
          .every((v, i) => Math.abs(v - detachedLocal.toArray()[i]) < 1e-9),
        "solver changed detached limb",
      );
      for (const { n } of c.saved) {
        if (detachedNodes.includes(n)) continue;
        if (previous.has(n))
          maxJointStep = Math.max(
            maxJointStep,
            n.quaternion.angleTo(previous.get(n)),
          );
        previous.set(n, n.quaternion.clone());
      }
      if (id.startsWith("leg") && frame > 90) {
        maxGrip = Math.max(maxGrip, c.upper.armErrors[1] ?? 0);
        const contact = c.contacts["hand.L"];
        if (contact && c.metrics.hands.L?.phase === "stance") {
          maxHand = Math.max(maxHand, Math.abs(c.metrics.hands.L.clearance));
          assert.ok(
            c.metrics.hands.L.clearance >= -0.001 &&
              c.metrics.hands.L.clearance < 0.01,
            `hand contact ${c.metrics.hands.L.clearance}`,
          );
        }
        for (const f of c.metrics.feet)
          assert.ok(f.clearance >= -0.001, `sole penetrates ${f.clearance}`);
      }
    }
    assert.ok(maxJointStep < 0.35, `joint step ${maxJointStep}`);
    assert.ok(maxGrip < 0.002, `weapon grip ${maxGrip}`);
    assert.ok(debris.settled);
    c.reset();
    assert.equal(c.ownership.debris.length, 0);
    assert.equal(c.state.armed, true);
    assert.equal(c.state.crawling, false);
    for (const [n, parent, position, scale, rotation] of original) {
      assert.equal(n.parent, parent);
      assert.ok(n.position.distanceTo(position) < 1e-8, "reset position");
      assert.ok(
        n.quaternion.clone().normalize().angleTo(rotation.clone().normalize()) <
          1e-6,
        "reset rotation",
      );
      assert.ok(n.scale.distanceTo(scale) < 1e-8);
    }
    assert.equal(c.root.getObjectByName("DEBRIS_" + id), undefined);
    console.log(JSON.stringify({ id, maxJointStep, maxGrip, maxHand }));
  });

test("combined loss, interrupted crawl, aiming and dropped weapon stay coherent", async () => {
  const { c } = await load();
  for (let i = 0; i < 5; i++) c.hit("leg.R", 30);
  for (let frame = 0; frame < 210; frame++)
    c.update(1 / 60, { move: frame < 145 });
  assert.ok(
    Object.values(c.contacts).every((contact) => contact.phase === "stance"),
    "finish swings after stopping",
  );
  const stopped = c.z;
  for (let i = 0; i < 60; i++) c.update(1 / 60, { move: false });
  assert.equal(c.z, stopped);
  for (let i = 0; i < 90; i++)
    c.update(1 / 60, { aimYaw: 0.1 * Math.sin(i / 60) });
  assert.ok(c.fire());
  for (let i = 0; i < 5; i++) c.hit("arm.R", 30);
  const weapon = c.upper.gripRig.control;
  const before = weapon.position.clone();
  for (let i = 0; i < 120; i++) c.update(1 / 60);
  assert.ok(!c.fire());
  assert.ok(
    weapon.position.distanceTo(before) < 1e-10,
    "no dropped weapon pose reset",
  );
  assert.ok(c.state.mobile);
  assert.ok(c.metrics.hands.L.clearance > -0.002);
  for (let i = 0; i < 5; i++) c.hit("arm.L", 30);
  const z = c.z;
  for (let i = 0; i < 60; i++) c.update(1 / 60);
  assert.equal(c.z, z);
  assert.ok(!c.state.mobile);
  c.reset();
  assert.equal(c.state.events.length, 0);
  assert.equal(c.fired, 0);
});
