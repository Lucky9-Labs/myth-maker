const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const ACCEPTANCE_STATES = new Set(["candidate", "accepted", "rejected"]);
const KINDS = new Set(["preloaded_clip", "procedural_recipe"]);

/**
 * Storage boundary for animation manifests. Until the shared catalog is
 * available, this adapter keeps the local manifest store replaceable.
 */
export class InMemoryAnimationCatalogAdapter {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
    this.revisions = new Map();
    for (const entry of entries) this.publish(entry);
  }

  publish(entry) {
    assertAnimationEntry(entry);
    const key = revisionKey(entry.animation_id, entry.revision);
    if (this.revisions.has(key)) throw new TypeError(`animation revision ${key} already exists`);
    const latest = this.latestRevision(entry.animation_id);
    if ((!latest && entry.revision !== 1) || (latest && entry.revision !== latest.revision + 1)) {
      throw new TypeError(`animation revision ${entry.animation_id}@${entry.revision} must follow the current revision`);
    }
    const snapshot = deepFreeze(clone(entry));
    this.revisions.set(key, snapshot);
    return snapshot;
  }

  getAnimationRevision(animationId, revision) {
    assertId(animationId, "animation_id");
    if (!Number.isInteger(revision) || revision < 1) throw new TypeError("revision must be a positive integer");
    return this.revisions.get(revisionKey(animationId, revision));
  }

  listAnimationEntries() {
    return [...this.revisions.values()];
  }

  latestRevision(animationId) {
    return [...this.revisions.values()].filter((entry) => entry.animation_id === animationId)
      .sort((left, right) => right.revision - left.revision)[0];
  }
}

/**
 * Queries accepted immutable animation revisions. The optional sharedCatalog
 * takes precedence through the published planner port
 * `findCompatibleParts({ host, functionalTags, aestheticTags, rigBindingId })`.
 * Local storage remains behind the adapter until that port is available.
 */
export class AnimationCatalog {
  constructor({ adapter, sharedCatalog = undefined } = {}) {
    if (!adapter || typeof adapter.listAnimationEntries !== "function"
      || typeof adapter.publish !== "function" || typeof adapter.getAnimationRevision !== "function") {
      throw new TypeError("adapter must implement animation catalog storage methods");
    }
    if (sharedCatalog !== undefined && typeof sharedCatalog.findCompatibleParts !== "function") {
      throw new TypeError("sharedCatalog must implement findCompatibleParts");
    }
    this.adapter = adapter;
    this.sharedCatalog = sharedCatalog;
  }

  publish(entry) {
    return this.adapter.publish(entry);
  }

  getRevision(animationId, revision) {
    return this.adapter.getAnimationRevision(animationId, revision);
  }

  select({
    host = undefined,
    rig_id,
    model_binding_id = undefined,
    scale_profile,
    required_tags = [],
    functional_tags = undefined,
    aesthetic_tags = [],
    fallback_animation_id = undefined,
  }) {
    if (typeof rig_id !== "string" || !TAG.test(rig_id)) throw new TypeError("rig_id must be a semantic tag");
    if (model_binding_id !== undefined && (typeof model_binding_id !== "string" || !TAG.test(model_binding_id))) {
      throw new TypeError("model_binding_id must be a semantic tag");
    }
    if (typeof scale_profile !== "string" || !TAG.test(scale_profile)) throw new TypeError("scale_profile must be a semantic tag");
    if (!validTags(required_tags)) throw new TypeError("required_tags must contain unique semantic tags");
    if (functional_tags !== undefined && !validTags(functional_tags)) throw new TypeError("functional_tags must contain unique semantic tags");
    if (!validTags(aesthetic_tags)) throw new TypeError("aesthetic_tags must contain unique semantic tags");
    if (fallback_animation_id !== undefined) assertId(fallback_animation_id, "fallback_animation_id");

    const query = { host, rig_id, model_binding_id, scale_profile, required_tags, functional_tags, aesthetic_tags };
    const entries = latestAcceptedRevisions(this.readEntries(query));
    const fallback = fallback_animation_id === undefined ? undefined
      : latestAcceptedRevisions(this.readEntries({ ...query, functional_tags: [`scale.${scale_profile}`], aesthetic_tags: [] }))
        .find((entry) => entry.animation_id === fallback_animation_id);
    const candidates = entries.filter((entry) => entry.animation_id !== fallback_animation_id);
    const rejections = [];
    const compatible = [];

    for (const entry of candidates) {
      const reason = incompatibilityReason(entry, { rig_id, model_binding_id, scale_profile, required_tags });
      if (reason) rejections.push({ animation_id: entry.animation_id, revision: entry.revision, reason });
      else compatible.push(entry);
    }

    compatible.sort(compareEntries);
    if (compatible.length > 0) {
      return deepFreeze({ entry: compatible[0], used_fallback: false, rejections: sortRejections(rejections) });
    }

    if (fallback) {
      const fallbackReason = incompatibilityReason(fallback, {
        rig_id, model_binding_id, scale_profile, required_tags: [],
      });
      if (!fallbackReason) {
        return deepFreeze({ entry: fallback, used_fallback: true, rejections: sortRejections(rejections) });
      }
      throw new TypeError(`fallback animation ${fallback_animation_id} is incompatible: ${fallbackReason}`);
    }
    throw new TypeError("no compatible accepted animation entry and no usable fallback");
  }

