import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const schema = readFileSync(new URL("../db/migrations/001_catalog_v0.sql", import.meta.url), "utf8");
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_STATES = new Set(["recorded", "accepted", "rejected"]);
const RUNTIME_STATES = new Set(["candidate", "accepted", "rejected"]);
const ANIMATION_KINDS = new Set(["clip", "recipe"]);
const PARENT_DOMAINS = new Set(["semantic_entity", "asset", "animation"]);

/**
 * The internal V0 catalog port. This adapter is intentionally the only place
 * that knows SQLite. A PostgreSQL/Railway adapter can implement these same
 * methods against the included portable migration without changing planners.
 */
export function createSqliteCatalog({ filename = ":memory:" } = {}) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);

  const catalog = {
    bootstrapOceanEncounter() {
      transaction(() => {
        if (getRevision("semantic_entity_revisions", "entity_id", "brine-stalker", 1)) return;
        insertEntity(oceanEntity());
        insertEntity(playerProxy());
        insertAsset(oceanShell());
        insertAnimation(oceanLunge());
      });
    },
    appendSemanticEntityRevision(record) {
      return transaction(() => appendRevision("semantic_entity_revisions", "entity_id", "entityId", "semantic_entity", normalizeEntity(record), insertEntity));
    },
    appendAssetRevision(record) {
      return transaction(() => appendRevision("asset_revisions", "asset_id", "assetId", "asset", normalizeAsset(record), insertAsset));
    },
    /** Persist the first immutable revision for a newly-produced asset. */
    createAsset(record) {
      return transaction(() => {
        const normalized = normalizeAsset(record);
        if (normalized.revision !== 1) throw new TypeError("new asset must start at revision 1");
        if (getRecord("asset_revisions", "asset_id", "assetId", normalized.assetId)) {
          throw new TypeError(`assetId ${normalized.assetId} already exists`);
        }
        return insertAsset(normalized);
      });
    },
    appendAnimationRevision(record) {
      return transaction(() => appendRevision("animation_revisions", "animation_id", "animationId", "animation", normalizeAnimation(record), insertAnimation));
    },
    getSemanticEntity(entityId, revision = undefined) {
      return getRecord("semantic_entity_revisions", "entity_id", "entityId", entityId, revision);
    },
    getAsset(assetId, revision = undefined) {
      return getRecord("asset_revisions", "asset_id", "assetId", assetId, revision);
    },
    getAnimation(animationId, revision = undefined) {
      return getRecord("animation_revisions", "animation_id", "animationId", animationId, revision);
    },
    getEntityGraph(entityId, revision = undefined) {
      const entity = catalog.getSemanticEntity(entityId, revision);
      if (!entity) return undefined;
      const relations = db.prepare(
        "SELECT relation_type, target_entity_id FROM semantic_entity_relations WHERE entity_id = ? AND entity_revision = ? ORDER BY relation_type, target_entity_id",
      ).all(entityId, entity.revision).map(({ relation_type, target_entity_id }) => ({
        relation: relation_type, targetEntityId: target_entity_id,
      }));
      return { ...entity, relationships: relations };
    },
    findCompatibleParts({ host, functionalTags = [], aestheticTags = [], rigBindingId = undefined } = {}) {
      validateHost(host);
      validateTags(functionalTags, "functionalTags");
      validateTags(aestheticTags, "aestheticTags");
      return {
        assets: newestCompatibleRecords("asset_revisions", "asset_id", "assetId", host, functionalTags, aestheticTags, rigBindingId),
        animations: newestCompatibleRecords("animation_revisions", "animation_id", "animationId", host, functionalTags, aestheticTags, rigBindingId),
      };
    },
    recordHitEvidence(input) {
      const evidence = normalizeEvidence(input);
      db.prepare(
        "INSERT INTO encounter_evidence_projection (evidence_id, encounter_id, occurred_at, observer, actor_entity_id, target_entity_id, effect_tag, payload_sha256, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(evidence.evidenceId, evidence.encounterId, evidence.occurredAt, evidence.observer, evidence.actorEntityId,
        evidence.targetEntityId, evidence.effectTag, evidence.payloadSha256, stringify(evidence.payload));
      return evidence;
    },
    listEncounterEvidence(encounterId) {
      assertId(encounterId, "encounterId");
      return db.prepare(
        "SELECT evidence_id, encounter_id, occurred_at, observer, actor_entity_id, target_entity_id, effect_tag, payload_sha256, payload_json FROM encounter_evidence_projection WHERE encounter_id = ? ORDER BY occurred_at, evidence_id",
      ).all(encounterId).map((row) => ({
        evidenceId: row.evidence_id, encounterId: row.encounter_id, occurredAt: row.occurred_at,
        observer: row.observer, actorEntityId: row.actor_entity_id, targetEntityId: row.target_entity_id,
        effectTag: row.effect_tag, payloadSha256: row.payload_sha256, payload: JSON.parse(row.payload_json),
      }));
    },
    /** Read-only counts for build-room projection through this SQLite port. */
    projectionSummary() {
      return {
        semantic_entities: count("semantic_entity_revisions", "entity_id"),
        assets: count("asset_revisions", "asset_id"),
        animations: count("animation_revisions", "animation_id"),
        semantic_entity_revisions: count("semantic_entity_revisions"),
        asset_revisions: count("asset_revisions"),
        animation_revisions: count("animation_revisions"),
      };
    },
    close() { db.close(); },
  };

  function count(table, distinctColumn = undefined) {
    const expression = distinctColumn ? `COUNT(DISTINCT ${distinctColumn})` : "COUNT(*)";
    return db.prepare(`SELECT ${expression} AS count FROM ${table}`).get().count;
  }

  function transaction(action) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  function insertEntity(record) {
    insertRecord("semantic_entity_revisions", "entity_id", "entityId", record);
    for (const relation of record.relationships) {
      db.prepare("INSERT INTO semantic_entity_relations (entity_id, entity_revision, relation_type, target_entity_id) VALUES (?, ?, ?, ?)")
        .run(record.entityId, record.revision, relation.relation, relation.targetEntityId);
    }
    return record;
  }
  function insertAsset(record) { return insertRecord("asset_revisions", "asset_id", "assetId", record); }
  function insertAnimation(record) { return insertRecord("animation_revisions", "animation_id", "animationId", record); }
  function insertRecord(table, column, property, record) {
    db.prepare(`INSERT INTO ${table} (${column}, revision, content_sha256, created_at, data_json) VALUES (?, ?, ?, ?, ?)`)
      .run(record[property], record.revision, record.contentSha256, record.createdAt, stringify(record));
    return record;
  }
  function appendRevision(table, column, property, domain, record, insert) {
    const previous = getRecord(table, column, property, record[property]);
    if (!previous) throw new TypeError(`${property} ${record[property]} has no revision to append`);
    if (record.revision !== previous.revision) throw new TypeError("append input must carry the current revision");
    assertImmediateParent(record.provenance, domain, record[property], previous);
    const next = finalize({ ...record, revision: previous.revision + 1 });
    return insert(next);
  }
  function getRevision(table, column, id, revision) {
    return db.prepare(`SELECT data_json FROM ${table} WHERE ${column} = ? AND revision = ?`).get(id, revision);
  }
  function getRecord(table, column, property, id, revision) {
    assertId(id, property);
    const row = revision === undefined
      ? db.prepare(`SELECT data_json FROM ${table} WHERE ${column} = ? ORDER BY revision DESC LIMIT 1`).get(id)
      : db.prepare(`SELECT data_json FROM ${table} WHERE ${column} = ? AND revision = ?`).get(id, revision);
    return row ? JSON.parse(row.data_json) : undefined;
  }
  function newestCompatibleRecords(table, column, property, host, functionalTags, aestheticTags, rigBindingId) {
    const selectedIds = new Set();
    return db.prepare(`SELECT data_json FROM ${table} ORDER BY ${column}, revision DESC`).all()
      .map((row) => JSON.parse(row.data_json))
      .filter((record) => compatible(record, host, functionalTags, aestheticTags, rigBindingId))
      .filter((record) => {
        if (selectedIds.has(record[property])) return false;
        selectedIds.add(record[property]);
        return true;
      });
  }
  return catalog;
}

