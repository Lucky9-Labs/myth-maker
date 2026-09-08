import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BuildRoom } from "../src/build-room.js";
import { createSqliteCatalog } from "../src/catalog-sqlite.js";
import {
  CatalogSeedValidationError,
  deriveCatalogStableId,
  importCatalogSeedManifest,
  inspectCatalogSeedManifest,
} from "../src/catalog-seeder.js";

const sourceBytes = Buffer.from("explicit fixture source bytes");
const sourceHash = sha256(sourceBytes);

function manifest(overrides = {}) {
  return {
    schema_version: "1",
    manifest_id: "host-asset-catalog-20260908",
    revision: 1,
    created_at: "2026-09-08T13:00:00.000Z",
    provenance: {
      producer: "host-catalog-export",
      source_locator: "explicit://host-export/2026-09-08",
      ownership_note: "Host-owned candidate; no redistribution grant asserted.",
      license_note: "Internal evaluation only.",
    },
    items: [{
      stable_key: "host-scout-mesh",
      domain: "asset",
      catalog_revision: 1,
      created_at: "2026-09-08T13:00:00.000Z",
      source: {
        locator: "fixture://host/scout.mesh",
        sha256: sourceHash,
        media_type: "model/gltf-binary",
        format: "glb",
        format_state: "available",
      },
      runtime: {
        format: "unity-assetbundle",
        format_state: "candidate",
      },
      host_compatibility: {
        platforms: ["windows"], loaders: ["host.assetbundle"], contracts: ["host.actor.v1"], binding_ids: ["host.scout.rig.v1"],
      },
      rig_compatibility: {
        skeleton_id: "host.scout.skeleton.v1",
        skeleton_sha256: "b".repeat(64),
        binding_id: "host.scout.rig.v1",
        model_binding_id: "host.scout.model.v1",
        animation_compatibility: "unknown",
      },
      functional_tags: ["actor.scout"],
      aesthetic_tags: ["style.neutral"],
    }],
    ...overrides,
  };
}

test("the manifest preview deterministically derives IDs and distinguishes declared from observed source evidence", () => {
  const candidate = manifest();
  const inspection = inspectCatalogSeedManifest(candidate);

  assert.equal(inspection.valid, true);
  assert.equal(inspection.preview[0].stable_id, deriveCatalogStableId("asset", "host-scout-mesh"));
  assert.equal(inspection.preview[0].evidence_tier, "source_declared");
  assert.equal(inspection.preview[0].thumbnail_state, "not_provided");

  const observed = inspectCatalogSeedManifest(candidate, { providedFiles: new Map([["fixture://host/scout.mesh", sourceBytes]]) });
  assert.equal(observed.preview[0].evidence_tier, "source_observed");
  assert.ok(deriveCatalogStableId("animation", "a".repeat(64)).length <= 64);
});

test("the importer only reads explicitly supplied source bytes, preserves immutable revisions, and exposes an honest inventory projection", () => {
  const catalog = createSqliteCatalog();
  const input = manifest();
  const first = importCatalogSeedManifest({ catalog, manifest: input, providedFiles: new Map([["fixture://host/scout.mesh", sourceBytes]]) });

  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].revision, 1);
  assert.equal(first.imported[0].seedMetadata.evidenceTier, "source_observed");
  assert.equal(first.imported[0].runtimeAcceptanceState, "candidate");
  assert.equal(first.imported[0].runtimeArtifact, undefined);
  const projection = catalog.buildRoomInventoryProjection();
  assert.deepEqual(Object.fromEntries(Object.entries(projection.summary).filter(([key]) => key.startsWith("seeded_") || key === "source_declared" || key === "source_observed" || key === "accepted_runtime" || key === "player_proven")), {
    seeded_entries: 1,
    seeded_revisions: 1,
    source_declared: 0,
    source_observed: 1,
    accepted_runtime: 0,
    player_proven: 0,
  });
  assert.deepEqual(projection.preview, [{
      stable_id: deriveCatalogStableId("asset", "host-scout-mesh"),
      domain: "asset",
      revision: 1,
      source_format: "glb",
      runtime_format: "unity-assetbundle",
      runtime_state: "candidate",
      evidence_tier: "source_observed",
      thumbnail_state: "not_provided",
  }]);

  const snapshot = new BuildRoom({ catalogProjection: () => catalog.buildRoomInventoryProjection() }).submit({ prompt: "Show catalog projection" });
  assert.deepEqual(snapshot.topology.catalog.seeded_entries, { count: 1, evidence: "local_sqlite_query" });
  assert.equal(snapshot.topology.catalog.inventory_preview.items[0].thumbnail_state, "not_provided");

  const second = structuredClone(input);
  second.revision = 2;
  second.items[0].catalog_revision = 2;
  second.items[0].source.sha256 = sha256("second explicit fixture source");
  const revised = importCatalogSeedManifest({ catalog, manifest: second, providedFiles: new Map([["fixture://host/scout.mesh", Buffer.from("second explicit fixture source")]]) });
  assert.equal(revised.imported[0].revision, 2);
  assert.equal(catalog.getAsset(deriveCatalogStableId("asset", "host-scout-mesh"), 1).revision, 1);
  catalog.close();
});

