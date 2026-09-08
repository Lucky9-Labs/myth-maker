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
  assert.match(run.events[1].message, /Simulated fixture/);
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
  const adapter = new CoordinatorEventAdapter(room);

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

test("Blender evidence is absent until an observed screenshot or stream receipt arrives", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "No invented Blender window" });
  const adapter = new CoordinatorEventAdapter(room);

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
    assert.equal(projection.events.length, 1);
    assert.equal(projection.events[0].evidence.kind, "fixture");
  } finally {
    server.close();
  }
});

test("adapter accepts the coordinator worker-event shape without upgrading its evidence claim", () => {
  const room = new BuildRoom({ now: () => "2026-09-08T12:00:00.000Z", id: sequenceIds() });
  const run = room.submit({ prompt: "Coordinator contract" });
  new CoordinatorEventAdapter(room).ingest({
    schema_version: "1", event_id: "event-remote-1", work_id: "work-001", encounter_id: run.ids.encounterId,
    worker_id: run.ids.workerId, sequence: 2, occurred_at: "2026-09-08T12:02:00.000Z", kind: "candidate_produced",
    module: { module_id: "arena-shell", revision: 4, artifact: { uri: "https://example.test/arena.glb" } },
  });
  const snapshot = room.snapshot(run.ids.encounterId);
  assert.equal(snapshot.events.at(-1).evidence.kind, "adapter_reported");
  assert.deepEqual(snapshot.artifacts[0], {
    artifact_id: "arena-shell", revision: 4, artifact: { uri: "https://example.test/arena.glb" },
  });
});

function sequenceIds() {
  const values = ["encounter-001", "request-001", "worker-001"];
  return () => values.shift();
}
