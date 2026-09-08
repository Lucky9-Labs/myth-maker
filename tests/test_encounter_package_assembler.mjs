import assert from "node:assert/strict";
import test from "node:test";

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
  execution_kinds: ["recipe", "runtime_asset"],
  loaders: ["rig.standard", "collision.default"],
  contracts: ["combat.target.v1", "arena.bounds.v1"],
  limits: { memory_mb: 1024, preload_seconds: 10, artifact_bytes: 1000, actors: 8 },
};

function recipe(module_id, overrides = {}) {
  return {
    schema_version: "1",
    module_id,
    revision: 1,
    execution_kind: "recipe",
    provides: [module_id],
    requires: ["combat.target.v1"],
    conflicts: [],
    compatibility: { host_contract_version: "1" },
    quality: { tier: 0, score: 1 },
    inline_recipe: { module_id },
    fallback_module_ids: [],
    ...overrides,
  };
}

test("assembles a frozen-by-construction ready baseline package", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-one",
    packageId: "package-one",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-combat"]);
  assert.equal(result.package.revision, 1);
  assert.equal(result.package.state, "ready");
  assert.equal(result.package.fallback_provenance.used_fallback, false);
  assert.match(result.package.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.rejections, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.package));
});

test("selects the highest-scoring compatible candidates independent of input order", () => {
  const low = recipe("low-upgrade", { quality: { tier: 4, score: 2 } });
  const high = recipe("high-upgrade", { quality: { tier: 1, score: 3 } });
  const input = {
    host,
    encounterId: "encounter-order",
    packageId: "package-order",
    baselineModules: [recipe("baseline-combat")],
    assembledAt: "2026-09-08T00:00:00.000Z",
  };

  const first = assembleEncounterPackage({ ...input, candidateModules: [low, high] });
  const second = assembleEncounterPackage({ ...input, candidateModules: [high, low] });

  assert.deepEqual(first, second);
  assert.deepEqual(first.package.module_ids, ["baseline-combat", "high-upgrade", "low-upgrade"]);
});

test("replaces a baseline provider with a higher-ranked candidate for the same capability", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-replacement",
    packageId: "package-replacement",
    baselineModules: [recipe("baseline-body", { provides: ["body.core"], quality: { tier: 0, score: 1 } })],
    candidateModules: [recipe("upgrade-body", {
      provides: ["body.core"],
      quality: { tier: 1, score: 2 },
      fallback_module_ids: ["baseline-body"],
    })],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["upgrade-body"]);
  assert.deepEqual(result.package.fallback_provenance, { used_fallback: false, module_ids: [] });
});

test("chooses one deterministic provider per capability regardless of candidate order", () => {
  const baseline = recipe("baseline-body", { provides: ["body.core"] });
  const winner = recipe("body-winner", { provides: ["body.core"], quality: { tier: 0, score: 5 } });
  const loser = recipe("body-loser", { provides: ["body.core"], quality: { tier: 4, score: 4 } });
  const input = {
    host,
    encounterId: "encounter-provider-slot",
    packageId: "package-provider-slot",
    baselineModules: [baseline],
    assembledAt: "2026-09-08T00:00:00.000Z",
  };

  const first = assembleEncounterPackage({ ...input, candidateModules: [loser, winner] });
  const second = assembleEncounterPackage({ ...input, candidateModules: [winner, loser] });

  assert.deepEqual(first, second);
  assert.deepEqual(first.package.module_ids, ["body-winner"]);
  assert.deepEqual(first.rejections, [{
    module_id: "body-loser",
    revision: 1,
    reasons: ["higher-ranked provider body-winner selected for body.core"],
  }]);
});

