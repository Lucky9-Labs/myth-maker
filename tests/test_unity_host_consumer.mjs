import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { assembleEncounterPackage, freezeEncounterPackage } from "../src/encounter-package-assembler.js";
import { createAssemblyReceipt, createUnityHostHandoff, validateAssemblyReceipt, validateUnityHostHandoff, writeUnityHostHandoff } from "../src/unity-host-consumer.js";

test("a selected GLB resolves to matching bytes and remains bound to its frozen package through the eight-second Unity handoff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myth-maker-unity-handoff-"));
  try {
    const glbPath = path.join(root, "selected.glb");
    const glb = Buffer.from("glTF selected generated local Blender candidate");
    await writeFile(glbPath, glb);
    const sha256 = hash(glb);
    const frozenPackage = packageFor(sha256, glb.byteLength);
    const buildRoomReceipt = buildRoomReceiptFor(frozenPackage, sha256, 4);
    const assembly = await createAssemblyReceipt({
      assemblyId: "selected-glb-assembly",
      frozenPackage,
      selectedAssets: [{ asset_id: "selected-glb", revision: 4, uri: pathToFileURL(glbPath).href, path: glbPath, sha256, media_type: "model/gltf-binary", byte_length: glb.byteLength }],
      selectedAnimations: [],
      assembledAt: "2026-09-08T23:12:16.714Z",
      sourceEvidence: { kind: "local_blender_cli", scope: "local_blender_cli_only", observed_at: "2026-09-08T23:12:16.654Z", build_room_assembly_receipt: buildRoomReceipt },
    });
    assert.equal(assembly.package_manifest_sha256, frozenPackage.manifest_sha256);
    assert.equal(assembly.selected_assets[0].sha256, hash(await readFile(assembly.selected_assets[0].path)));
    assert.deepEqual(assembly.selected_animations, []);
    assert.equal(await validateAssemblyReceipt(assembly), true);
    const { asset_id: _assetId, ...animationArtifact } = assembly.selected_assets[0];
    const withAnimation = await createAssemblyReceipt({
      assemblyId: "selected-glb-animation-assembly", frozenPackage,
      selectedAssets: [assembly.selected_assets[0]],
      selectedAnimations: [{ ...animationArtifact, animation_id: "selected-glb-animation" }],
      assembledAt: "2026-09-08T23:12:16.714Z",
      sourceEvidence: assembly.source_evidence,
    });
    assert.equal(withAnimation.selected_animations[0].animation_id, "selected-glb-animation");

    const handoff = await createUnityHostHandoff({
      handoffId: "selected-glb-handoff", assemblyReceipt: assembly, loadDeadlineMs: 8000,
      conceptLineage: { kind: "not_recorded", reason: "pre_gate_bootstrap" },
    });
    assert.equal(handoff.load_deadline_ms, 8000);
    assert.deepEqual(handoff.evidence, { source: "local_blender_cli_observed", host_load: "not_observed", player_facing: "not_observed" });
    assert.equal(handoff.assembly_receipt.assembly_sha256, assembly.assembly_sha256);
    assert.equal(await validateUnityHostHandoff(handoff), true);
    const manifestPath = path.join(root, "unity-host-handoff.json");
    await writeUnityHostHandoff(manifestPath, handoff);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).handoff_sha256, handoff.handoff_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bridge fails closed for tampered bytes, URI/path mismatches, and fixture evidence relabeled as observed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myth-maker-unity-handoff-"));
  try {
    const glbPath = path.join(root, "selected.glb");
    const glb = Buffer.from("glTF selected generated local Blender candidate");
    await writeFile(glbPath, glb);
    const selection = { asset_id: "selected-glb", revision: 4, uri: pathToFileURL(glbPath).href, path: glbPath, sha256: hash(glb), media_type: "model/gltf-binary", byte_length: glb.byteLength };
    const frozenPackage = packageFor(selection.sha256, selection.byte_length);
    const input = { assemblyId: "selected-glb-assembly", frozenPackage, selectedAssets: [selection], assembledAt: "2026-09-08T23:12:16.714Z", sourceEvidence: { kind: "local_blender_cli", scope: "local_blender_cli_only", observed_at: "2026-09-08T23:12:16.654Z", build_room_assembly_receipt: buildRoomReceiptFor(frozenPackage, selection.sha256, 4) } };
    await assert.rejects(createAssemblyReceipt({ ...input, sourceEvidence: { ...input.sourceEvidence, kind: "fixture" } }), /fixtures/);
    await assert.rejects(createAssemblyReceipt({ ...input, selectedAssets: [{ ...selection, path: root }] }), /URI\/path mismatch/);
    await writeFile(glbPath, Buffer.from("tampered bytes"));
    await assert.rejects(createAssemblyReceipt(input), /bytes do not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function packageFor(sha256, byteLength) {
  const host = { schema_version: "1", host_id: "unity-consumer-host", host_build: "1", platform: "macos", scripting_backend: "il2cpp", execution_kinds: ["recipe", "runtime_asset"], loaders: [], contracts: [], limits: { memory_mb: 32, preload_seconds: 8, artifact_bytes: 4096 } };
  const baseline = { schema_version: "1", module_id: "baseline-body", revision: 1, execution_kind: "recipe", provides: ["encounter.body"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "baseline" }, fallback_module_ids: [] };
  const runtime = { schema_version: "1", module_id: "selected-glb-module", revision: 4, execution_kind: "runtime_asset", provides: ["encounter.body"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 1, score: 2 }, artifact: { uri: `sha256:${sha256}`, sha256, media_type: "model/gltf-binary", byte_length: byteLength }, fallback_module_ids: ["baseline-body"] };
  const ready = assembleEncounterPackage({ host, encounterId: "selected-glb-encounter", packageId: "selected-glb-package", baselineModules: [baseline], candidateModules: [runtime], assembledAt: "2026-09-08T23:12:16.714Z" }).package;
  return freezeEncounterPackage(ready, "2026-09-08T23:12:16.714Z");
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function buildRoomReceiptFor(frozenPackage, sha256, revision) {
  const unsigned = {
    schema_version: "1", receipt_id: "build-room-receipt", package_id: frozenPackage.package_id,
    package_revision: frozenPackage.revision, package_manifest_sha256: "b".repeat(64),
    assembled_at: "2026-09-08T23:12:16.714Z", selected_modules: [{ module_id: "selected-glb-module", revision, artifact_sha256: sha256 }],
    fallback_provenance: { used_fallback: false, module_ids: [] }, validation: [], host_acceptance: "not_observed",
  };
  return { ...unsigned, receipt_sha256: hash(Buffer.from(JSON.stringify(unsigned))) };
}
