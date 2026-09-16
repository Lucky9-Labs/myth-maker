import test from "node:test";
import assert from "node:assert/strict";
import { StructuralState, LIMBS } from "./structural-state.mjs";
test("armor breach is separate; weak exposed hits cannot sever; three powerful hits sever exactly once", () => {
  const s = new StructuralState();
  assert.equal(s.hit("arm.L", 1000).reason, "exposed");
  for (let i = 0; i < 100; i++) s.hit("arm.L", 24);
  assert.equal(s.parts["arm.L"].stress, 0);
  assert.equal(s.hit("arm.L", 30).detached, false);
  assert.equal(s.hit("arm.L", 30).detached, false);
  assert.equal(s.hit("arm.L", 30).detached, true);
  for (let i = 0; i < 100; i++) s.hit("arm.L", 100);
  assert.equal(s.events.length, 1);
});
test("all sides, minimum hit count, weapon loss, degraded mobility, deterministic reset", () => {
  for (const id of LIMBS) {
    const s = new StructuralState({ armor: 0 });
    s.hit(id, 10000);
    assert.equal(s.parts[id].lost, false);
    s.hit(id, 30);
    s.hit(id, 30);
    assert.equal(s.parts[id].lost, true);
    assert.equal(s.armed, id !== "arm.R");
    s.reset();
    assert.deepEqual(s, new StructuralState({ armor: 0 }));
  }
  const s = new StructuralState({ armor: 0 });
  for (const id of ["leg.L", "arm.L"])
    for (let i = 0; i < 3; i++) s.hit(id, 30);
  assert.equal(s.crawling, true);
  assert.equal(s.mobile, false);
  assert.equal(s.armed, true);
  for (let i = 0; i < 3; i++) s.hit("arm.R", 30);
  assert.equal(s.armed, false);
  assert.deepEqual(s.supportHands, []);
});
test("invalid inputs never poison the state", () => {
  const s = new StructuralState();
  for (const x of [NaN, Infinity, -1, 0]) s.hit("arm.L", x);
  assert.equal(s.parts["arm.L"].armor, 60);
  assert.throws(() => new StructuralState({ minimumImpact: NaN }));
});
