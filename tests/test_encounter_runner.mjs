import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssemblyReceipt,
  runDeterministicEncounter,
  validateAssemblyReceipt,
  validateSimulationReceipt,
} from "../src/encounter-runner.js";
import { assembleEncounterPackage, freezeEncounterPackage } from "../src/encounter-package-assembler.js";

const frozenPackage = frozenNeutralPackage();

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
  build_profile_id: "editor-macos-mono-batch",
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

test("receipt validation rejects a tampered package and any undeclared nested data", () => {
  assert.throws(() => createAssemblyReceipt({
    assemblyId: "tampered-assembly", frozenPackage: { ...frozenPackage, module_ids: ["other-module"] }, selected,
    assembledAt: "2026-09-08T12:02:00.000Z", provenance: { producer: "test", observed_at: "2026-09-08T12:02:00.000Z" },
  }), /immutable frozen/);
  const assembly = createAssemblyReceipt({ assemblyId: "neutral-chamber-assembly", frozenPackage, selected, assembledAt: "2026-09-08T12:02:00.000Z", provenance: { producer: "test", observed_at: "2026-09-08T12:02:00.000Z" } });
  const receipt = runDeterministicEncounter({ assemblyReceipt: assembly, runtimeProfile: profile, seed: 41, script: [{ at_ms: 100, actor: "player", target: "encounter-target", damage: 9 }, { at_ms: 250, actor: "encounter-target", target: "player", damage: 4 }], startedAt: "2026-09-08T12:03:00.000Z" });
  assert.throws(() => validateSimulationReceipt({ ...receipt, evidence_tiers: { ...receipt.evidence_tiers, invented: true } }), /evidence tiers/);
  assert.throws(() => validateSimulationReceipt({ ...receipt, telemetry: { ...receipt.telemetry, hit_exchange: { verified: true, events: [] } } }), /hit events/);
});

function frozenNeutralPackage() {
  const host = { schema_version: "1", host_id: "neutral-host", host_build: "fixture-1", platform: "macos", scripting_backend: "mono", execution_kinds: ["recipe"], loaders: [], contracts: [], limits: { memory_mb: 128, preload_seconds: 1 } };
  const module = { schema_version: "1", module_id: "neutral-combat-recipe", revision: 1, execution_kind: "recipe", provides: ["encounter.baseline"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "neutral-scripted-exchange" }, fallback_module_ids: [] };
  const ready = assembleEncounterPackage({ host, encounterId: "neutral-chamber", packageId: "neutral-chamber-package", baselineModules: [module], assembledAt: "2026-09-08T12:00:00.000Z" }).package;
  return freezeEncounterPackage(ready, "2026-09-08T12:01:00.000Z");
}
