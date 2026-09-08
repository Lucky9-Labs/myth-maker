import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assembleEncounterInputs, planEncounterWork } from "../src/workgraph-planner.js";
import { EncounterDispatcher, InMemoryReceiptStore, JsonReceiptStore } from "../src/encounter-dispatcher.js";
import { LocalWorkerBackend } from "../src/local-worker-backend.js";
import { createRailwayDispatchHandler } from "../src/railway-dispatcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const hostCapabilities = {
  schema_version: "1",
  host_id: "demo-host",
  host_build: "2026.09.08",
  platform: "linux",
  scripting_backend: "il2cpp",
  execution_kinds: ["recipe"],
  loaders: ["recipe-loader"],
  contracts: ["encounter-module.v1"],
  limits: { memory_mb: 2048, preload_seconds: 30 },
};

const fixture = {
  schema_version: "2",
  encounter_id: "tideglass-reef",
  seed: 17,
  deadline_at: "2026-09-09T12:00:00Z",
  host_capabilities: hostCapabilities,
  objective: { kind: "survive", parameters: { seconds: 90 } },
  arena_envelope: {
    bounds: { width: 30, height: 12, depth: 30 },
    navigation_profiles: ["ground"],
  },
  desired_roles: ["pressure", "support"],
  production_gate: conceptProductionGate(),
};

function conceptProductionGate() {
  const intent = {
    intent_id: "reef-survival-intent",
    revision: 1,
    content_sha256: "a".repeat(64),
    player_facing_beat: "Survive the reef pressure without losing the escape route.",
    constraints: ["Keep the route to extraction readable."],
  };
  const direction = {
    art_direction_id: "reef-survival-direction",
    revision: 2,
    content_sha256: "b".repeat(64),
    encounter_intent: refOf(intent, "intent_id"),
    player_facing_beat: "The threat reads before its first committed action.",
    silhouette: "A broad profile with a readable forward gesture.",
    scale: "Readable across the declared arena envelope.",
    palette_material_cues: "Matte surfaces with one high contrast response cue.",
    arena_relationship: "Frames the encounter without blocking extraction.",
    animation_combat_beats: ["Telegraph the committed action before impact."],
    constraints: ["Do not obscure the extraction marker."],
  };
  const concept = {
    concept_reference_id: "reef-survival-concept",
    revision: 3,
    content_sha256: "c".repeat(64),
    mode: "generated",
    art_direction_revision: refOf(direction, "art_direction_id"),
    artifact: { uri: "https://assets.example.test/reef-concept.png", sha256: "d".repeat(64), media_type: "image/png" },
    interpretation_constraints: ["Keep the forward gesture visible from the extraction route."],
  };
  return {
    kind: "concept_lineage",
    encounter_intent: intent,
    art_direction_revision: direction,
    concept_reference_revision: concept,
    lineage: {
      kind: "concept_lineage",
      encounter_intent: refOf(intent, "intent_id"),
      art_direction_revision: refOf(direction, "art_direction_id"),
      concept_reference_revision: refOf(concept, "concept_reference_id"),
    },
  };
}

function refOf(record, idField) {
  return { id: record[idField], revision: record.revision, content_sha256: record.content_sha256 };
}

