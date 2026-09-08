import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BuildRoom } from "../src/build-room.js";
import { createBuildRoomServer } from "../src/build-room-server.js";
import { createSqliteCatalog } from "../src/catalog-sqlite.js";
import { LocalBlenderSliceBackend } from "../src/local-blender-slice-backend.js";

test("a Build Room API request observes a real local Blender source, GLB, thumbnail, catalog revision, and package", { timeout: 120_000 }, async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "myth-maker-build-room-"));
  const catalog = createSqliteCatalog();
  const backend = new LocalBlenderSliceBackend({ outputDir: artifactRoot });
  const server = createBuildRoomServer({ room: new BuildRoom(), catalog, artifactRoot, blenderBackend: backend });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/encounters`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Generate an inspectable demo body candidate.", generate_asset: true }),
    });
    assert.equal(created.status, 201);
    const run = await created.json();
    const finished = await eventually(
      async () => (await fetch(`${base}/api/encounters/${run.ids.encounterId}`)).json(),
      (value) => value.packages.length === 1,
    );
    const blenderEvent = finished.events.find((event) => event.evidence.kind === "local_blender_cli" && event.kind === "candidate_produced");
    assert.ok(blenderEvent, "the generated candidate must carry local Blender CLI evidence");
    const artifact = finished.artifacts.at(0);
    assert.equal(artifact.origin, "newly-produced-local-blender");
    assert.match(artifact.source_sha256, /^[a-f0-9]{64}$/);
    assert.match(artifact.runtime_sha256, /^[a-f0-9]{64}$/);
    const thumbnail = await fetch(`${base}${artifact.thumbnail_url}`);
    assert.equal(thumbnail.headers.get("content-type"), "image/png");
    assert.ok((await thumbnail.arrayBuffer()).byteLength > 0);
    assert.equal(finished.packages[0].selection.length, 1);
    assert.notEqual(finished.packages[0].selection[0], `baseline-${run.ids.encounterId.slice(-24)}`);
    assert.match(finished.packages[0].manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(finished.packages[0].assembly_receipt.package_manifest_sha256, finished.packages[0].manifest_sha256);
    assert.equal(finished.packages[0].assembly_receipt.selected_modules[0].artifact_sha256, artifact.runtime_sha256);
    assert.equal(finished.packages[0].assembly_receipt.validation[0].kind, "glb.v1-checked");
    assert.equal(finished.packages[0].assembly_receipt.host_acceptance, "not_observed");
    assert.match(finished.packages[0].assembly_receipt.receipt_sha256, /^[a-f0-9]{64}$/);
    assert.equal(finished.topology.catalog.assets.count, 1);
    assert.equal(finished.topology.catalog.asset_revisions.count, 1);
    const receipt = blenderEvent.evidence.receipt;
    assert.equal(receipt.note, "Observed local Blender CLI evidence; not Modal, Unity-load, or player proof.");
    assert.equal(receipt.commands.length, 2);
    assert.ok(receipt.commands.every((command) => command.returncode === 0 && Array.isArray(command.argv)));
  } finally {
    server.close();
    catalog.close();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a failed local Blender worker leaves an observed failure and assembles the declared baseline fallback", async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "myth-maker-build-room-fallback-"));
  const catalog = createSqliteCatalog();
  const backend = {
    resultFor() { return undefined; },
    async launch(order, { onEvent }) {
      const worker_id = "blender-cli-fallback";
      const events = [
        workerEvent(order, worker_id, 0, "accepted"),
        workerEvent(order, worker_id, 1, "started"),
        workerEvent(order, worker_id, 2, "failed", { error_code: "local.blender.cli.failed", retryable: true, message: "Blender executable became unavailable." }),
      ];
      events.forEach(onEvent);
      return { worker_id, events };
    },
  };
  const server = createBuildRoomServer({ room: new BuildRoom(), catalog, artifactRoot, blenderBackend: backend });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${base}/api/encounters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Fallback proof", generate_asset: true }) })).json();
    const finished = await eventually(
      async () => (await fetch(`${base}/api/encounters/${run.ids.encounterId}`)).json(),
      (value) => value.packages.length === 1,
    );
    assert.equal(finished.artifacts.length, 0);
    assert.equal(finished.packages[0].selection[0], `baseline-${run.ids.encounterId.slice(-24)}`);
    assert.equal(finished.events.find((event) => event.kind === "failed")?.evidence.kind, "local_blender_cli");
  } finally {
    server.close();
    catalog.close();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

async function eventually(read, predicate) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for local Blender slice");
}

function workerEvent(order, worker_id, sequence, kind, details = {}) {
  return {
    schema_version: "1", event_id: `event-${order.work_id.slice(-16)}-${sequence}`, work_id: order.work_id,
    encounter_id: order.encounter_id, worker_id, sequence, occurred_at: "2026-09-08T12:00:00.000Z", kind, ...details,
  };
}
