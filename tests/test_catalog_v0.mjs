import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteCatalog } from "../src/catalog-sqlite.js";
import { compositionContentSha256 } from "../src/composition-swarm-coordinator.js";

const host = {
  platform: "windows",
  loaders: ["rig.aquatic", "collision.default"],
  contracts: ["combat.target.v1"],
};

function parentRef(record, domain) {
  return { domain, stableId: record[`${domain}Id`], revision: record.revision, contentSha256: record.contentSha256 };
}

test("bootstrap exposes compatible, host-loadable parts through the planner interface", () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();

  const parts = catalog.findCompatibleParts({
    host,
    functionalTags: ["body.shell"],
    aestheticTags: ["aesthetic.ocean"],
    rigBindingId: "rig.aquatic.biped.v1",
  });

  assert.deepEqual(parts.assets.map((asset) => asset.assetId), ["ocean-shell"]);
  assert.deepEqual(parts.animations.map((animation) => animation.animationId), ["ocean-lunge"]);
  assert.deepEqual(catalog.getEntityGraph("brine-stalker").affordances, ["combat.lunge", "combat.shield"]);
  catalog.close();
});

test("append-only revisions and operational hit evidence remain queryable without raw SQL", () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();

  const prior = catalog.getAsset("ocean-shell");
  const revised = catalog.appendAssetRevision({
    ...prior,
    functionalTags: [...prior.functionalTags, "body.armored"],
    provenance: {
      ...prior.provenance,
      parentRefs: [{ domain: "asset", stableId: prior.assetId, revision: prior.revision, contentSha256: prior.contentSha256 }],
    },
  });
  const evidence = catalog.recordHitEvidence({
    evidenceId: "evidence-brine-stalker-001",
    encounterId: "ocean-rift-001",
    occurredAt: "2026-09-08T00:00:00.000Z",
    observer: "synthetic-combat-harness",
    actorEntityId: "player-proxy",
    targetEntityId: "brine-stalker",
    effectTag: "effect.kinetic-hit",
    payload: { damage: 24, critical: true },
  });

  assert.equal(revised.revision, 2);
  assert.deepEqual(revised.provenance.parentRefs, [{
    domain: "asset", stableId: "ocean-shell", revision: 1, contentSha256: prior.contentSha256,
  }]);
  assert.equal(catalog.getAsset("ocean-shell", 1).functionalTags.includes("body.armored"), false);
  assert.equal(catalog.getAsset("ocean-shell").functionalTags.includes("body.armored"), true);
  assert.equal(evidence.payloadSha256.length, 64);
  assert.deepEqual(catalog.listEncounterEvidence("ocean-rift-001").map(({ evidenceId }) => evidenceId), [
    "evidence-brine-stalker-001",
  ]);
  catalog.close();
});

test("rejects malformed provenance parents before a new revision is persisted", () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();
  const prior = catalog.getAsset("ocean-shell");

  assert.throws(() => catalog.appendAssetRevision({
    ...prior,
    provenance: { ...prior.provenance, parentRefs: [{ domain: "unknown", stableId: "ocean-shell" }] },
  }), /parentRefs/);
  assert.equal(catalog.getAsset("ocean-shell").revision, 1);
  catalog.close();
});

test("keeps the latest accepted asset usable while source-only revisions are pending or rejected", () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();
  const prior = catalog.getAsset("ocean-shell");

  const sourceOnly = catalog.appendAssetRevision({
    ...prior,
    runtimeArtifact: undefined,
    runtimeAcceptanceState: "candidate",
    provenance: { ...prior.provenance, parentRefs: [parentRef(prior, "asset")] },
  });

  assert.equal(sourceOnly.runtimeArtifact, undefined);
  assert.equal(sourceOnly.sourceReceipt.uri.endsWith(".source"), true);
  const rejected = catalog.appendAssetRevision({
    ...sourceOnly,
    runtimeAcceptanceState: "rejected",
    provenance: { ...sourceOnly.provenance, parentRefs: [parentRef(sourceOnly, "asset")] },
  });
  assert.equal(rejected.runtimeArtifact, undefined);
  assert.deepEqual(catalog.findCompatibleParts({ host, functionalTags: ["body.shell"] }).assets.map((item) => [item.assetId, item.revision]), [
    ["ocean-shell", 1],
  ]);
  const accepted = catalog.appendAssetRevision({
    ...rejected,
    runtimeArtifact: prior.runtimeArtifact,
    runtimeAcceptanceState: "accepted",
    provenance: { ...rejected.provenance, parentRefs: [parentRef(rejected, "asset")] },
  });
  assert.deepEqual(catalog.findCompatibleParts({ host, functionalTags: ["body.shell"] }).assets.map((item) => [item.assetId, item.revision]), [
    ["ocean-shell", accepted.revision],
  ]);
  catalog.close();
});