test("rejects ambiguous duplicate stable module IDs instead of silently dropping a revision", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-identity-collision",
    packageId: "package-identity-collision",
    baselineModules: [recipe("baseline-body", { provides: ["body.core"] })],
    candidateModules: [
      recipe("duplicate-upgrade", { provides: ["body.core"], quality: { tier: 0, score: 5 } }),
      recipe("duplicate-upgrade", { revision: 2, provides: ["combat.core"], quality: { tier: 0, score: 4 } }),
      recipe("baseline-body", { revision: 2, provides: ["body.core"], quality: { tier: 0, score: 8 } }),
    ],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-body"]);
  assert.deepEqual(result.rejections, [
    { module_id: "baseline-body", revision: 2, reasons: ["module id collides with baseline baseline-body"] },
    { module_id: "duplicate-upgrade", revision: 1, reasons: ["duplicate candidate module id duplicate-upgrade"] },
    { module_id: "duplicate-upgrade", revision: 2, reasons: ["duplicate candidate module id duplicate-upgrade"] },
  ]);
});

test("rejects malformed candidates before ranking the remaining candidates", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-malformed-candidate",
    packageId: "package-malformed-candidate",
    baselineModules: [recipe("baseline-body", { provides: ["body.core"] })],
    candidateModules: [null, recipe("valid-upgrade", {
      provides: ["body.core"],
      quality: { tier: 0, score: 2 },
    })],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["valid-upgrade"]);
  assert.deepEqual(result.rejections, [{
    module_id: "invalid-candidate",
    revision: 0,
    reasons: ["invalid encounter module"],
  }]);
});

test("keeps a multi-capability baseline when it still owns an uncovered capability", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-multi-capability",
    packageId: "package-multi-capability",
    baselineModules: [recipe("baseline-body-combat", {
      provides: ["body.core", "combat.core"],
    })],
    candidateModules: [recipe("body-upgrade", {
      provides: ["body.core"],
      quality: { tier: 0, score: 2 },
    })],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-body-combat", "body-upgrade"]);
});

test("reports each host-compatibility rejection without blocking compatible work", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-compatibility",
    packageId: "package-compatibility",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [
      recipe("unsupported-kind", {
        execution_kind: "managed_plugin",
        entrypoint: "Plugin.Entry",
        artifact: artifact(),
      }),
      recipe("missing-contract", { requires: ["missing.contract.v1"] }),
      recipe("wrong-platform", { compatibility: { host_contract_version: "1", platforms: ["macos"] } }),
      recipe("missing-loader", { compatibility: { host_contract_version: "1", bindings: { "rig.exotic": "v2" } } }),
      {
        ...recipe("oversized-artifact", { execution_kind: "runtime_asset" }),
        artifact: { uri: "https://example.test/asset", sha256: "a".repeat(64), media_type: "application/octet-stream", byte_length: 1001 },
      },
      recipe("compatible-upgrade", { quality: { tier: 2, score: 4 } }),
    ],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-combat", "compatible-upgrade"]);
  assert.deepEqual(result.rejections, [
    { module_id: "missing-contract", revision: 1, reasons: ["missing host contract missing.contract.v1"] },
    { module_id: "missing-loader", revision: 1, reasons: ["missing host loader rig.exotic"] },
    { module_id: "oversized-artifact", revision: 1, reasons: ["artifact exceeds host byte limit 1000"] },
    { module_id: "unsupported-kind", revision: 1, reasons: ["unsupported execution kind managed_plugin"] },
    { module_id: "wrong-platform", revision: 1, reasons: ["unsupported platform windows"] },
  ]);
  assert.deepEqual(result.package.rejection_reasons, result.rejections.flatMap(
    ({ module_id, revision, reasons }) => reasons.map((reason) => `${module_id}@${revision}: ${reason}`),
  ));
});