function normalizeEntity(input) {
  const record = clone(input);
  assertId(record.entityId, "entityId");
  assertRevision(record.revision);
  assertTimestamp(record.createdAt, "createdAt");
  nonEmpty(record.kind, "kind");
  validateTags(record.functionalTags, "functionalTags");
  validateTags(record.aestheticTags, "aestheticTags");
  validateTags(record.affordances, "affordances");
  if (!Array.isArray(record.relationships)) throw new TypeError("relationships must be an array");
  for (const relation of record.relationships) { nonEmpty(relation?.relation, "relationship.relation"); assertId(relation?.targetEntityId, "relationship.targetEntityId"); }
  validateProvenance(record.provenance);
  return finalize(record);
}

function normalizeAsset(input) {
  const record = clone(input);
  assertId(record.assetId, "assetId"); assertRevision(record.revision); assertTimestamp(record.createdAt, "createdAt");
  validateTags(record.functionalTags, "functionalTags"); validateTags(record.aestheticTags, "aestheticTags");
  validateProvenance(record.provenance); validateCompatibility(record.compatibility);
  validateSource(record);
  validateRuntimeArtifact(record);
  return finalize(record);
}

function normalizeAnimation(input) {
  const record = clone(input);
  assertId(record.animationId, "animationId"); assertRevision(record.revision); assertTimestamp(record.createdAt, "createdAt");
  if (!ANIMATION_KINDS.has(record.kind)) throw new TypeError("animation kind must be clip or recipe");
  if (!Number.isInteger(record.durationMs) || record.durationMs < 0) throw new TypeError("durationMs must be a non-negative integer");
  validateTags(record.functionalTags, "functionalTags"); validateTags(record.aestheticTags, "aestheticTags");
  validateProvenance(record.provenance); validateCompatibility(record.compatibility); validateSource(record);
  if (!record.rigBinding || typeof record.rigBinding !== "object") throw new TypeError("rigBinding is required");
  nonEmpty(record.rigBinding.rigBindingId, "rigBinding.rigBindingId"); nonEmpty(record.rigBinding.modelBindingId, "rigBinding.modelBindingId");
  if (record.kind === "clip") validateRuntimeArtifact(record);
  else if (!record.recipe || typeof record.recipe !== "object") throw new TypeError("recipe animation requires recipe");
  else if (record.runtimeArtifact !== undefined) validateArtifact(record.runtimeArtifact);
  if (!RUNTIME_STATES.has(record.runtimeAcceptanceState)) throw new TypeError("invalid runtimeAcceptanceState");
  return finalize(record);
}

