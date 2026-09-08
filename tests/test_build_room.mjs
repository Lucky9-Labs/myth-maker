import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";

import {
  BuildRoom,
  CoordinatorEventAdapter,
  evidenceLabel,
} from "../src/build-room.js";
import { createBuildRoomServer } from "../src/build-room-server.js";
import { createSqliteCatalog } from "../src/catalog-sqlite.js";
import { createAssemblyReceipt, runDeterministicEncounter } from "../src/encounter-runner.js";
import { assembleEncounterPackage, freezeEncounterPackage } from "../src/encounter-package-assembler.js";

test("a local submission creates distinct inspectable IDs and an honest local receipt", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });

  const run = room.submit({ prompt: "A rain-soaked basilisk encounter" });

  assert.deepEqual(run.ids, {
    encounterId: "encounter-001",
    requestId: "request-001",
    workerId: "worker-001",
  });
  assert.equal(run.events[0].evidence.kind, "local_process");
  assert.equal(evidenceLabel(run.events[0].evidence), "Local process receipt (observed)");
  assert.equal(run.events.length, 1);
});

test("terminal build projections expose a simulation receipt only after it is observed, without inventing a visual", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:04:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Neutral chamber" });
  const receipt = neutralSimulationReceipt(run.ids.encounterId);
  assert.throws(() => room.recordSimulation(run.ids.encounterId, receipt), /observed receipt/);
  room.recordSimulation(run.ids.encounterId, receipt, { observed: true });
  const detail = room.snapshot(run.ids.encounterId);
  assert.equal(detail.simulation.status, "passed");
  assert.equal(detail.simulation.playable_or_recorded_output, null);
  assert.equal(detail.simulation.evidence_tiers.player, "not_observed");
});

