import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";

import {
  BuildRoom,
  CoordinatorEventAdapter,
  evidenceLabel,
} from "../src/build-room.js";
import { createBuildRoomServer } from "../src/build-room-server.js";

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

test("projection orders events by sequence, then receipt time, while retaining replay after reconnect", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Observe ordering" });
  room.record(run.ids.encounterId, {
    sequence: 3,
    occurredAt: "2026-09-08T12:03:00.000Z",
    kind: "completed",
    message: "third",
    evidence: { kind: "fixture" },
  });
  room.record(run.ids.encounterId, {
    sequence: 2,
    occurredAt: "2026-09-08T12:02:00.000Z",
    kind: "progress",
    message: "second",
    evidence: { kind: "fixture" },
  });

  const snapshot = room.snapshot(run.ids.encounterId);
  assert.deepEqual(snapshot.events.slice(-2).map((event) => event.message), ["second", "third"]);
  const cursor = snapshot.events.at(-2).cursor;
  assert.deepEqual(room.replay(run.ids.encounterId, cursor).map((event) => event.message), ["third"]);
});

test("adapter requires observed remote receipts and preserves artifact and package revisions", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Need a verified package" });
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: () => true });

  assert.throws(() => adapter.ingest({
    encounter_id: run.ids.encounterId,
    worker_id: run.ids.workerId,
    sequence: 9,
    kind: "candidate_produced",
    source: "modal_remote",
  }), /receipt/);

  adapter.ingest({
    encounter_id: run.ids.encounterId,
    worker_id: run.ids.workerId,
    sequence: 9,
    kind: "candidate_produced",
    source: "modal_remote",
    receipt: { request_id: "modal-request-77", observed_at: "2026-09-08T12:02:00.000Z" },
    artifact: { artifact_id: "basilisk-mesh", revision: 2 },
    package: { package_id: "basilisk-package", revision: 3 },
  });

  const snapshot = room.snapshot(run.ids.encounterId);
  assert.equal(snapshot.artifacts[0].revision, 2);
  assert.equal(snapshot.packages[0].revision, 3);
  assert.equal(snapshot.events.at(-1).evidence.kind, "modal_remote");
  assert.equal(evidenceLabel(snapshot.events.at(-1).evidence), "Modal remote receipt (observed)");
});

test("receipt-shaped input remains unverified until a trusted local observer accepts it", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Reject forged evidence" });
  const input = {
    encounter_id: run.ids.encounterId, worker_id: run.ids.workerId, sequence: 7, kind: "progress", source: "modal_remote",
    receipt: { request_id: "not-proof", observed_at: "2026-09-08T12:02:00.000Z" },
  };
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
  assert.throws(() => adapter.ingest({
    encounter_id: run.ids.encounterId, worker_id: run.ids.workerId, sequence: 4, kind: "progress", source: "blender_window",
  }), /screenshot_path or stream_url/);
  adapter.ingest({
    encounter_id: run.ids.encounterId,
    worker_id: run.ids.workerId,
    sequence: 4,
    kind: "progress",
    source: "blender_window",
    receipt: { screenshot_path: "/tmp/observed-blender.png", observed_at: "2026-09-08T12:04:00.000Z" },
  });
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

test("the live builds index and request-keyed detail are projections, not a fixture list", async () => {
  const server = createBuildRoomServer({ room: new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() }) });
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
    assert.deepEqual(detail.topology.catalog.package_revisions, { count: 0, evidence: "reported" });
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
  new CoordinatorEventAdapter(room).ingest({
    schema_version: "1", event_id: "event-remote-1", work_id: "work-001", lane: "arena.shell", depends_on_work_ids: ["work-000"], encounter_id: run.ids.encounterId,
    worker_id: run.ids.workerId, sequence: 2, occurred_at: "2026-09-08T12:02:00.000Z", kind: "candidate_produced",
    module: { module_id: "arena-shell", revision: 4, artifact: { uri: "https://example.test/arena.glb" } },
  });
  const snapshot = room.snapshot(run.ids.encounterId);
  assert.equal(snapshot.events.at(-1).evidence.kind, "adapter_reported");
  assert.deepEqual(snapshot.artifacts[0], {
    artifact_id: "arena-shell", revision: 4, artifact: { uri: "https://example.test/arena.glb" },
  });
  assert.deepEqual(snapshot.topology.work_graph, [{
    work_id: "work-001", lane: "arena.shell", depends_on_work_ids: ["work-000"], worker_id: run.ids.workerId,
    status: "running", started_at: "2026-09-08T12:02:00.000Z", updated_at: "2026-09-08T12:02:00.000Z", evidence_kind: "adapter_reported",
  }]);
  const restored = new BuildRoom().restore(room.exportState());
  assert.equal(restored.snapshot(run.ids.encounterId).topology.work_graph[0].work_id, "work-001");
});

test("malformed adapter work metadata is rejected before it can poison the projection", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Closed work metadata" });
  assert.throws(() => new CoordinatorEventAdapter(room).ingest({ encounter_id: run.ids.encounterId, work_id: {}, lane: "valid.lane", depends_on_work_ids: ["not-an-id!"], worker_id: run.ids.workerId, sequence: 2, kind: "progress" }), /invalid v1 work graph metadata/);
  assert.deepEqual(room.snapshot(run.ids.encounterId).topology.work_graph, []);
});

function sequenceIds() {
  const values = ["encounter-001", "request-001", "worker-001"];
  let extra = 0;
  return () => values.shift() || `generated-${++extra}`;
}

async function eventually(read, predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for local live path");
}