function finalize(record) {
  const withoutHash = { ...record }; delete withoutHash.contentSha256;
  return { ...withoutHash, contentSha256: sha256(withoutHash) };
}

function compatible(record, host, functionalTags, aestheticTags, rigBindingId) {
  if (record.runtimeAcceptanceState !== "accepted") return false;
  if (record.assetId && !record.runtimeArtifact) return false;
  if (record.kind === "clip" && !record.runtimeArtifact) return false;
  if (record.kind === "recipe" && !record.recipe) return false;
  if (!hasAll(record.functionalTags, functionalTags) || !hasAll(record.aestheticTags, aestheticTags)) return false;
  if (!hasAll(host.loaders, record.compatibility.loaders) || !hasAll(host.contracts, record.compatibility.contracts)) return false;
  if (record.compatibility.platforms.length && !record.compatibility.platforms.includes(host.platform)) return false;
  if (rigBindingId && record.rigBinding?.rigBindingId !== rigBindingId && !record.compatibility.bindingIds.includes(rigBindingId)) return false;
  return true;
}

function normalizeEvidence(input) {
  const record = clone(input);
  assertId(record.evidenceId, "evidenceId"); assertId(record.encounterId, "encounterId"); assertTimestamp(record.occurredAt, "occurredAt");
  nonEmpty(record.observer, "observer"); assertId(record.actorEntityId, "actorEntityId"); assertId(record.targetEntityId, "targetEntityId"); assertTag(record.effectTag, "effectTag");
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new TypeError("payload must be an object");
  return { ...record, payloadSha256: sha256(record.payload) };
}