test("planner deterministically produces a generic parameterized component graph", () => {
  const first = planEncounterWork(fixture);
  const second = planEncounterWork(structuredClone(fixture));

  assert.deepEqual(second, first);
  assert.ok(first.component_graph.components.some((component) => component.kind === "central-body"));
  assert.equal(first.component_graph.components.filter((component) => component.kind === "body-segment").length, fixture.desired_roles.length * 2);
  assert.equal(first.component_graph.components.filter((component) => component.kind === "critical-spot").length, fixture.desired_roles.length);
  assert.equal(first.component_graph.components.filter((component) => component.kind === "motion-clip").length, fixture.desired_roles.length);
  assert.ok(first.component_graph.components.some((component) => component.kind === "material-binding"));
  assert.ok(first.component_graph.components.some((component) => component.kind === "arena-envelope"));
  assert.ok(first.component_graph.components.some((component) => component.kind === "combat-recipe"));
  assert.ok(first.component_graph.components.every((component) => component.component_revision.content_sha256.length === 64));
  assert.ok(first.component_graph.components.every((component) => Object.isFrozen(component.component_revision)));
  assert.ok(first.component_graph.components.filter((component) => component.kind === "central-body").every((component) => component.attachment_contract.provides.length >= fixture.desired_roles.length * 3));
  const roots = first.work_orders.filter((order) => !["assembly", "validation"].includes(order.lane));
  assert.ok(roots.every((order) => order.depends_on_work_ids.length === 0));
  const assembly = first.work_orders.find((order) => order.lane === "assembly");
  const validation = first.work_orders.find((order) => order.lane === "validation");
  assert.deepEqual(assembly.depends_on_work_ids, roots.map((order) => order.work_id));
  assert.deepEqual(validation.depends_on_work_ids, [assembly.work_id]);
  assert.ok(first.work_orders.every((order) => order.schema_version === "2"));
  assert.ok(first.work_orders.every((order) => order.production_gate.kind === "concept_lineage"));
  assert.deepEqual(first.work_orders[0].production_gate, fixture.production_gate);
  const revised = structuredClone(fixture);
  revised.objective.parameters.seconds = 120;
  assert.notDeepEqual(planEncounterWork(revised).work_orders.map((order) => order.work_id),
                      first.work_orders.map((order) => order.work_id));
});

test("assembly inputs retain a valid baseline when a horizontal lane is missing", () => {
  const graph = planEncounterWork(fixture);
  const roots = graph.work_orders.filter((order) => !["assembly", "validation"].includes(order.lane));
  const completedExcept = (missingLane) => roots
    .filter((order) => order.lane !== missingLane)
    .map((order) => ({ work_id: order.work_id, status: "completed" }));

  const withoutMaterial = assembleEncounterInputs(graph, completedExcept("material-binding"));
  const withoutArena = assembleEncounterInputs(graph, completedExcept("arena-envelope"));
  assert.equal(withoutMaterial.planning_valid, true);
  assert.equal(withoutArena.planning_valid, true);
  assert.equal(withoutMaterial.baseline_id, withoutArena.baseline_id);
  assert.ok(withoutMaterial.selections.some((selection) => selection.lane === "material-binding" && selection.source === "fallback"));
  assert.ok(withoutArena.selections.some((selection) => selection.lane === "arena-envelope" && selection.source === "fallback"));
});

test("dispatcher reaches validation after a failed horizontal lane so assembly can select its fallback", async () => {
  const graph = planEncounterWork(fixture);
  const dispatcher = new EncounterDispatcher({
    backend: {
      async launch(order) {
        if (order.lane === "material-binding") throw new Error("simulated absent material lane");
        const worker_id = `test-${order.work_id.slice(3)}`;
        return { worker_id, events: [
          { schema_version: "1", event_id: `evt-${order.work_id.slice(3)}-accepted`, work_id: order.work_id, encounter_id: order.encounter_id, worker_id, sequence: 0, occurred_at: "2026-09-08T20:00:00.000Z", kind: "accepted" },
          { schema_version: "1", event_id: `evt-${order.work_id.slice(3)}-started`, work_id: order.work_id, encounter_id: order.encounter_id, worker_id, sequence: 1, occurred_at: "2026-09-08T20:00:00.001Z", kind: "started" },
          { schema_version: "1", event_id: `evt-${order.work_id.slice(3)}-completed`, work_id: order.work_id, encounter_id: order.encounter_id, worker_id, sequence: 2, occurred_at: "2026-09-08T20:00:00.002Z", kind: "completed" },
        ] };
      },
    },
  });
  const result = await dispatcher.dispatch(graph);
  assert.equal(result.receipts.find((receipt) => receipt.work_id === graph.work_orders.find((order) => order.lane === "material-binding").work_id).status, "failed");
  assert.equal(result.receipts.at(-1).status, "completed");
  const inputs = assembleEncounterInputs(graph, result.receipts);
  assert.ok(inputs.selections.some((selection) => selection.lane === "material-binding" && selection.source === "fallback"));
});