test("the simulation ingress requires a trusted observer and streams only its observed terminal projection", async () => {
  const token = process.env.BUILD_ROOM_OBSERVER_TOKEN;
  process.env.BUILD_ROOM_OBSERVER_TOKEN = "test-simulation-token";
  const room = new BuildRoom({ now: () => "2026-09-08T12:04:00.000Z", id: sequenceIds() });
  const server = createBuildRoomServer({ room });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${base}/api/encounters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Observed simulation" }) })).json();
    const receipt = neutralSimulationReceipt(run.ids.encounterId);
    const rejected = await fetch(`${base}/api/ingest/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt) });
    assert.equal(rejected.status, 400);
    const accepted = await fetch(`${base}/api/ingest/simulation`, { method: "POST", headers: { "content-type": "application/json", "x-build-room-observer-token": "test-simulation-token" }, body: JSON.stringify(receipt) });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).playable_or_recorded_output, null);
  } finally {
    server.close();
    if (token === undefined) delete process.env.BUILD_ROOM_OBSERVER_TOKEN;
    else process.env.BUILD_ROOM_OBSERVER_TOKEN = token;
  }
});

test("projection orders cross-worker events by receipt time and stable cursor, while retaining replay after reconnect", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Observe ordering" });
  room.record(run.ids.encounterId, {
    workerId: "worker-a", sequence: 0,
    occurredAt: "2026-09-08T12:01:00.000Z",
    kind: "started",
    message: "a started",
    evidence: { kind: "fixture" },
  });
  room.record(run.ids.encounterId, {
    workerId: "worker-b", sequence: 0,
    occurredAt: "2026-09-08T12:01:00.000Z",
    kind: "started",
    message: "b started",
    evidence: { kind: "fixture" },
  });
  room.record(run.ids.encounterId, {
    workerId: "worker-a", sequence: 1,
    occurredAt: "2026-09-08T12:01:00.200Z",
    kind: "completed",
    message: "a completed",
    evidence: { kind: "fixture" },
  });
  room.record(run.ids.encounterId, {
    workerId: "worker-b", sequence: 1,
    occurredAt: "2026-09-08T12:01:00.300Z",
    kind: "completed",
    message: "b completed",
    evidence: { kind: "fixture" },
  });
  room.record(run.ids.encounterId, {
    workerId: "local-assembler", sequence: 0,
    occurredAt: "2026-09-08T12:01:00.400Z",
    kind: "completed",
    message: "assembler completed after workers",
    evidence: { kind: "fixture" },
  });

  const snapshot = room.snapshot(run.ids.encounterId);
  assert.deepEqual(snapshot.events.slice(1).map((event) => event.message), ["a started", "b started", "a completed", "b completed", "assembler completed after workers"]);
  const cursor = snapshot.events.at(-2).cursor;
  assert.deepEqual(room.replay(run.ids.encounterId, cursor).map((event) => event.message), ["assembler completed after workers"]);
});

test("adapter requires observed remote receipts and preserves artifact and package revisions", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Need a verified package" });
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: () => true });

  assert.throws(() => adapter.ingest(adapterEvent(run, {
    sequence: 9, source: "modal_remote",
  })), /receipt/);

  adapter.ingest(adapterEvent(run, {
    sequence: 9,
    source: "modal_remote",
    receipt: { request_id: "modal-request-77", observed_at: "2026-09-08T12:02:00.000Z" },
    artifact: { artifact_id: "basilisk-mesh", revision: 2 },
    package: { package_id: "basilisk-package", revision: 3 },
  }));

  const snapshot = room.snapshot(run.ids.encounterId);
  assert.equal(snapshot.artifacts[0].revision, 2);
  assert.equal(snapshot.packages[0].revision, 3);
  assert.equal(snapshot.events.at(-1).evidence.kind, "modal_remote");
  assert.equal(evidenceLabel(snapshot.events.at(-1).evidence), "Modal remote receipt (observed)");
});

test("receipt-shaped input remains unverified until a trusted local observer accepts it", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Reject forged evidence" });
  const input = adapterEvent(run, {
    sequence: 7, source: "modal_remote",
    receipt: { request_id: "not-proof", observed_at: "2026-09-08T12:02:00.000Z" },
  });
  assert.throws(() => new CoordinatorEventAdapter(room).ingest(input), /trusted local observer/);
  new CoordinatorEventAdapter(room, { trustedObservation: () => true }).ingest(input);
  assert.equal(room.snapshot(run.ids.encounterId).evidence.modal.length, 1);
});

test("projection state survives a local persistence round-trip for replay after a watch restart", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Persist replay" });
  const firstCursor = run.events[0].cursor;
  const restored = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z" }).restore(room.exportState());
  assert.deepEqual(restored.replay(run.ids.encounterId, firstCursor), []);
  assert.equal(restored.snapshot(run.ids.encounterId).topology.workers.length, 0);
});

test("Blender evidence is absent until an observed screenshot or stream receipt arrives", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "No invented Blender window" });
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: () => true });

  assert.deepEqual(room.snapshot(run.ids.encounterId).evidence.blender, []);
  assert.throws(() => adapter.ingest(adapterEvent(run, {
    sequence: 4, source: "blender_window",
  })), /screenshot_path or stream_url/);
  adapter.ingest(adapterEvent(run, {
    sequence: 4,
    source: "blender_window",
    receipt: { screenshot_path: "/tmp/observed-blender.png", observed_at: "2026-09-08T12:04:00.000Z" },
  }));
  assert.equal(room.snapshot(run.ids.encounterId).evidence.blender[0].screenshot_path, "/tmp/observed-blender.png");
});

test("the local HTTP submit path returns a replayable room projection", async () => {
  const server = createBuildRoomServer({ room: new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await fetch(`${base}/api/encounters`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "HTTP room" }),
    });
    const run = await created.json();
    assert.equal(created.status, 201);
    const replay = await fetch(`${base}/api/encounters/${run.ids.encounterId}?after=${encodeURIComponent(run.events[0].cursor)}`);
    const projection = await replay.json();
    assert.equal(projection.events.length, 0);
  } finally {
    server.close();
  }
});

test("HTTP submission executes the local planner-dispatcher path and projects terminal receipts plus a package", async () => {
  const server = createBuildRoomServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${base}/api/encounters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Real local path" }) })).json();
    const final = await eventually(async () => (await (await fetch(`${base}/api/encounters/${run.ids.encounterId}`)).json()), (value) => value.work_graph.length === 4 && value.packages.length === 1);
    assert.equal(final.work_graph.length, 4);
    assert.ok(final.work_graph.every((work) => work.status === "completed"));
    assert.equal(final.packages[0].revision, 1);
    assert.ok(final.events.some((event) => event.evidence.kind === "local_process" && event.workerId.startsWith("local-")));
  } finally {
    server.close();
  }
});

test("the live builds index and request-keyed detail project direct SQLite catalog counters", async () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();
  const server = createBuildRoomServer({ room: new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() }), catalog });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/encounters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Indexed build" }) });
    const run = await created.json();
    const index = await (await fetch(`${base}/api/builds`)).json();
    assert.equal(index.active.length, 1);
    assert.equal(index.active[0].request_id, run.ids.requestId);
    assert.equal(index.active[0].navigation_url, `/?build=${encodeURIComponent(run.ids.requestId)}`);
    const detail = await (await fetch(`${base}/api/builds/${run.ids.requestId}`)).json();
    assert.equal(detail.ids.encounterId, run.ids.encounterId);
    assert.deepEqual(detail.topology.catalog.semantic_entities, { count: 2, evidence: "local_sqlite_query" });
    assert.deepEqual(detail.topology.catalog.assets, { count: 1, evidence: "local_sqlite_query" });
    assert.deepEqual(detail.topology.catalog.asset_revisions, { count: 1, evidence: "local_sqlite_query" });
    assert.deepEqual(detail.topology.catalog.package_revisions, { count: 0, evidence: "local_projection" });
  } finally {
    server.close();
  }
});

test("steering stays queued or accepted until a successor response commits it", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Steer me" });
  const queued = room.steer(run.ids.requestId, { instruction: "prefer cover" });
  assert.equal(queued.status, "queued");
  assert.throws(() => room.recordSteering({ request_id: run.ids.requestId, steer_id: queued.steer_id, status: "accepted", response_id: "response-1" }), /trusted observer/);
  room.recordSteering({ request_id: run.ids.requestId, steer_id: queued.steer_id, status: "accepted", response_id: "response-1" }, { trusted: true });
  assert.equal(room.snapshot(run.ids.encounterId).steering[0].status, "accepted");
  assert.throws(() => room.recordSteering({ request_id: run.ids.requestId, steer_id: queued.steer_id, status: "committed" }, { trusted: true }), /successor response.created/);
  room.recordSteering({ request_id: run.ids.requestId, steer_id: queued.steer_id, status: "committed", successor_response: { created: true, response_id: "response-2" } }, { trusted: true });
  assert.equal(room.snapshot(run.ids.encounterId).steering[0].status, "committed");
});

test("the optional HTTP steer route queues a receipt without an approval state", async () => {
  const server = createBuildRoomServer({ room: new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${base}/api/encounters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "HTTP steer" }) })).json();
    const response = await fetch(`${base}/api/builds/${run.ids.requestId}/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "hold the arena" }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, "queued");
  } finally {
    server.close();
  }
});