test("rejects either direction of a declared conflict and keeps the higher-ranked module", () => {
  const high = recipe("high-priority", { provides: ["behavior.primary"], quality: { tier: 1, score: 5 } });
  const lower = recipe("lower-priority", { conflicts: ["behavior.primary"], quality: { tier: 4, score: 4 } });
  const inverse = recipe("inverse-conflict", { provides: ["behavior.inverse"], quality: { tier: 1, score: 2 } });
  const baseline = recipe("baseline-combat", { conflicts: ["behavior.inverse"] });

  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-conflicts",
    packageId: "package-conflicts",
    baselineModules: [baseline],
    candidateModules: [lower, inverse, high],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-combat", "high-priority"]);
  assert.deepEqual(result.rejections, [
    { module_id: "inverse-conflict", revision: 1, reasons: ["conflicts with baseline-combat via behavior.inverse"] },
    { module_id: "lower-priority", revision: 1, reasons: ["conflicts with high-priority via behavior.primary"] },
  ]);
});

test("retains a declared selected fallback when its primary module is rejected", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-fallback",
    packageId: "package-fallback",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [recipe("plugin-primary", {
      execution_kind: "managed_plugin",
      entrypoint: "Plugin.Entry",
      artifact: artifact(),
      fallback_module_ids: ["baseline-combat"],
    })],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.fallback_provenance, {
    used_fallback: true,
    module_ids: ["baseline-combat"],
  });
  assert.deepEqual(result.rejections, [{
    module_id: "plugin-primary",
    revision: 1,
    reasons: ["unsupported execution kind managed_plugin"],
  }]);
});

test("creates monotonic immutable revisions and deterministically freezes ready packages", () => {
  const input = {
    host,
    encounterId: "encounter-revisions",
    packageId: "package-revisions",
    baselineModules: [recipe("baseline-combat")],
    assembledAt: "2026-09-08T00:00:00.000Z",
  };
  const first = assembleEncounterPackage(input).package;
  const second = assembleEncounterPackage({ ...input, previousPackage: first }).package;
  const frozen = freezeEncounterPackage(second, "2026-09-08T00:05:00.000Z");

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.state, "ready");
  assert.equal(frozen.revision, 2);
  assert.equal(frozen.state, "frozen");
  assert.equal(frozen.frozen_at, "2026-09-08T00:05:00.000Z");
  assert.notEqual(frozen.manifest_sha256, second.manifest_sha256);
  assert.ok(Object.isFrozen(frozen));
  assert.throws(() => assembleEncounterPackage({ ...input, previousPackage: frozen }), /frozen package/);
  assert.throws(() => freezeEncounterPackage(frozen, "2026-09-08T00:06:00.000Z"), /ready package/);
  assert.throws(() => assembleEncounterPackage({
    ...input,
    previousPackage: { ...first, manifest_sha256: "0".repeat(64) },
  }), /valid immutable package revision/);
});

test("fails closed when the required baseline is incompatible", () => {
  assert.throws(() => assembleEncounterPackage({
    host,
    encounterId: "encounter-baseline",
    packageId: "package-baseline",
    baselineModules: [recipe("bad-baseline", { execution_kind: "managed_plugin", entrypoint: "Plugin.Entry" })],
    assembledAt: "2026-09-08T00:00:00.000Z",
  }), /baseline module bad-baseline@1 is incompatible/);
});

test("rejects candidates that cannot satisfy their v1 execution payload requirements", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-payloads",
    packageId: "package-payloads",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [
      recipe("missing-recipe", { inline_recipe: undefined }),
      recipe("missing-artifact", { execution_kind: "runtime_asset" }),
      recipe("missing-entrypoint", { execution_kind: "managed_plugin", artifact: artifact() }),
    ],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.rejections, [
    { module_id: "missing-artifact", revision: 1, reasons: ["non-recipe module requires an artifact"] },
    { module_id: "missing-entrypoint", revision: 1, reasons: ["managed_plugin requires an entrypoint"] },
    { module_id: "missing-recipe", revision: 1, reasons: ["recipe requires inline_recipe"] },
  ]);
});