test("assembly inputs are deterministic regardless of receipt delivery order", () => {
  const graph = planEncounterWork(fixture);
  const receipts = graph.work_orders
    .filter((order) => !["assembly", "validation"].includes(order.lane))
    .map((order) => ({ work_id: order.work_id, status: "completed" }));
  const first = assembleEncounterInputs(graph, receipts);
  const second = assembleEncounterInputs(graph, [...receipts].reverse());
  assert.deepEqual(second, first);
  assert.equal(first.planning_valid, true);
  assert.ok(first.selections.every((selection) => selection.source === "candidate"));
});

test("planner rejects tampered component revisions, sockets, and duplicate delivery receipts", () => {
  const graph = structuredClone(planEncounterWork(fixture));
  graph.component_graph.components[0].component_revision.content_sha256 = "f".repeat(64);
  assert.throws(() => assembleEncounterInputs(graph), /invalid component contract/);

  const socketTampered = structuredClone(planEncounterWork(fixture));
  socketTampered.component_graph.components.find((component) => component.kind === "motion-clip").attachment_contract.consumes[0].socket_id = "socket-missing";
  assert.throws(() => assembleEncounterInputs(socketTampered), /invalid component contract|socket consumers/);

  const planned = planEncounterWork(fixture);
  const workId = planned.work_orders[0].work_id;
  assert.throws(() => assembleEncounterInputs(planned, [{ work_id: workId, status: "completed" }, { work_id: workId, status: "failed" }]), /duplicate stable work IDs/);
});

test("dispatcher blocks missing, mismatched, and expired production lineage before backend launch", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  let launches = 0;
  const dispatcher = new EncounterDispatcher({ backend: { async launch() { launches += 1; } } });

  const missing = structuredClone(order);
  delete missing.production_gate;
  await assert.rejects(dispatcher.dispatchWorkOrder(missing), /production gate/);

  const mismatched = structuredClone(order);
  mismatched.production_gate.lineage.concept_reference_revision.content_sha256 = "e".repeat(64);
  await assert.rejects(dispatcher.dispatchWorkOrder(mismatched), /production gate/);

  const expired = structuredClone(order);
  expired.production_gate = {
    kind: "bootstrap_waiver",
    waiver: {
      kind: "bootstrap_waiver",
      bounded_reason: "Preserve only the pre-gate local proof while lineage adoption is pending.",
      approver: "local-demo-owner",
      approved_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-02T00:00:00Z",
      requested_provides: [...order.requested_provides],
      not_concept_compliant: true,
    },
  };
  await assert.rejects(dispatcher.dispatchWorkOrder(expired), /production gate/);

  const incoherent = structuredClone(expired);
  incoherent.production_gate.waiver.approved_at = "2100-01-01T00:00:00Z";
  incoherent.production_gate.waiver.expires_at = "2099-01-01T00:00:00Z";
  await assert.rejects(dispatcher.dispatchWorkOrder(incoherent), /production gate/);
  assert.equal(launches, 0);
});

test("dispatcher preserves accepted concept lineage and explicit bootstrap waivers in worker receipts", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const dispatcher = new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 1 }) });
  const conceptResult = await dispatcher.dispatchWorkOrder(order);
  assert.deepEqual(conceptResult.receipt.production_gate, order.production_gate);

  const waived = structuredClone(order);
  waived.work_id = "wg-bootstrap-waiver-proof";
  waived.production_gate = {
    kind: "bootstrap_waiver",
    waiver: {
      kind: "bootstrap_waiver",
      bounded_reason: "Preserve only the pre-gate local proof while lineage adoption is pending.",
      approver: "local-demo-owner",
      approved_at: "2026-09-08T00:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
      requested_provides: [...order.requested_provides],
      not_concept_compliant: true,
    },
  };
  const waivedResult = await dispatcher.dispatchWorkOrder(waived);
  assert.deepEqual(waivedResult.receipt.production_gate, waived.production_gate);
  assert.equal(waivedResult.receipt.production_gate.waiver.not_concept_compliant, true);

  const maintained = structuredClone(order);
  maintained.work_id = "wg-maintenance-waiver-proof";
  maintained.production_gate = {
    kind: "reuse_maintenance_waiver",
    requested_provides: [...order.requested_provides],
    waiver: {
      kind: "maintenance",
      bounded_reason: "Repair the named existing asset without changing its established role.",
      approver: "asset-owner",
      approved_at: "2026-09-08T00:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
      asset_ids: ["reef-source-asset"],
    },
  };
  const maintainedResult = await dispatcher.dispatchWorkOrder(maintained);
  assert.deepEqual(maintainedResult.receipt.production_gate, maintained.production_gate);
});

