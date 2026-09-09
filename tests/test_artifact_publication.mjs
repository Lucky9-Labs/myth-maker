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
