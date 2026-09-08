import { createSqliteCatalog } from "../src/catalog-sqlite.js";

const catalog = createSqliteCatalog();
catalog.bootstrapOceanEncounter();
const parts = catalog.findCompatibleParts({
  host: { platform: "windows", loaders: ["rig.aquatic", "collision.default"], contracts: ["combat.target.v1"] },
  functionalTags: ["body.shell"], aestheticTags: ["aesthetic.ocean"], rigBindingId: "rig.aquatic.biped.v1",
});
const first = catalog.getAsset("ocean-shell");
const next = catalog.appendAssetRevision({ ...first, functionalTags: [...first.functionalTags, "body.armored"], provenance: { ...first.provenance, parentRefs: [{ domain: "asset", stableId: first.assetId, revision: first.revision, contentSha256: first.contentSha256 }] } });
const evidence = catalog.recordHitEvidence({ evidenceId: "evidence-brine-stalker-001", encounterId: "ocean-rift-001", occurredAt: "2026-09-08T00:00:00.000Z", observer: "synthetic-combat-harness", actorEntityId: "player-proxy", targetEntityId: "brine-stalker", effectTag: "effect.kinetic-hit", payload: { damage: 24, critical: true } });
console.log(JSON.stringify({ parts, appendedAssetRevision: next.revision, evidence }, null, 2));
catalog.close();