  readEntries(query) {
    let entries;
    if (this.sharedCatalog) {
      if (!query.host || typeof query.host !== "object") throw new TypeError("host is required for shared catalog queries");
      const functionalTags = query.functional_tags ?? query.required_tags;
      const scaleTag = `scale.${query.scale_profile}`;
      if (!functionalTags.includes(scaleTag)) {
        throw new TypeError(`shared catalog functional_tags must include ${scaleTag}`);
      }
      const parts = this.sharedCatalog.findCompatibleParts({
        host: query.host,
        functionalTags,
        aestheticTags: query.aesthetic_tags,
        rigBindingId: query.rig_id,
      });
      if (!parts || !Array.isArray(parts.animations)) throw new TypeError("shared catalog must return animation parts");
      entries = parts.animations.map((record) => sharedAnimationEntry(record, query.scale_profile));
    } else {
      entries = this.adapter.listAnimationEntries();
    }
    if (!Array.isArray(entries)) throw new TypeError("animation catalog must return an array");
    for (const entry of entries) assertAnimationEntry(entry);
    // A shared catalog owns its records. Selection must not freeze or retain a
    // provider-owned object, so every read becomes this catalog's immutable
    // point-in-time manifest snapshot.
    return entries.map((entry) => deepFreeze(clone(entry)));
  }
}

function latestAcceptedRevisions(entries) {
  const latest = new Map();
  for (const entry of entries) {
    if (entry.acceptance_state !== "accepted") continue;
    const current = latest.get(entry.animation_id);
    if (!current || entry.revision > current.revision) latest.set(entry.animation_id, entry);
  }
  return [...latest.values()];
}

function incompatibilityReason(entry, query) {
  if (entry.acceptance_state !== "accepted") return `acceptance state ${entry.acceptance_state}`;
  if (entry.rig_id !== query.rig_id) return "rig_id mismatch";
  if (query.model_binding_id !== undefined && entry.model_binding_id !== query.model_binding_id) {
    return "model_binding_id mismatch";
  }
  if (!entry.scale_profiles.includes(query.scale_profile)) return `unsupported scale profile ${query.scale_profile}`;
  const tags = new Set([...Object.values(entry.tags).flat(), ...(entry.functional_tags || [])]);
  const missing = query.required_tags.find((tag) => !tags.has(tag));
  if (missing) return `missing required tag ${missing}`;
  return undefined;
}

function compareEntries(left, right) {
  if (left.quality_score !== right.quality_score) return right.quality_score - left.quality_score;
  if (left.revision !== right.revision) return right.revision - left.revision;
  return left.animation_id.localeCompare(right.animation_id);
}

function sortRejections(rejections) {
  return rejections.sort((left, right) => left.animation_id.localeCompare(right.animation_id)
    || left.revision - right.revision || left.reason.localeCompare(right.reason));
}

function assertAnimationEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("animation entry must be an object");
  assertId(entry.animation_id, "animation_id");
  if (!Number.isInteger(entry.revision) || entry.revision < 1) throw new TypeError("revision must be a positive integer");
  if (!KINDS.has(entry.kind)) throw new TypeError("kind must be preloaded_clip or procedural_recipe");
  if (typeof entry.rig_id !== "string" || !TAG.test(entry.rig_id)) throw new TypeError("rig_id must be a semantic tag");
  if (typeof entry.model_binding_id !== "string" || !TAG.test(entry.model_binding_id)) {
    throw new TypeError("model_binding_id must be a semantic tag");
  }
  if (!Number.isFinite(entry.duration_seconds) || entry.duration_seconds < 0) throw new TypeError("duration_seconds must be non-negative");
  if (!entry.tags || typeof entry.tags !== "object" || Array.isArray(entry.tags)
    || !validTags(entry.tags.locomotion) || !validTags(entry.tags.attack) || !validTags(entry.tags.reaction)) {
    throw new TypeError("tags must define locomotion, attack, and reaction semantic-tag arrays");
  }
  if (entry.functional_tags !== undefined && !validTags(entry.functional_tags)) {
    throw new TypeError("functional_tags must contain semantic tags");
  }
  if (!validTags(entry.scale_profiles) || entry.scale_profiles.length === 0) throw new TypeError("scale_profiles must contain semantic tags");
  if (!Number.isFinite(entry.quality_score) || entry.quality_score < 0) throw new TypeError("quality_score must be non-negative");
  if (!entry.provenance || typeof entry.provenance !== "object"
    || typeof entry.provenance.producer !== "string" || entry.provenance.producer.length === 0
    || typeof entry.provenance.label !== "string" || entry.provenance.label.length === 0 || entry.provenance.label.length > 128
    || !validTimestamp(entry.provenance.imported_at)) {
    throw new TypeError("provenance requires producer, label, and imported_at");
  }
  if (!ACCEPTANCE_STATES.has(entry.acceptance_state)) throw new TypeError("invalid acceptance_state");
  if (entry.kind === "preloaded_clip" && (!entry.clip || typeof entry.clip.clip_id !== "string" || entry.clip.clip_id.length === 0
    || typeof entry.clip.preload_key !== "string" || entry.clip.preload_key.length === 0)) {
    throw new TypeError("preloaded_clip requires clip_id (the clip name) and preload_key");
  }
  if (entry.kind === "procedural_recipe" && (!entry.recipe || typeof entry.recipe !== "object" || Array.isArray(entry.recipe))) {
    throw new TypeError("procedural_recipe requires recipe");
  }
}

function sharedAnimationEntry(record, scaleProfile) {
  if (!record || typeof record !== "object") throw new TypeError("shared animation record must be an object");
  const functionalTags = record.functionalTags;
  if (!validTags(functionalTags) || !validTags(record.aestheticTags || [])) {
    throw new TypeError("shared animation record must contain semantic tags");
  }
  const kind = record.kind === "clip" ? "preloaded_clip" : record.kind === "recipe" ? "procedural_recipe" : undefined;
  const category = (prefix) => functionalTags.filter((tag) => tag.startsWith(prefix));
  return {
    animation_id: record.animationId,
    revision: record.revision,
    kind,
    rig_id: record.rigBinding?.rigBindingId,
    model_binding_id: record.rigBinding?.modelBindingId,
    duration_seconds: record.durationMs / 1000,
    tags: { locomotion: category("locomotion."), attack: category("attack."), reaction: category("reaction.") },
    functional_tags: functionalTags,
    scale_profiles: [scaleProfile],
    quality_score: 0,
    provenance: {
      producer: record.provenance?.producer,
      label: record.provenance?.label,
      imported_at: record.provenance?.createdAt,
    },
    acceptance_state: record.runtimeAcceptanceState,
    clip: record.kind === "clip" ? { clip_id: record.animationId, preload_key: record.runtimeArtifact?.uri } : undefined,
    recipe: record.kind === "recipe" ? record.recipe : undefined,
  };
}

function validTags(value) {
  return Array.isArray(value) && new Set(value).size === value.length
    && value.every((tag) => typeof tag === "string" && TAG.test(tag));
}

function assertId(value, name) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${name} must be a stable id`);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function revisionKey(animationId, revision) {
  return `${animationId}@${revision}`;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
