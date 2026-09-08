import {
  assembleEncounterPackage,
  freezeEncounterPackage,
} from "../src/encounter-package-assembler.js";

const host = {
  schema_version: "1",
  host_id: "demo-host",
  host_build: "1.0.0",
  platform: "windows",
  scripting_backend: "il2cpp",
  execution_kinds: ["recipe"],
  loaders: ["rig.standard"],
  contracts: ["combat.target.v1"],
  limits: { memory_mb: 1024, preload_seconds: 10 },
};

const baseline = recipe("baseline-combat", 1);
const unsupportedUpgrade = {
  ...recipe("plugin-upgrade", 10),
  execution_kind: "managed_plugin",
  artifact: {
    uri: "https://example.test/plugin.bin",
    sha256: "a".repeat(64),
    media_type: "application/octet-stream",
  },
  entrypoint: "Example.Upgrade",
  fallback_module_ids: ["baseline-combat"],
};

const assembly = assembleEncounterPackage({
  host,
  encounterId: "demo-encounter",
  packageId: "demo-package",
  baselineModules: [baseline],
  candidateModules: [unsupportedUpgrade],
  assembledAt: "2026-09-08T00:00:00.000Z",
});

const frozen = freezeEncounterPackage(assembly.package, "2026-09-08T00:05:00.000Z");
console.log(JSON.stringify({ package: frozen, rejections: assembly.rejections }, null, 2));

function recipe(module_id, score) {
  return {
    schema_version: "1",
    module_id,
    revision: 1,
    execution_kind: "recipe",
    provides: [module_id],
    requires: ["combat.target.v1"],
    conflicts: [],
    compatibility: { host_contract_version: "1" },
    quality: { tier: 0, score },
    inline_recipe: { module_id },
    fallback_module_ids: [],
  };
}
