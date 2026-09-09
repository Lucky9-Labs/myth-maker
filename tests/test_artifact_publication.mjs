import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRailwayArtifactHandler, createRailwayArtifactStore } from "../src/railway-artifact-store.js";
import { verifyPublishedArtifact } from "../scripts/verify-published-artifact.mjs";
import { verifySignedDiscoveryManifest } from "../scripts/verify-signed-discovery-manifest.mjs";
import { assembleEncounterPackage } from "../src/encounter-package-assembler.js";
import { canonicalSha256 } from "../src/package-discovery.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "glb_importer_assembler_fixture.py");

function emitCandidate() {
  const result = spawnSync("python3", [fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("an accepted generic GLB candidate is published once to the mounted volume and independently downloadable with its exact identity", async () => {
  const candidate = emitCandidate();
  const root = await mkdtemp(path.join(tmpdir(), "myth-maker-artifact-"));
  const handler = createRailwayArtifactHandler({
    store: createRailwayArtifactStore({ rootPath: root, publicOrigin: "https://artifacts.example.test", clock: () => "2026-09-08T21:00:00.000Z" }),
    publicationToken: "publication-token",
  });
  const publication = {
    schema_version: "1",
    publication_id: "artifact-publication-0001",
    idempotency_key: "artifact-publish-0001",
    accepted_candidate: { module: candidate.module, loader_profile: candidate.profile },
    artifact_bytes_base64: candidate.glb_bytes_base64,
  };

  try {
    const request = () => new Request("https://artifacts.example.test/v1/artifact-publications", {
      method: "POST", body: JSON.stringify(publication), headers: { authorization: "Bearer publication-token", "content-type": "application/json" },
    });
    const published = await handler(request());
    assert.equal(published.status, 201);
    const receipt = await published.json();
    assert.equal(receipt.artifact.uri, `https://artifacts.example.test/v1/artifacts/${candidate.profile.artifact.sha256}`);
    assert.equal(receipt.artifact.sha256, candidate.profile.artifact.sha256);
    assert.equal(receipt.artifact.byte_length, candidate.profile.artifact.byte_length);
    assert.match(receipt.publication_sha256, /^[a-f0-9]{64}$/);

    const downloaded = await handler(new Request(receipt.artifact.uri));
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "model/gltf-binary");
    assert.equal(Number(downloaded.headers.get("content-length")), receipt.artifact.byte_length);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.artifact.sha256);
    const verification = await verifyPublishedArtifact({
      url: receipt.artifact.uri,
      sha256: receipt.artifact.sha256,
      byteLength: receipt.artifact.byte_length,
      fetcher: (url) => handler(new Request(url)),
    });
    assert.equal(verification.verification, "independent_https_download");

    const replay = await handler(request());
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("package receipts are immutable canonical records on the same mounted volume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myth-maker-artifact-"));
  const handler = createRailwayArtifactHandler({ store: createRailwayArtifactStore({ rootPath: root, publicOrigin: "https://artifacts.example.test" }), publicationToken: "publication-token" });
  const unsigned = { schema_version: "1", package_id: "package-receipt-0001", encounter_id: "receipt-encounter", revision: 1, state: "frozen" };
  const canonical = JSON.stringify(unsigned, Object.keys(unsigned).sort());
  const receipt = { ...unsigned, manifest_sha256: createHash("sha256").update(canonical).digest("hex") };
  try {
    const request = () => new Request("https://artifacts.example.test/v1/artifact-receipts/package", { method: "POST", headers: { authorization: "Bearer publication-token", "content-type": "application/json" }, body: JSON.stringify(receipt) });
    assert.equal((await handler(request())).status, 201);
    assert.equal((await handler(request())).status, 200);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an accepted assembled bundle persists linked receipts before canonical discovery", async () => {
  const candidate = emitCandidate();
  const root = await mkdtemp(path.join(tmpdir(), "myth-maker-artifact-"));
  const origin = "https://artifacts.example.test";
  const publicArtifact = { uri: `${origin}/v1/artifacts/${candidate.profile.artifact.sha256}`, sha256: candidate.profile.artifact.sha256, media_type: "model/gltf-binary", byte_length: candidate.profile.artifact.byte_length };
  const catalogUnsigned = {
    schema_version: "1", catalog_revision_id: "catalog-bundle-0001", encounter_id: "bundle-encounter", revision: 1, state: "accepted", created_at: "2026-09-08T21:00:00.000Z",
    acceptance: { decision_id: "catalog-decision-0001", policy_id: "runtime-catalog-acceptance.v1", accepted_at: "2026-09-08T21:00:00.000Z" },
    modules: [{ module_id: candidate.module.module_id, revision: candidate.module.revision, artifact: publicArtifact, compatibility: { platforms: [candidate.host.platform], scripting_backends: [candidate.host.scripting_backend], execution_kinds: ["runtime_asset"], loaders: candidate.host.loaders, contracts: candidate.host.contracts, limits: { artifact_bytes: candidate.host.limits.artifact_bytes } } }],
  };
  const catalog = { ...catalogUnsigned, catalog_sha256: await canonicalSha256(catalogUnsigned) };
  const packageRecord = assembleEncounterPackage({ host: candidate.host, encounterId: "bundle-encounter", packageId: "bundle-package", baselineModules: [candidate.module], candidateModules: [], assembledAt: "2026-09-08T21:00:00.000Z" }).package;
  const assemblyUnsigned = {
    schema_version: "1", profile: "glb.assembly.v1", assembly_id: "assembly-bundle-0001", revision: 1, assembled_at: "2026-09-08T21:00:00.000Z",
    coordinate_convention: { handedness: "right", up_axis: "y", unit: "meter", transforms: "parent-relative" },
    runtime_target: { loader: candidate.profile.loader, target: candidate.profile.target }, root_slot_id: "root",
    fragments: [{ slot_id: "root", fragment_id: candidate.module.module_id, revision: 1, selected_as: "primary", runtime_artifact: candidate.profile.artifact, runtime_linkage_sha256: "c".repeat(64), material_slots: [], markers: [], motion_binding: { kind: "procedural" }, provenance: { producer: "accepted-worker" } }],
    attachments: [], missing_slots: [], fallback_provenance: { used_fallback: false, slot_ids: [] }, rejection_reasons: [],
  };
  const assemblyManifest = { ...assemblyUnsigned, manifest_sha256: await canonicalSha256(assemblyUnsigned) };
  const receiptUnsigned = {
    schema_version: "1", receipt_id: "assembly-receipt-bundle-0001", encounter_id: "bundle-encounter", package_id: packageRecord.package_id, package_revision: packageRecord.revision, package_manifest_sha256: packageRecord.manifest_sha256,
    catalog_revision_id: catalog.catalog_revision_id, catalog_revision_sha256: catalog.catalog_sha256, assembled_at: "2026-09-08T21:00:00.000Z",
    acceptance: { decision_id: "assembly-decision-0001", policy_id: "runtime-assembly-acceptance.v1", accepted_at: "2026-09-08T21:00:00.000Z" }, selected_modules: [{ module_id: candidate.module.module_id, revision: 1, artifact: publicArtifact }], assembly_manifest: assemblyManifest,
  };
  const assemblyReceipt = { ...receiptUnsigned, receipt_sha256: await canonicalSha256(receiptUnsigned) };
  const discoveryRequest = { schema_version: "1", request_id: "bundle-discovery-0001", idempotency_key: "bundle-discovery-0001", host_capabilities: candidate.host };
  let received;
  const handler = createRailwayArtifactHandler({
    store: createRailwayArtifactStore({ rootPath: root, publicOrigin: origin, clock: () => "2026-09-08T21:00:00.000Z" }), publicationToken: "publication-token",
    coordinator: { async freezeAndDiscover(value) { received = value; return { schema_version: "1", status: "selected", manifest: { signature: "coordinator-owned" } }; } },
  });
  try {
    const result = await handler(new Request(`${origin}/v1/encounter-artifact-publications`, { method: "POST", headers: { authorization: "Bearer publication-token", "content-type": "application/json" }, body: JSON.stringify({
      schema_version: "1", publication: { schema_version: "1", publication_id: "artifact-publication-bundle-0001", idempotency_key: "artifact-publish-bundle-0001", accepted_candidate: { module: candidate.module, loader_profile: candidate.profile }, artifact_bytes_base64: candidate.glb_bytes_base64 },
      catalog_revision: catalog, package: packageRecord, assembly_receipt: assemblyReceipt, host_capabilities: candidate.host, discovery_request: discoveryRequest,
    }) }));
    assert.equal(result.status, 201);
    assert.equal(received.assembly_receipt.receipt_id, assemblyReceipt.receipt_id);
    assert.equal(received.catalog_revision.catalog_sha256, catalog.catalog_sha256);
    assert.equal(received.publication.artifact.uri, publicArtifact.uri);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication fails closed when bytes do not match the accepted candidate", async () => {
  const candidate = emitCandidate();
  const root = await mkdtemp(path.join(tmpdir(), "myth-maker-artifact-"));
  const handler = createRailwayArtifactHandler({ store: createRailwayArtifactStore({ rootPath: root, publicOrigin: "https://artifacts.example.test" }), publicationToken: "publication-token" });
  try {
  const result = await handler(new Request("https://artifacts.example.test/v1/artifact-publications", {
    method: "POST",
    body: JSON.stringify({
      schema_version: "1", publication_id: "artifact-publication-0002", idempotency_key: "artifact-publish-0002",
      accepted_candidate: { module: candidate.module, loader_profile: candidate.profile }, artifact_bytes_base64: Buffer.from("not a GLB").toString("base64"),
    }), headers: { authorization: "Bearer publication-token", "content-type": "application/json" },
  }));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error, "invalid_accepted_artifact_publication");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the public discovery verifier fixes the coordinator key identity and rejects a forged manifest", async () => {
  await assert.rejects(
    verifySignedDiscoveryManifest({ manifest_id: "forged-manifest", signature: { algorithm: "Ed25519", key_id: "package-discovery-ed25519-v1", value: "A".repeat(86) } }),
    /signature verification failed/,
  );
});