test("dispatcher launches independent lanes in concurrent local processes and deduplicates receipts", async () => {
  const graph = planEncounterWork(fixture);
  const dispatcher = new EncounterDispatcher({
    backend: new LocalWorkerBackend({ workDurationMs: 800 }),
  });

  const result = await dispatcher.dispatch(graph);
  const roots = graph.work_orders.filter((order) => !["assembly", "validation"].includes(order.lane));
  const eventsByWork = new Map(roots.map((order) => [
    order.work_id,
    result.events.filter((event) => event.work_id === order.work_id),
  ]));
  const started = [...eventsByWork.values()].map((events) => Date.parse(events.find((event) => event.kind === "started").occurred_at));
  const completed = [...eventsByWork.values()].map((events) => Date.parse(events.find((event) => event.kind === "completed").occurred_at));

  assert.equal(result.receipts.length, graph.work_orders.length);
  assert.ok(Math.max(...started) < Math.min(...completed), "root worker timestamps must overlap");
  for (const events of eventsByWork.values()) {
    assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2]);
  }

  const duplicate = await dispatcher.dispatch(graph);
  assert.equal(duplicate.deduplicated_work_ids.length, graph.work_orders.length);
  assert.equal(duplicate.events.length, 0);
  assert.deepEqual(duplicate.receipts.map((receipt) => receipt.work_id).sort(),
                   result.receipts.map((receipt) => receipt.work_id).sort());
});

test("runnable CLI prints a graph, ordered events, receipts, and overlap evidence", async () => {
  const child = spawn(process.execPath, [path.join(here, "..", "examples", "run-workgraph.mjs")], {
    cwd: path.join(here, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");

  assert.equal(code, 0, stderr);
  const proof = JSON.parse(stdout);
  assert.ok(proof.graph.work_orders.length > 10);
  assert.equal(proof.receipts.length, proof.graph.work_orders.length);
  assert.equal(proof.overlap.observed, true);
  assert.ok(proof.events.length >= 12);
});

test("Railway control-plane handler matches Cloudflare's stable x-work-id delivery and replays receipts", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const forwarded = [];
  const handler = createRailwayDispatchHandler({
    dispatcher: new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 20 }) }),
    dispatchToken: "dispatch",
    eventSink: { append: async (workId, event) => forwarded.push({ workId, event }) },
  });
  const request = () => new Request("https://railway.example/dispatch", {
    method: "POST", headers: { authorization: "Bearer dispatch", "content-type": "application/json", "x-work-id": order.work_id }, body: JSON.stringify(order),
  });

  const first = await handler(request());
  const replay = await handler(request());
  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal((await first.json()).events.length, 3);
  assert.equal((await replay.json()).events.length, 0);
  assert.deepEqual(forwarded.slice(0, 3).map(({ event }) => event.sequence), [0, 1, 2]);

  const mismatch = await handler(new Request("https://railway.example/dispatch", {
    method: "POST", headers: { authorization: "Bearer dispatch", "content-type": "application/json", "x-work-id": "wrong-work-id" }, body: JSON.stringify(order),
  }));
  assert.equal(mismatch.status, 409);

  const unauthorized = await handler(new Request("https://railway.example/dispatch", {
    method: "POST", headers: { "content-type": "application/json", "x-work-id": order.work_id }, body: JSON.stringify(order),
  }));
  assert.equal(unauthorized.status, 401);
});