test("both explicit SSE routes stream before generic detail routes and survive disconnects", async () => {
  const server = createBuildRoomServer({ room: new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${base}/api/encounters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "SSE routes" }) })).json();
    for (const path of ["/api/builds/stream", `/api/encounters/${run.ids.encounterId}/stream`]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const reader = response.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: projection/);
      await reader.cancel();
    }
    assert.equal((await fetch(`${base}/api/builds/${run.ids.requestId}`)).status, 200);
    assert.equal((await fetch(`${base}/api/encounters/${run.ids.encounterId}`)).status, 200);
  } finally {
    server.close();
  }
});

test("adapter accepts the coordinator worker-event shape without upgrading its evidence claim", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Coordinator contract" });
  new CoordinatorEventAdapter(room).ingest(adapterEvent(run, {
    event_id: "event-remote-1", work_id: "work-001", lane: "arena.shell", depends_on_work_ids: ["work-000"], sequence: 2,
    artifact: { artifact_id: "arena-shell", revision: 4, artifact: { uri: "https://example.test/arena.glb" } },
  }));
  const snapshot = room.snapshot(run.ids.encounterId);
  assert.equal(snapshot.events.at(-1).evidence.kind, "adapter_reported");
  assert.deepEqual(snapshot.artifacts[0], {
    artifact_id: "arena-shell", revision: 4, artifact: { uri: "https://example.test/arena.glb" },
  });
  assert.deepEqual(snapshot.topology.work_graph, [{
    work_id: "work-001", lane: "arena.shell", depends_on_work_ids: ["work-000"], worker_id: run.ids.workerId,
    status: "running", started_at: "2026-09-08T12:02:00.000Z", updated_at: "2026-09-08T12:02:00.000Z", evidence_kind: "adapter_reported", elapsed_seconds: 0,
  }]);
  const restored = new BuildRoom().restore(room.exportState());
  assert.equal(restored.snapshot(run.ids.encounterId).topology.work_graph[0].work_id, "work-001");
});

test("work elapsed time advances while active and freezes at terminal updated_at", () => {
  let now = "2026-09-08T12:00:10.000Z";
  const room = new BuildRoom({ now: () => now, id: sequenceIds() });
  const run = room.submit({ prompt: "Freeze terminal elapsed time" });
  const adapter = new CoordinatorEventAdapter(room);
  adapter.ingest(adapterEvent(run, { occurred_at: "2026-09-08T12:00:00.000Z", sequence: 1 }));
  assert.equal(room.snapshot(run.ids.encounterId).topology.work_graph[0].elapsed_seconds, 10);
  adapter.ingest(adapterEvent(run, { occurred_at: "2026-09-08T12:00:05.000Z", sequence: 2, kind: "completed" }));
  now = "2026-09-08T12:00:30.000Z";
  assert.equal(room.snapshot(run.ids.encounterId).topology.work_graph[0].elapsed_seconds, 5);
});