test("validation failures are returned before writes and unsupported evidence upgrades cannot be fabricated", () => {
  const catalog = createSqliteCatalog();
  const claimedObserved = manifest();
  claimedObserved.items[0].evidence = { tier: "source_observed" };
  const inspection = inspectCatalogSeedManifest(claimedObserved);
  assert.equal(inspection.valid, false);
  assert.match(inspection.failures[0].message, /explicit provided file/i);
  assert.throws(() => importCatalogSeedManifest({ catalog, manifest: claimedObserved }), CatalogSeedValidationError);
  assert.equal(catalog.getAsset(deriveCatalogStableId("asset", "host-scout-mesh")), undefined);

  const playerClaim = manifest();
  playerClaim.items[0].runtime = { format: "unity-assetbundle", format_state: "accepted", artifact: { locator: "fixture://host/scout.bundle", sha256: sha256("bundle"), media_type: "application/octet-stream" } };
  playerClaim.items[0].evidence = { tier: "player_proven" };
  assert.equal(inspectCatalogSeedManifest(playerClaim, { providedFiles: new Map([["fixture://host/scout.mesh", sourceBytes], ["fixture://host/scout.bundle", Buffer.from("bundle")]]) }).valid, false);

  const acceptedWithoutBytes = manifest();
  acceptedWithoutBytes.items[0].runtime = { format: "unity-assetbundle", format_state: "accepted", artifact: { locator: "fixture://host/scout.bundle", sha256: sha256("bundle"), media_type: "application/octet-stream" }, acceptance: { accepted_by: "host-import", accepted_at: "2026-09-08T13:00:00.000Z", host_build: "host-1" } };
  assert.equal(inspectCatalogSeedManifest(acceptedWithoutBytes).valid, false);

  const contradictoryEvidence = manifest();
  contradictoryEvidence.items[0].evidence = { tier: "source_declared", player_evidence: { observer: "test", observed_at: "2026-09-08T13:00:00.000Z", session_locator: "fixture://player/session", assertion_sha256: "c".repeat(64) } };
  const contradiction = inspectCatalogSeedManifest(contradictoryEvidence);
  assert.equal(contradiction.valid, false);
  assert.match(contradiction.failures.at(-1).message, /only for player_proven/);
  catalog.close();
});

test("the importer preflights every catalog revision and leaves no partial manifest write", () => {
  const catalog = createSqliteCatalog();
  importCatalogSeedManifest({ catalog, manifest: manifest(), providedFiles: new Map([["fixture://host/scout.mesh", sourceBytes]]) });
  const mixed = manifest({ revision: 2 });
  mixed.items[0].catalog_revision = 2;
  mixed.items[0].source.sha256 = sha256("updated source");
  mixed.items.push({ ...structuredClone(mixed.items[0]), stable_key: "invalid-new-item", catalog_revision: 2 });
  assert.throws(() => importCatalogSeedManifest({ catalog, manifest: mixed, providedFiles: new Map([["fixture://host/scout.mesh", Buffer.from("updated source")]]) }), /catalog_revision must be 1/);
  assert.equal(catalog.getAsset(deriveCatalogStableId("asset", "host-scout-mesh")).revision, 1);
  assert.equal(catalog.getAsset(deriveCatalogStableId("asset", "invalid-new-item")), undefined);
  catalog.close();
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