test("never selects a raw Blender-source artifact as a loadable runtime module", () => {
  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-source-artifact",
    packageId: "package-source-artifact",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [{
      ...recipe("blender-receipt", { execution_kind: "runtime_asset" }),
      artifact: {
        uri: "https://example.test/outputs/encounter.blend",
        sha256: "c".repeat(64),
        media_type: "application/x-blender",
      },
    }],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-combat"]);
  assert.deepEqual(result.rejections, [{
    module_id: "blender-receipt",
    revision: 1,
    reasons: ["source artifact is not a loadable encounter module"],
  }]);
});

test("fails closed for invalid host manifests and rejects invalid v1 candidates", () => {
  assert.throws(() => assembleEncounterPackage({
    host: { ...host, execution_kinds: ["unknown"] },
    encounterId: "encounter-invalid-host",
    packageId: "package-invalid-host",
    baselineModules: [recipe("baseline-combat")],
    assembledAt: "2026-09-08T00:00:00.000Z",
  }), /HostCapabilityManifest/);

  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-invalid-candidate",
    packageId: "package-invalid-candidate",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [
      recipe("unknown-kind", { execution_kind: "unknown" }),
      recipe("empty-provides", { provides: [] }),
      recipe("invalid-tier", { quality: { tier: 5, score: -1 } }),
      recipe("undeclared-field", { unexpected: true }),
    ],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-combat"]);
  assert.deepEqual(result.rejections, [
    { module_id: "empty-provides", revision: 1, reasons: ["provides must contain unique semantic tags"] },
    { module_id: "invalid-tier", revision: 1, reasons: ["quality.score must be a non-negative finite number", "quality.tier must be an integer from 0 through 4"] },
    { module_id: "undeclared-field", revision: 1, reasons: ["undeclared field unexpected"] },
    { module_id: "unknown-kind", revision: 1, reasons: ["unknown execution kind unknown"] },
  ]);
});

test("refuses to freeze a malformed or tampered ready package", () => {
  assert.throws(() => freezeEncounterPackage({ state: "ready" }, "2026-09-08T00:05:00.000Z"), /valid ready package/);

  const ready = assembleEncounterPackage({
    host,
    encounterId: "encounter-tampered",
    packageId: "package-tampered",
    baselineModules: [recipe("baseline-combat")],
    assembledAt: "2026-09-08T00:00:00.000Z",
  }).package;
  assert.throws(() => freezeEncounterPackage({ ...ready, module_ids: ["other"] }, "2026-09-08T00:05:00.000Z"), /manifest_sha256/);
});

test("enforces v1 date-time and maximum-length constraints", () => {
  assert.throws(() => assembleEncounterPackage({
    host,
    encounterId: "encounter-date-only",
    packageId: "package-date-only",
    baselineModules: [recipe("baseline-combat")],
    assembledAt: "2026-09-08",
  }), /ISO-8601 timestamp/);

  const result = assembleEncounterPackage({
    host,
    encounterId: "encounter-limits",
    packageId: "package-limits",
    baselineModules: [recipe("baseline-combat")],
    candidateModules: [
      recipe("invalid-provenance-date", { provenance: { producer: "test", created_at: "2026-09-08" } }),
      recipe("long-entrypoint", { execution_kind: "managed_plugin", artifact: artifact(), entrypoint: "x".repeat(257) }),
      {
        ...recipe("long-uri", { execution_kind: "runtime_asset" }),
        artifact: { ...artifact(), uri: `https://example.test/${"x".repeat(2048)}` },
      },
    ],
    assembledAt: "2026-09-08T00:00:00Z",
  });

  assert.deepEqual(result.package.module_ids, ["baseline-combat"]);
  assert.deepEqual(result.rejections.map(({ module_id }) => module_id), [
    "invalid-provenance-date",
    "long-entrypoint",
    "long-uri",
  ]);
});

function artifact() {
  return {
    uri: "https://example.test/plugin",
    sha256: "b".repeat(64),
    media_type: "application/octet-stream",
  };
}