function validateHost(host) { if (!host || typeof host !== "object") throw new TypeError("host is required"); nonEmpty(host.platform, "host.platform"); if (!Array.isArray(host.loaders) || !Array.isArray(host.contracts)) throw new TypeError("host loaders and contracts are required"); }
function validateCompatibility(value) { if (!value || typeof value !== "object") throw new TypeError("compatibility is required"); for (const field of ["platforms", "loaders", "contracts", "bindingIds"]) if (!Array.isArray(value[field])) throw new TypeError(`compatibility.${field} must be an array`); }
function validateSource(record) {
  if (record.sourceReceipt === undefined) {
    if (record.sourceAcceptanceState !== undefined) throw new TypeError("sourceAcceptanceState requires sourceReceipt");
    return;
  }
  validateReceipt(record.sourceReceipt);
  if (!SOURCE_STATES.has(record.sourceAcceptanceState)) throw new TypeError("invalid sourceAcceptanceState");
}
function validateReceipt(value) { if (!value || typeof value !== "object") throw new TypeError("sourceReceipt is required"); nonEmpty(value.receiptId, "sourceReceipt.receiptId"); nonEmpty(value.uri, "sourceReceipt.uri"); assertHash(value.sha256, "sourceReceipt.sha256"); assertTimestamp(value.receivedAt, "sourceReceipt.receivedAt"); }
function validateArtifact(value) { if (!value || typeof value !== "object") throw new TypeError("runtimeArtifact is required"); nonEmpty(value.uri, "runtimeArtifact.uri"); assertHash(value.sha256, "runtimeArtifact.sha256"); nonEmpty(value.mediaType, "runtimeArtifact.mediaType"); }
function validateRuntimeArtifact(record) {
  if (!RUNTIME_STATES.has(record.runtimeAcceptanceState)) throw new TypeError("invalid runtimeAcceptanceState");
  if (record.runtimeAcceptanceState === "accepted") validateArtifact(record.runtimeArtifact);
  else if (record.runtimeArtifact !== undefined) validateArtifact(record.runtimeArtifact);
}
function validateProvenance(value) {
  if (!value || typeof value !== "object") throw new TypeError("provenance is required");
  nonEmpty(value.producer, "provenance.producer");
  assertTimestamp(value.createdAt, "provenance.createdAt");
  if (value.parentRefs === undefined) return;
  if (!Array.isArray(value.parentRefs)) throw new TypeError("provenance.parentRefs must be an array");
  for (const parent of value.parentRefs) {
    if (!PARENT_DOMAINS.has(parent?.domain)) throw new TypeError("provenance.parentRefs has an unknown domain");
    assertId(parent.stableId, "provenance.parentRefs.stableId");
    assertRevision(parent.revision);
    assertHash(parent.contentSha256, "provenance.parentRefs.contentSha256");
  }
}
function assertImmediateParent(provenance, domain, stableId, previous) {
  const parents = provenance?.parentRefs;
  const matchesPrevious = Array.isArray(parents) && parents.some((parent) => parent.domain === domain
    && parent.stableId === stableId && parent.revision === previous.revision
    && parent.contentSha256 === previous.contentSha256);
  if (!matchesPrevious) throw new TypeError("append requires an exact immediate parent reference");
}
function validateTags(values, label) { if (!Array.isArray(values) || new Set(values).size !== values.length) throw new TypeError(`${label} must be a unique array`); values.forEach((value) => assertTag(value, label)); }
function assertId(value, label) { if (!ID.test(value || "")) throw new TypeError(`${label} must be a stable id`); }
function assertTag(value, label) { if (!TAG.test(value || "")) throw new TypeError(`${label} must contain semantic tags`); }
function assertHash(value, label) { if (!SHA256.test(value || "")) throw new TypeError(`${label} must be sha256`); }
function assertRevision(value) { if (!Number.isInteger(value) || value < 1) throw new TypeError("revision must be positive"); }
function assertTimestamp(value, label) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be ISO-8601`); }
function nonEmpty(value, label) { if (typeof value !== "string" || !value) throw new TypeError(`${label} is required`); }
function hasAll(values, required) { return required.every((value) => values.includes(value)); }
function sha256(value) { return createHash("sha256").update(stringify(value)).digest("hex"); }
function stringify(value) { return JSON.stringify(sortObject(value)); }
function sortObject(value) { if (Array.isArray(value)) return value.map(sortObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])])); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
const fixtureHash = (name) => createHash("sha256").update(`synthetic-ocean-fixture:${name}`).digest("hex");
const base = { createdAt: "2026-09-08T00:00:00.000Z", provenance: { producer: "synthetic-ocean-fixture", createdAt: "2026-09-08T00:00:00.000Z", label: "synthetic; no external export verified" } };
function oceanEntity() { return normalizeEntity({ ...base, entityId: "brine-stalker", revision: 1, kind: "encounter.target", functionalTags: ["combat.target", "body.shell"], aestheticTags: ["aesthetic.alien", "aesthetic.ocean"], affordances: ["combat.lunge", "combat.shield"], relationships: [{ relation: "encounter.opposes", targetEntityId: "player-proxy" }] }); }
function playerProxy() { return normalizeEntity({ ...base, entityId: "player-proxy", revision: 1, kind: "encounter.player", functionalTags: ["combat.player"], aestheticTags: [], affordances: ["combat.damage"], relationships: [] }); }
function sourceReceipt(name) { return { receiptId: `${name}-source-receipt`, uri: `synthetic://ocean-fixture/${name}.source`, sha256: fixtureHash(`${name}:source`), receivedAt: base.createdAt }; }
function runtimeArtifact(name, mediaType) { return { uri: `synthetic://ocean-fixture/${name}.runtime`, sha256: fixtureHash(`${name}:runtime`), mediaType, byteLength: 512 }; }
function compatibility() { return { platforms: ["windows"], loaders: ["rig.aquatic", "collision.default"], contracts: ["combat.target.v1"], bindingIds: ["rig.aquatic.biped.v1"] }; }
function oceanShell() { return normalizeAsset({ ...base, assetId: "ocean-shell", revision: 1, functionalTags: ["body.shell"], aestheticTags: ["aesthetic.alien", "aesthetic.ocean"], compatibility: compatibility(), sourceReceipt: sourceReceipt("ocean-shell"), runtimeArtifact: runtimeArtifact("ocean-shell", "application/vnd.unity.assetbundle"), sourceAcceptanceState: "recorded", runtimeAcceptanceState: "accepted" }); }
function oceanLunge() { return normalizeAnimation({ ...base, animationId: "ocean-lunge", revision: 1, kind: "clip", durationMs: 950, functionalTags: ["combat.lunge", "body.shell"], aestheticTags: ["aesthetic.ocean"], compatibility: compatibility(), rigBinding: { rigBindingId: "rig.aquatic.biped.v1", modelBindingId: "model.brine-stalker.v1" }, sourceReceipt: sourceReceipt("ocean-lunge"), runtimeArtifact: runtimeArtifact("ocean-lunge", "application/vnd.unity.animation"), sourceAcceptanceState: "recorded", runtimeAcceptanceState: "accepted" }); }