test("dispatcher stores terminal failed receipts instead of relaunching stable work", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  let launches = 0;
  const dispatcher = new EncounterDispatcher({
    backend: { async launch(received) {
      launches += 1;
      return {
        worker_id: "test-worker",
        events: [
          { schema_version: "1", event_id: "evt-test-accepted", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 0, occurred_at: "2026-09-08T20:00:00.000Z", kind: "accepted" },
          { schema_version: "1", event_id: "evt-test-failed", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 1, occurred_at: "2026-09-08T20:00:00.001Z", kind: "failed", error_code: "test_failure", retryable: true },
        ],
      };
    } },
  });

  const first = await dispatcher.dispatchWorkOrder(order);
  const replay = await dispatcher.dispatchWorkOrder(order);
  assert.equal(first.receipt.status, "failed");
  assert.equal(replay.deduplicated, true);
  assert.equal(launches, 1);
});

test("dispatcher rejects malformed closed-v1 backend events before recording a receipt", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const dispatcher = new EncounterDispatcher({ backend: { async launch(received) {
    return { worker_id: "test-worker", events: [
      { schema_version: "1", event_id: "evt-bad-accepted", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 0, occurred_at: "not-a-time", kind: "accepted", unknown: true },
      { schema_version: "1", event_id: "evt-bad-completed", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 1, occurred_at: "2026-09-08T20:00:00Z", kind: "completed" },
    ] };
  } } });
  await assert.rejects(dispatcher.dispatchWorkOrder(order), /closed v1 WorkerEvent/);
  assert.equal((await dispatcher.lookup(order.work_id)).status, "invalid");
});

test("dispatcher rejects malformed partial events when a backend throws", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const dispatcher = new EncounterDispatcher({ backend: { async launch(received, { onEvent }) {
    onEvent({ schema_version: "1", event_id: "evt-bad-partial", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 0, occurred_at: "not-a-time", kind: "accepted", unknown: true });
    throw new Error("worker crashed");
  } } });
  await assert.rejects(dispatcher.dispatchWorkOrder(order), /closed v1 WorkerEvent/);
  const receipt = await dispatcher.lookup(order.work_id);
  assert.equal(receipt.status, "invalid");
  assert.deepEqual(receipt.outbox, []);
});

test("an atomic receipt claim prevents duplicate launches across dispatcher instances", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const store = new InMemoryReceiptStore();
  let launches = 0;
  const backend = { async launch(received) {
    launches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { worker_id: "test-worker", events: [
      { schema_version: "1", event_id: "evt-atomic-accepted", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 0, occurred_at: "2026-09-08T20:00:00.000Z", kind: "accepted" },
      { schema_version: "1", event_id: "evt-atomic-completed", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 1, occurred_at: "2026-09-08T20:00:00.001Z", kind: "completed" },
    ] };
  } };
  const [first, duplicate] = await Promise.all([
    new EncounterDispatcher({ backend, receiptStore: store }).dispatchWorkOrder(order),
    new EncounterDispatcher({ backend, receiptStore: store }).dispatchWorkOrder(order),
  ]);
  assert.equal(launches, 1);
  assert.equal(first.receipt.work_id, duplicate.receipt.work_id);
  assert.equal(first.deduplicated || duplicate.deduplicated, true);
});

test("restartable receipt outbox resumes only undelivered events after a callback failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "myth-maker-outbox-"));
  try {
    const order = planEncounterWork(fixture).work_orders[0];
    const first = new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 1 }), receiptStore: new JsonReceiptStore(path.join(directory, "receipts.json")) });
    const dispatched = await first.dispatchWorkOrder(order);
    const attempted = [];
    await assert.rejects(first.flush(order.work_id, { append: async (_id, event) => {
      attempted.push(event.sequence);
      if (event.sequence === 1) throw new Error("temporary callback outage");
    } }), /delivery failed/);
    assert.deepEqual(attempted, [0, 1]);

    const resumed = new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 1 }), receiptStore: new JsonReceiptStore(path.join(directory, "receipts.json")) });
    const delivered = [];
    await resumed.recoverDeliveries({ append: async (_id, event) => delivered.push(event.sequence) });
    assert.deepEqual(delivered, [1, 2]);
    assert.equal((await resumed.lookup(order.work_id)).status, "completed");
    assert.equal(dispatched.receipt.events.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