test("keeps accepted animation revisions usable until a later recipe is accepted", () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();
  const prior = catalog.getAnimation("ocean-lunge");

  assert.throws(() => catalog.appendAnimationRevision({
    ...prior,
    runtimeArtifact: undefined,
    provenance: { ...prior.provenance, parentRefs: [parentRef(prior, "animation")] },
  }), /runtimeArtifact/);

  const candidateRecipe = catalog.appendAnimationRevision({
    ...prior,
    kind: "recipe",
    recipe: { motion: "lunge", amplitude: 0.75 },
    sourceReceipt: undefined,
    sourceAcceptanceState: undefined,
    runtimeArtifact: undefined,
    runtimeAcceptanceState: "candidate",
    provenance: { ...prior.provenance, parentRefs: [parentRef(prior, "animation")] },
  });
  const rejectedRecipe = catalog.appendAnimationRevision({
    ...candidateRecipe,
    runtimeAcceptanceState: "rejected",
    provenance: { ...candidateRecipe.provenance, parentRefs: [parentRef(candidateRecipe, "animation")] },
  });
  assert.deepEqual(catalog.findCompatibleParts({ host, functionalTags: ["combat.lunge"] }).animations.map((item) => [item.animationId, item.revision]), [
    ["ocean-lunge", 1],
  ]);
  const acceptedRecipe = catalog.appendAnimationRevision({
    ...rejectedRecipe,
    runtimeAcceptanceState: "accepted",
    provenance: { ...rejectedRecipe.provenance, parentRefs: [parentRef(rejectedRecipe, "animation")] },
  });
  assert.equal(acceptedRecipe.kind, "recipe");
  assert.equal(acceptedRecipe.sourceReceipt, undefined);
  assert.equal(acceptedRecipe.runtimeArtifact, undefined);
  assert.deepEqual(catalog.findCompatibleParts({ host, functionalTags: ["combat.lunge"] }).animations.map((item) => [item.animationId, item.revision]), [
    ["ocean-lunge", acceptedRecipe.revision],
  ]);
  catalog.close();
});

test("requires the exact immediately prior parent when appending a revision", () => {
  const catalog = createSqliteCatalog();
  catalog.bootstrapOceanEncounter();
  const prior = catalog.getAsset("ocean-shell");

  assert.throws(() => catalog.appendAssetRevision({
    ...prior, functionalTags: [...prior.functionalTags, "body.armored"],
    provenance: { ...prior.provenance },
  }), /immediate parent/);
  assert.throws(() => catalog.appendAssetRevision({
    ...prior, functionalTags: [...prior.functionalTags, "body.armored"],
    provenance: { ...prior.provenance, parentRefs: [{ ...parentRef(prior, "asset"), contentSha256: "a".repeat(64) }] },
  }), /immediate parent/);

  const appended = catalog.appendAssetRevision({
    ...prior, functionalTags: [...prior.functionalTags, "body.armored"],
    provenance: { ...prior.provenance, parentRefs: [parentRef(prior, "asset")] },
  });
  assert.equal(appended.revision, 2);
  assert.throws(() => catalog.appendAssetRevision({
    ...appended, functionalTags: [...appended.functionalTags, "body.reinforced"],
    provenance: { ...appended.provenance, parentRefs: [parentRef(prior, "asset")] },
  }), /immediate parent/);
  assert.throws(() => catalog.appendAssetRevision({
    ...prior, functionalTags: [...prior.functionalTags, "body.armored"],
    provenance: { ...prior.provenance, parentRefs: [parentRef(prior, "asset")] },
  }), /current revision/);
  catalog.close();
});

test("catalog owns immutable generic composition module revisions", () => {
  const catalog = createSqliteCatalog();
  const first = {
    schema_version: "2", module_id: "generic-shell", revision: 1,
    content_sha256: "0".repeat(64),
    provenance: { created_at: "2026-09-08T00:00:00Z", parent_module_refs: [] },
  };
  first.content_sha256 = compositionContentSha256(first);
  assert.deepEqual(catalog.admitCompositionModuleRevision(first), first);
  assert.deepEqual(catalog.admitCompositionModuleRevision(first), first, "exact replay is idempotent");
  const conflicting = { ...first, extra: "different", content_sha256: "0".repeat(64) }; conflicting.content_sha256 = compositionContentSha256(conflicting);
  assert.throws(() => catalog.admitCompositionModuleRevision(conflicting), /conflicts with the immutable catalog revision/);
  const missingParent = { ...first, revision: 2, content_sha256: "0".repeat(64) }; missingParent.content_sha256 = compositionContentSha256(missingParent);
  assert.throws(() => catalog.admitCompositionModuleRevision(missingParent), /immediate parent/);
  const second = {
    ...first, revision: 2, content_sha256: "0".repeat(64),
    provenance: { created_at: "2026-09-08T00:00:01Z", parent_module_refs: [{ module_id: first.module_id, revision: 1, content_sha256: first.content_sha256 }] },
  };
  second.content_sha256 = compositionContentSha256(second);
  assert.deepEqual(catalog.admitCompositionModuleRevision(second), second);
  assert.deepEqual(catalog.getCompositionModule("generic-shell", 1), first);
  assert.deepEqual(catalog.getCompositionModule("generic-shell"), second);
  catalog.close();
});
