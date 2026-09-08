import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssemblyReceipt,
  runDeterministicEncounter,
  validateAssemblyReceipt,
  validateSimulationReceipt,
} from "../src/encounter-runner.js";

const frozenPackage = Object.freeze({
  schema_version: "1",
  package_id: "neutral-chamber-package",
  encounter_id: "neutral-chamber",
  revision: 1,
  state: "frozen",
  assembled_at: "2026-09-08T12:00:00.000Z",
  frozen_at: "2026-09-08T12:01:00.000Z",
  module_ids: ["neutral-combat-recipe"],
  manifest_sha256: "a".repeat(64),
  fallback_provenance: { used_fallback: false, module_ids: [] },
});

const selected = {
  assets: [{ asset_id: "neutral-target", revision: 3, sha256: "b".repeat(64), uri: "artifact://neutral-target.prefab" }],
  animations: [{ animation_id: "neutral-strike", revision: 2, sha256: "c".repeat(64), uri: "artifact://neutral-strike.anim" }],
};

const profile = {
  schema_version: "1",
  profile_id: "unity-neutral-headless",
  profile_revision: 1,
  runner_id: "myth-maker-unity-encounter-runner",
  runtime_id: "unity-6000.6.0f1",
  build_profile_id: "standalone-macos-mono-development",
  evidence_tier: "local_unity_runner",
  execution_mode: "headless",
  unity: { editor_version: "6000.6.0f1", scripting_backend: "mono", platform: "macos" },
};

test("a frozen package and exact selected revisions produce an immutable assembly receipt", () => {
  const receipt = createAssemblyReceipt({
    assemblyId: "neutral-chamber-assembly",
    frozenPackage,
    selected,
    assembledAt: "2026-09-08T12:02:00.000Z",
    provenance: { producer: "neutral-fixture", observed_at: "2026-09-08T12:02:00.000Z" },
  });

  assert.equal(receipt.package_manifest_sha256, frozenPackage.manifest_sha256);
  assert.deepEqual(receipt.selected_assets, selected.assets);
  assert.deepEqual(receipt.selected_animations, selected.animations);
  assert.equal(validateAssemblyReceipt(receipt), true);
  assert.ok(Object.isFrozen(receipt));
});

test("the local deterministic runner records a real scripted hit exchange without inventing player visuals", () => {
  const assembly = createAssemblyReceipt({
    assemblyId: "neutral-chamber-assembly",
    frozenPackage,
    selected,
    assembledAt: "2026-09-08T12:02:00.000Z",
    provenance: { producer: "neutral-fixture", observed_at: "2026-09-08T12:02:00.000Z" },
  });
  const receipt = runDeterministicEncounter({
    assemblyReceipt: assembly,
    runtimeProfile: profile,
    seed: 41,
    script: [
      { at_ms: 100, actor: "player", target: "encounter-target", damage: 9 },
      { at_ms: 250, actor: "encounter-target", target: "player", damage: 4 },
    ],
    startedAt: "2026-09-08T12:03:00.000Z",
  });

  assert.equal(receipt.status, "passed");
  assert.equal(receipt.evidence_tiers.source, "local_orchestration");
  assert.equal(receipt.evidence_tiers.runtime, "local_unity_runner");
  assert.equal(receipt.evidence_tiers.player, "not_observed");
  assert.equal(receipt.frame_or_clip_artifact, undefined);
  assert.equal(receipt.telemetry.hit_exchange.verified, true);
  assert.deepEqual(receipt.telemetry.hit_exchange.events.map((event) => event.damage), [9, 4]);
  assert.equal(validateSimulationReceipt(receipt), true);
});

test("the runner fails closed when the package, profile, or exchange proof is incomplete", () => {
  assert.throws(() => createAssemblyReceipt({
    assemblyId: "invalid-assembly", frozenPackage: { ...frozenPackage, state: "ready" }, selected,
    assembledAt: "2026-09-08T12:02:00.000Z", provenance: { producer: "test", observed_at: "2026-09-08T12:02:00.000Z" },
  }), /frozen/);

  const assembly = createAssemblyReceipt({
    assemblyId: "neutral-chamber-assembly", frozenPackage, selected,
    assembledAt: "2026-09-08T12:02:00.000Z", provenance: { producer: "test", observed_at: "2026-09-08T12:02:00.000Z" },
  });
  assert.throws(() => runDeterministicEncounter({
    assemblyReceipt: assembly, runtimeProfile: { ...profile, evidence_tier: "cloud_rendered_preview" }, seed: 41,
    script: [{ at_ms: 100, actor: "player", target: "encounter-target", damage: 1 }],
    startedAt: "2026-09-08T12:03:00.000Z",
  }), /closed local runtime profile/);
});
