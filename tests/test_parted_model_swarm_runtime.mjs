import assert from "node:assert/strict";
import test from "node:test";
import { advancePartedSwarm, buildPartedDrawPlan, createPartedSwarmDefinition, initializePartedSwarm } from "../src/parted-model-swarm-runtime.js";

const clips = Object.fromEntries(["idle", "walk", "run", "attack", "death"].map((state) => [state, { duration_seconds: 1, part_track_count: 15, loop: ["idle", "walk", "run"].includes(state), root_motion: false }]));
const definition = createPartedSwarmDefinition({ model_id: "reef-skitter", part_count: 15, part_materials: Array.from({ length: 15 }, (_, index) => index), clips, lods: [{ max_distance: 20, update_hz: 30, cast_shadows: true }, { max_distance: 55, update_hz: 10, cast_shadows: false }, { max_distance: Infinity, update_hz: 0, cast_shadows: false }] });

test("stores only compact deterministic agent state and shares clips", () => {
  const swarm = initializePartedSwarm({ definition, agents: Array.from({ length: 400 }, (_, index) => ({ position: [index, 0, 0] })) });
  assert.equal(swarm.length, 400); assert.equal(swarm.byteLength, 400 * definition.instance_layout.bytes);
  assert.notEqual(swarm.getAgent(0).seed, swarm.getAgent(1).seed); assert.equal(definition.rendering.per_agent_animator, false);
  const priorPhase = swarm.getAgent(0).phase;
  const next = advancePartedSwarm({ definition, agents: swarm, delta_seconds: .1, commands: [{ index: 1, state: "attack" }] });
  assert.equal(next, swarm, "the hot update path mutates packed state instead of allocating a new swarm");
  assert.equal(next.getAgent(1).state, 3); assert.notEqual(next.getAgent(0).phase, priorPhase);
});

test("emits batches by LOD and part after culling", () => {
  const swarm = initializePartedSwarm({ definition, agents: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }, { position: [2, 0, 0] }] });
  const plan = buildPartedDrawPlan({ definition, agents: swarm, visible_indexes: [0, 2], camera_distance: (_, index) => index === 0 ? 10 : 80 });
  assert.equal(plan.visible_creatures, 2); assert.equal(plan.batches.length, 30); assert.equal(plan.batches[0].material, 0); assert.equal(plan.instance_bytes, 64);
});

test("attack starts at clip entry and returns to idle instead of looping", () => {
  const swarm = initializePartedSwarm({ definition, agents: [{ position: [0, 0, 0], seed: 1 }] });
  advancePartedSwarm({ definition, agents: swarm, delta_seconds: .25, commands: [{ index: 0, state: "attack" }] });
  assert.equal(swarm.getAgent(0).state, 3); assert.ok(swarm.getAgent(0).phase > .2 && swarm.getAgent(0).phase < .3);
  advancePartedSwarm({ definition, agents: swarm, delta_seconds: 1 });
  assert.equal(swarm.getAgent(0).state, 0); assert.equal(swarm.getAgent(0).phase, 0);
});

test("death starts at clip entry, freezes at its end, and is terminal", () => {
  const swarm = initializePartedSwarm({ definition, agents: [{ position: [0, 0, 0], seed: 2 }] });
  advancePartedSwarm({ definition, agents: swarm, delta_seconds: .4, commands: [{ index: 0, state: "death" }] });
  assert.equal(swarm.getAgent(0).state, 4); assert.ok(Math.abs(swarm.getAgent(0).phase - .4) < 1e-6);
  advancePartedSwarm({ definition, agents: swarm, delta_seconds: 2, commands: [{ index: 0, state: "run" }] });
  assert.equal(swarm.getAgent(0).state, 4); assert.equal(swarm.getAgent(0).phase, 1);
});