test("adapter ingress rejects malformed closed worker envelopes before projection state or health can change", async () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Reject malformed adapter events" });
  const server = createBuildRoomServer({ room });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = room.snapshot(run.ids.encounterId);
  try {
    for (const malformed of [
      adapterEvent(run, { occurred_at: {}, artifact: { artifact_id: "poisoned-timestamp", revision: 1 } }),
      adapterEvent(run, { unknown_field: true, artifact: { artifact_id: "poisoned-key", revision: 1 } }),
      adapterEvent(run, { kind: "unrecognised", artifact: { artifact_id: "poisoned-kind", revision: 1 } }),
    ]) {
      const response = await fetch(`${base}/api/ingest/coordinator`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(malformed) });
      assert.equal(response.status, 400);
    }
    const after = room.snapshot(run.ids.encounterId);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.artifacts, before.artifacts);
    assert.deepEqual(after.packages, before.packages);
    assert.deepEqual(after.topology.work_graph, before.topology.work_graph);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: "ok", encounters: 1 });
  } finally {
    server.close();
  }
});

test("malformed adapter work metadata is rejected before it can poison the projection", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Closed work metadata" });
  const before = room.snapshot(run.ids.encounterId);
  assert.throws(() => new CoordinatorEventAdapter(room).ingest(adapterEvent(run, { work_id: "work-002", lane: "valid.lane", depends_on_work_ids: ["not-an-id!"], sequence: 2, artifact: { artifact_id: "rejected-artifact", revision: 1 } })), /invalid v1 work graph metadata/);
  const after = room.snapshot(run.ids.encounterId);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.artifacts, before.artifacts);
  assert.deepEqual(after.packages, before.packages);
  assert.deepEqual(after.topology.work_graph, before.topology.work_graph);
});

function sequenceIds() {
  const values = ["encounter-001", "request-001", "worker-001"];
  let extra = 0;
  return () => values.shift() || `generated-${++extra}`;
}

function adapterEvent(run, overrides = {}) {
  return {
    schema_version: "1", event_id: "event-adapter-001", work_id: "work-adapter-001", lane: "adapter.lane", depends_on_work_ids: [],
    encounter_id: run.ids.encounterId, worker_id: run.ids.workerId, sequence: 1, occurred_at: "2026-09-08T12:02:00.000Z", kind: "progress",
    ...overrides,
  };
}

function neutralSimulationReceipt(encounterId) {
  const frozenPackage = frozenNeutralPackage(encounterId);
  const assembly = createAssemblyReceipt({
    assemblyId: "neutral-chamber-assembly", frozenPackage,
    selected: { assets: [{ asset_id: "neutral-target", revision: 3, sha256: "b".repeat(64), uri: "artifact://neutral-target.prefab" }], animations: [{ animation_id: "neutral-strike", revision: 2, sha256: "c".repeat(64), uri: "artifact://neutral-strike.anim" }] },
    assembledAt: "2026-09-08T12:02:00.000Z", provenance: { producer: "test", observed_at: "2026-09-08T12:02:00.000Z" },
  });
  return runDeterministicEncounter({
    assemblyReceipt: assembly,
    runtimeProfile: { schema_version: "1", profile_id: "unity-neutral-headless", profile_revision: 1, runner_id: "myth-maker-unity-encounter-runner", runtime_id: "unity-6000.6.0f1", build_profile_id: "editor-macos-mono-batch", evidence_tier: "local_unity_runner", execution_mode: "headless", unity: { editor_version: "6000.6.0f1", scripting_backend: "mono", platform: "macos" } },
    seed: 41, script: [{ at_ms: 100, actor: "player", target: "encounter-target", damage: 9 }, { at_ms: 250, actor: "encounter-target", target: "player", damage: 4 }],
    startedAt: "2026-09-08T12:03:00.000Z",
  });
}

function frozenNeutralPackage(encounterId) {
  const host = { schema_version: "1", host_id: "neutral-host", host_build: "fixture-1", platform: "macos", scripting_backend: "mono", execution_kinds: ["recipe"], loaders: [], contracts: [], limits: { memory_mb: 128, preload_seconds: 1 } };
  const module = { schema_version: "1", module_id: "neutral-combat-recipe", revision: 1, execution_kind: "recipe", provides: ["encounter.baseline"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "neutral-scripted-exchange" }, fallback_module_ids: [] };
  const ready = assembleEncounterPackage({ host, encounterId, packageId: "neutral-chamber-package", baselineModules: [module], assembledAt: "2026-09-08T12:00:00.000Z" }).package;
  return freezeEncounterPackage(ready, "2026-09-08T12:01:00.000Z");
}

async function eventually(read, predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for local live path");
}
