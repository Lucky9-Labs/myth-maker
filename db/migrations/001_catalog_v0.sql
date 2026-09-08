-- V0 is one persistence boundary for semantic entities, source/runtime parts,
-- generic composition modules, and operational evidence projections.
-- TEXT JSON keeps this migration portable to SQLite today and Railway Postgres
-- later; callers only use the Catalog interface, never this SQL directly.
CREATE TABLE IF NOT EXISTS semantic_entity_revisions (
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (entity_id, revision),
  UNIQUE (entity_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS semantic_entity_relations (
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, entity_revision, relation_type, target_entity_id),
  FOREIGN KEY (entity_id, entity_revision)
    REFERENCES semantic_entity_revisions (entity_id, revision)
);

CREATE TABLE IF NOT EXISTS asset_revisions (
  asset_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (asset_id, revision),
  UNIQUE (asset_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS animation_revisions (
  animation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (animation_id, revision),
  UNIQUE (animation_id, content_sha256)
);

-- Generic immutable modules used by the composition coordinator. The catalog,
-- rather than an in-memory coordinator map, owns revision identity.
CREATE TABLE IF NOT EXISTS composition_module_revisions (
  module_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (module_id, revision),
  UNIQUE (module_id, content_sha256)
);

-- This is an operational encounter projection, not a fourth catalog.
CREATE TABLE IF NOT EXISTS encounter_evidence_projection (
  evidence_id TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observer TEXT NOT NULL,
  actor_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  effect_tag TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS asset_revisions_latest ON asset_revisions (asset_id, revision DESC);
CREATE INDEX IF NOT EXISTS animation_revisions_latest ON animation_revisions (animation_id, revision DESC);
CREATE INDEX IF NOT EXISTS composition_module_revisions_latest ON composition_module_revisions (module_id, revision DESC);
CREATE INDEX IF NOT EXISTS encounter_evidence_by_encounter
  ON encounter_evidence_projection (encounter_id, occurred_at, evidence_id);
