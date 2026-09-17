import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { Vector3, Quaternion, Triangle } from "three";
import { loadRig } from "./load-rig.mjs";
import { findRigNode as node } from "../strokah-structural-loss/vendor/mechanical-legs.mjs";
const pos = (n) => n.getWorldPosition(new Vector3());
test("both hands keep bounded wrists, exact grip, pinned shoulders and legal elbow axes through the complete action matrix", async () => {
  const { root, upper, weapon, rig, mixer } = await loadRig();
  const lengths = upper.chains.map((c) =>
    c.nodes.map((n) => n.position.clone()),
  );
  const shells = upper.shoulders.map((s) => ({
    n: s.shell,
    p: s.shell.position.clone(),
    q: s.shell.quaternion.clone(),
  }));
  const report = [];
  for (const side of ["L", "R"])
    for (const state of ["ready", "walk", "sprint", "aim", "fire", "reload"]) {
      let maxGrip = 0,
        maxSupport = 0;
      for (let i = 0; i <= 144; i++) {
        if (state === "walk" || state === "sprint")
          mixer.setTime((i / 60) * (state === "sprint" ? 1.65 : 1));
        const m = rig.update(i / 60, state, side);
        maxGrip = Math.max(maxGrip, m.gripError);
        maxSupport = Math.max(maxSupport, m.supportError);
        assert.ok(m.gripError < 0.00001, `${side}/${state}: ${m.gripError}`);
        assert.ok(
          m.supportError < 0.001,
          `${side}/${state} support ${m.supportError}`,
        );
        const chain = upper.chains[side === "L" ? 0 : 1];
        const bind =
          side === "R"
            ? rig.neutralWrist
            : new Quaternion(
                rig.neutralWrist.x,
                -rig.neutralWrist.y,
                -rig.neutralWrist.z,
                rig.neutralWrist.w,
              );
        assert.ok(
          chain.nodes[3].quaternion.angleTo(bind) <
            (["aim", "fire"].includes(state) ? 0.85 : 1e-5),
        );
        const delta = chain.base[2].clone();
        if (side === "L")
          delta.set(
            upper.chains[1].base[2].x,
            -upper.chains[1].base[2].y,
            -upper.chains[1].base[2].z,
            upper.chains[1].base[2].w,
          );
        delta.invert().multiply(chain.nodes[2].quaternion);
        assert.ok(
          Math.abs(delta.y) < 1e-6 && Math.abs(delta.z) < 1e-6,
          "elbow must stay on its local hinge",
        );
        for (const s of shells) {
          assert.ok(s.n.position.distanceTo(s.p) < 1e-10);
          assert.ok(
            s.n.quaternion
              .clone()
              .normalize()
              .angleTo(s.q.clone().normalize()) < 1e-6,
          );
        }
        for (const [j, c] of upper.chains.entries())
          for (const [k, n] of c.nodes.entries())
            assert.ok(
              n.position.distanceTo(lengths[j][k]) < 0.000001,
              "no segment stretch or shoulder translation",
            );
        root.traverse((n) => {
          if (n.isBone)
            assert.ok(
              n.matrixWorld.determinant() > 0,
              "no negative-scale mirror",
            );
        });
      }
      report.push({ side, state, maxGrip, maxSupport });
    }
  await fs.writeFile(
    new URL("../../output/pistol/action-audit.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
});
test("reload releases support, extracts the actual magazine, reseats and restores the normal role exactly", async () => {
  const { rig, weapon } = await loadRig();
  for (const side of ["L", "R"]) {
    const start = rig.update(0, "reload", side);
    assert.equal(start.supportOverrideWeight, 0);
    const mid = rig.update(1.2, "reload", side);
    assert.equal(mid.supportOverrideWeight, 1);
    assert.equal(mid.magazineExtraction, 1);
    assert.equal(rig.magazine.position.y, -0.11);
    assert.equal(rig.magazine.name, "tripo_part_3");
    const end = rig.update(2.4, "reload", side);
    assert.equal(end.supportOverrideWeight, 0);
    assert.equal(end.magazineExtraction, 0);
    assert.ok(Math.abs(rig.magazine.position.y) < 1e-10);
  }
});
test("side changes use one rig and return to identical transforms without accumulating rotations", async () => {
  const { root, rig } = await loadRig();
  rig.update(0.5, "aim", "R");
  const poses = [];
  root.traverse((n) => {
    if (n.isBone) poses.push([n, n.position.clone(), n.quaternion.clone()]);
  });
  for (let i = 0; i < 12; i++) {
    rig.update(0.5, "aim", "L");
    rig.update(0.5, "aim", "R");
  }
  for (const [n, p, q] of poses) {
    assert.ok(n.position.distanceTo(p) < 1e-9);
    assert.ok(
      n.quaternion.clone().normalize().angleTo(q.clone().normalize()) < 1e-5,
    );
  }
});
test("lost weapon arm carries its pistol; lost support arm cannot reload; bracing preserves the external arm pose", async () => {
  for (const side of ["L", "R"]) {
    const { root, scene, rig, upper } = await loadRig();
    rig.update(0, "ready", side);
    const chain = upper.chains[side === "L" ? 0 : 1],
      hand = chain.nodes[3];
    scene.attach(chain.nodes[1]);
    chain.nodes[1].position.y -= 0.1;
    chain.nodes[1].rotateZ(0.3);
    root.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    const q = chain.nodes.map((n) => n.quaternion.clone());
    const m = rig.update(0.3, "fire", side, { disabledSides: new Set([side]) });
    assert.equal(m.canFire, false);
    assert.equal(m.armed, false);
    assert.ok(m.gripError < 0.00001);
    chain.nodes.forEach((n, i) =>
      assert.ok(
        n.quaternion.clone().normalize().angleTo(q[i].clone().normalize()) <
          1e-6,
      ),
    );
  }
  for (const side of ["L", "R"]) {
    const { rig, upper } = await loadRig();
    const support = side === "L" ? "R" : "L";
    const m = rig.update(1.2, "reload", side, {
      disabledSides: new Set([support]),
    });
    assert.equal(m.supportOverrideWeight, 0);
    assert.equal(m.magazineExtraction, 0);
    assert.ok(m.gripError < 0.00001);
    const q = upper.chains.flatMap((c) =>
      c.nodes.map((n) => [n, n.quaternion.clone()]),
    );
    const b = rig.update(0.3, "fire", side, { weaponBracing: true });
    assert.equal(b.canFire, false);
    assert.ok(b.gripError < 0.00001);
    for (const [n, old] of q)
      assert.ok(
        n.quaternion.clone().normalize().angleTo(old.clone().normalize()) <
          1e-6,
      );
  }
});
test("left aim and fire poses are exact reflections of the approved right action poses", async () => {
  const { root, rig, weapon, upper } = await loadRig();
  for (const state of ["aim", "fire"])
    for (const t of [0, 0.04, 0.4, 1.2, 1.85, 2.399]) {
      rig.update(t, state, "R");
      const points = [];
      for (const stem of [
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
      ])
        points.push([stem, pos(node(root, stem + ".R"))]);
      const gun = weapon.position.clone();
      rig.update(t, state, "L");
      for (const [stem, p] of points) {
        p.x = -p.x;
        assert.ok(
          pos(node(root, stem + ".L")).distanceTo(p) < 0.000002,
          `${state}/${stem}`,
        );
      }
      gun.x = -gun.x;
      assert.ok(weapon.position.distanceTo(gun) < 0.000002);
    }
});
test("calibrated knuckles remain within bounded flex and splay; trigger index reaches the weapon-local trigger", async () => {
  const { rig, root } = await loadRig();
  for (const side of ["L", "R"]) {
    rig.update(0.5, "aim", side);
    const trigger = pos(rig.trigger);
    let distance = Infinity;
    node(root, "index.03." + side).traverse((mesh) => {
      if (!mesh.isMesh) return;
      const a = mesh.geometry.attributes.position,
        idx = mesh.geometry.index;
      const count = idx ? idx.count : a.count;
      const tri = new Triangle(),
        closest = new Vector3();
      for (let i = 0; i < count; i += 3) {
        for (const [j, p] of [tri.a, tri.b, tri.c].entries())
          p.fromBufferAttribute(a, idx ? idx.getX(i + j) : i + j).applyMatrix4(
            mesh.matrixWorld,
          );
        tri.closestPointToPoint(trigger, closest);
        distance = Math.min(distance, closest.distanceTo(trigger));
      }
    });
    assert.ok(distance < 0.015, `index surface is ${distance} m from trigger`);
    for (const f of rig.fingers) {
      const delta = f.rest.clone().invert().multiply(f.q).normalize();
      const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
      assert.ok(
        angle < Math.PI / 3,
        `${f.r.name} exceeds 60-degree calibrated motion range`,
      );
    }
  }
});

test("left ready rests beside its shoulder and blends continuously into aim", async () => {
  const { rig, upper } = await loadRig();
  rig.update(0, "ready", "L");
  const chain = upper.chains[0];
  const shoulder = pos(chain.nodes[1]),
    hand = pos(chain.nodes[3]);
  assert.ok(
    hand.x >= shoulder.x - 0.03 && hand.x < shoulder.x + 0.2,
    "rest must stay beside the shoulder, not cross the torso",
  );
  assert.ok(
    shoulder.y - hand.y > 0.3,
    "rest must lower the hand alongside the hip",
  );
  let previous = hand;
  for (let step = 1; step <= 100; step++) {
    rig.update(0, "aim", "L", { aimWeight: step / 100 });
    const current = pos(chain.nodes[3]);
    assert.ok(current.distanceTo(previous) < 0.02, "aim blend must not jump");
    previous = current;
  }
});

test("shared single-wield aim opens elbows and keeps both barrel axes forward", async () => {
  const { rig, weapon, upper } = await loadRig();
  const xs = [];
  for (const side of ["R", "L"]) {
    const result = rig.update(0, "aim", side);
    xs.push(weapon.position.x);
    const chain = upper.chains[side === "R" ? 1 : 0];
    assert.ok(
      Math.abs(pos(chain.nodes[2]).x) > Math.abs(pos(chain.nodes[1]).x) + 0.02,
      "shared elbows stay outside the shoulder line",
    );
    const forward = new Vector3(0, 0, 1).applyQuaternion(weapon.quaternion);
    assert.ok(Math.abs(forward.x) < 1e-6, "barrels must not splay outward");
    assert.ok(forward.z > 0.99);
    assert.ok(result.gripError < 1e-5);
    const wrist = upper.chains[side === "R" ? 1 : 0].nodes[3].quaternion;
    const bind =
      side === "R"
        ? rig.neutralWrist
        : new Quaternion(
            rig.neutralWrist.x,
            -rig.neutralWrist.y,
            -rig.neutralWrist.z,
            rig.neutralWrist.w,
          );
    assert.ok(
      wrist.angleTo(bind) < 0.85,
      "combined wrist roll remains bounded",
    );
  }
  assert.ok(xs[1] - xs[0] > 0.16, "pistols must have lateral clearance");
});
