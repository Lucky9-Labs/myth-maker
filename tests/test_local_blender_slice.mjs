import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BuildRoom } from "../src/build-room.js";
import { createBuildRoomServer } from "../src/build-room-server.js";
import { createSqliteCatalog } from "../src/catalog-sqlite.js";
import { LocalBlenderSliceBackend } from "../src/local-blender-slice-backend.js";

test("a Build Room preserves local Blender revision 1 and appends a generic curved revision 2 with exact provenance", { timeout: 180_000 }, async () => {
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
      body: JSON.stringify({ prompt: "Make one curved tapered tentacle as an inspectable demo body candidate.", generate_asset: true, idempotency_key: "real-blender-slice-001" }),
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
    const unityHandoff = finished.packages[0].unity_host_handoff;
    assert.equal(unityHandoff.load_deadline_ms, 8000);
    assert.equal(unityHandoff.assembly_receipt.source_evidence.build_room_assembly_receipt.receipt_sha256, finished.packages[0].assembly_receipt.receipt_sha256);
    assert.equal(unityHandoff.assembly_receipt.selected_assets[0].sha256, artifact.runtime_sha256);
    assert.equal(sha256(await readFile(unityHandoff.assembly_receipt.selected_assets[0].path)), artifact.runtime_sha256);
    assert.deepEqual(unityHandoff.assembly_receipt.selected_animations, []);
    assert.deepEqual(unityHandoff.evidence, { source: "local_blender_cli_observed", host_load: "not_observed", player_facing: "not_observed" });
    assert.equal(JSON.parse(await readFile(unityHandoff.manifest_path, "utf8")).handoff_sha256, unityHandoff.handoff_sha256);
    assert.equal(finished.topology.catalog.assets.count, 1);
    assert.equal(finished.topology.catalog.asset_revisions.count, 1);
    const receipt = blenderEvent.evidence.receipt;
    assert.equal(receipt.note, "Observed local Blender CLI evidence; not Modal, Unity-load, or player proof.");
    assert.equal(receipt.commands.length, 3);
    assert.ok(receipt.commands.every((command) => command.returncode === 0 && Array.isArray(command.argv)));
    assert.equal(sha256(await readFile(receipt.source.path)), artifact.source_sha256);
    assert.equal(sha256(await readFile(receipt.runtime.path)), artifact.runtime_sha256);
    assert.equal(sha256(await readFile(receipt.visual.path)), artifact.visual_sha256);
    const upgradeResponse = await fetch(`${base}/api/encounters/${run.ids.encounterId}/upgrades`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "real-blender-upgrade-002" }),
    });
    assert.equal(upgradeResponse.status, 202);
    const upgraded = await eventually(
      async () => (await fetch(`${base}/api/encounters/${run.ids.encounterId}`)).json(),
      (value) => value.packages.length === 2 && value.upgrade.active === false,
    );
    assert.equal(upgraded.artifacts.length, 2);
    const [firstArtifact, secondArtifact] = upgraded.artifacts;
    assert.equal(firstArtifact.artifact_id, secondArtifact.artifact_id);
    assert.deepEqual(upgraded.artifacts.map(({ revision }) => revision), [1, 2]);
    assert.notEqual(firstArtifact.source_sha256, secondArtifact.source_sha256);
    assert.notEqual(firstArtifact.runtime_sha256, secondArtifact.runtime_sha256);
    assert.notEqual(firstArtifact.visual_sha256, secondArtifact.visual_sha256);
    for (const current of upgraded.artifacts) {
      const image = await fetch(`${base}${current.thumbnail_url}`);
      assert.equal(image.headers.get("content-type"), "image/png");
      assert.ok((await image.arrayBuffer()).byteLength > 0);
    }
    assert.deepEqual(upgraded.packages.map(({ revision }) => revision), [1, 2]);
    const [firstPackage, secondPackage] = upgraded.packages;
    assert.equal(firstPackage.package_id, secondPackage.package_id);
    assert.equal(secondPackage.assembly_receipt.package_revision, 2);
    assert.equal(secondPackage.assembly_receipt.selected_modules[0].revision, 2);
    assert.equal(secondPackage.assembly_receipt.selected_modules[0].artifact_sha256, secondArtifact.runtime_sha256);
    assert.deepEqual(secondPackage.assembly_receipt.preserved_fallback_history, {
      package_revision: 1, package_manifest_sha256: firstPackage.manifest_sha256,
    });
    assert.match(secondPackage.assembly_receipt.receipt_sha256, /^[a-f0-9]{64}$/);
    const receiptWithoutHash = structuredClone(secondPackage.assembly_receipt);
    delete receiptWithoutHash.receipt_sha256;
    assert.equal(sha256(Buffer.from(JSON.stringify(receiptWithoutHash))), secondPackage.assembly_receipt.receipt_sha256);
    assert.equal(upgraded.topology.catalog.assets.count, 1);
    assert.equal(upgraded.topology.catalog.asset_revisions.count, 2);
    const catalogRevision1 = catalog.getAsset(firstArtifact.artifact_id, 1);
    const catalogRevision2 = catalog.getAsset(firstArtifact.artifact_id, 2);
    assert.equal(catalogRevision1.sourceReceipt.sha256, firstArtifact.source_sha256);
    assert.equal(catalogRevision1.runtimeArtifact.sha256, firstArtifact.runtime_sha256);
    assert.equal(catalogRevision1.visualArtifact.sha256, firstArtifact.visual_sha256);
    assert.equal(catalogRevision2.sourceReceipt.sha256, secondArtifact.source_sha256);
    assert.equal(catalogRevision2.runtimeArtifact.sha256, secondArtifact.runtime_sha256);
    assert.equal(catalogRevision2.visualArtifact.sha256, secondArtifact.visual_sha256);
    assert.deepEqual(catalogRevision2.provenance.parentRefs, [{
      domain: "asset", stableId: catalogRevision1.assetId, revision: 1, contentSha256: catalogRevision1.contentSha256,
    }]);
    const upgradedWorker = upgraded.events.find((event) => event.evidence.receipt?.source_inspection?.body_shape === "curved-tapered-appendages-v2");
    assert.ok(upgradedWorker, "revision 2 must carry a local Blender source inspection receipt");
    assert.equal(upgradedWorker.evidence.receipt.source_inspection.appendage_count, 1);
    assert.equal(upgradedWorker.evidence.receipt.source_inspection.straight_cone_count, 0);
    assert.ok(upgradedWorker.evidence.receipt.source_inspection.appendages.every((appendage) => appendage.type === "CURVE" && appendage.tapered));
    assert.equal(upgradedWorker.evidence.receipt.commands.length, 3);
    assert.ok(upgraded.events.some((event) => event.workerId === "local-coordinator" && event.kind === "completed" && event.message.includes("re-evaluated")));
    const replay = await fetch(`${base}/api/encounters`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Make one curved tapered tentacle as an inspectable demo body candidate.", generate_asset: true, idempotency_key: "real-blender-slice-001" }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).ids.requestId, run.ids.requestId);
    assert.equal((await (await fetch(`${base}/api/encounters/${run.ids.encounterId}`)).json()).artifacts.length, 2);
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
    assert.equal(finished.events.find((event) => event.kind === "failed")?.evidence.kind, "local_blender_cli_failed");
    assert.equal(finished.work_graph.find((work) => work.lane === "validation")?.status, "failed");
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

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
