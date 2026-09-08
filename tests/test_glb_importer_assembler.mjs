import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assembleEncounterPackage } from "../src/encounter-package-assembler.js";
import { ingestGlbRuntimeCandidate } from "../src/glb-runtime-candidate-ingress.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "glb_importer_assembler_fixture.py");

function emit(...args) {
  return spawnSync("python3", [fixture, ...args], { encoding: "utf8" });
}

function baseline() {
  return {
    schema_version: "1", module_id: "baseline-body", revision: 1, execution_kind: "recipe",
    provides: ["encounter.body"], requires: ["encounter-module.v1"], conflicts: [],
    compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 },
    inline_recipe: { kind: "baseline" }, fallback_module_ids: [],
  };
}

test("an accepted Python GLB importer candidate is selected by the actual JS assembler", () => {
  const emitted = emit();
  assert.equal(emitted.status, 0, emitted.stderr);
  const { host, profile, module } = JSON.parse(emitted.stdout);
  assert.equal(profile.profile, "glb.v1");
  const wrongHash = "0".repeat(64);
  assert.throws(() => ingestGlbRuntimeCandidate({
    module, loaderProfile: { ...profile, artifact: { ...profile.artifact, sha256: wrongHash, uri: `sha256:${wrongHash}` } },
  }), /acceptance/);

  const ingress = ingestGlbRuntimeCandidate({ module, loaderProfile: profile });
  module.module_id = "mutated-caller-module";
  profile.artifact.sha256 = "f".repeat(64);
  assert.equal(ingress.module.module_id, "glb-candidate");
  assert.notEqual(ingress.loader_profile.artifact.sha256, "f".repeat(64));
  for (const mutate of [
    (value) => { value.provenance.converter = ""; },
    (value) => { value.provenance.source_receipt.created_at = "0"; },
    (value) => { value.provenance.acceptance.accepted_at = "0"; },
    (value) => { value.provenance.converted_at = "0"; },
  ]) {
    const malformed = structuredClone(ingress.loader_profile);
    mutate(malformed);
    assert.throws(() => ingestGlbRuntimeCandidate({ module: ingress.module, loaderProfile: malformed }), /invalid/);
  }
  const result = assembleEncounterPackage({
    host, encounterId: "glb-encounter", packageId: "glb-package", baselineModules: [baseline()],
    candidateModules: [ingress.module], assembledAt: "2026-09-08T20:00:00.000Z",
  });
  assert.deepEqual(result.package.module_ids, ["glb-candidate"]);
});

test("a malformed loader profile fails in Python before JS selection and a malformed module is rejected", () => {
  const malformedProfile = emit("--malformed-profile");
  assert.notEqual(malformedProfile.status, 0);
  assert.match(malformedProfile.stderr, /glb\.v1 profile has an invalid shape/);

  const malformedModule = emit("--malformed-module");
  assert.equal(malformedModule.status, 0, malformedModule.stderr);
  const { host, profile, module } = JSON.parse(malformedModule.stdout);
  assert.throws(() => ingestGlbRuntimeCandidate({ module, loaderProfile: profile }), /invalid runtime module/);
  const result = assembleEncounterPackage({
    host, encounterId: "glb-invalid", packageId: "glb-invalid-package", baselineModules: [baseline()],
    candidateModules: [module], assembledAt: "2026-09-08T20:00:00.000Z",
  });
  assert.deepEqual(result.package.module_ids, ["baseline-body"]);
  assert.deepEqual(result.rejections, [{
    module_id: "glb-candidate", revision: 1, reasons: ["undeclared field undeclared"],
  }]);
});
