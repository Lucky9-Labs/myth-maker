const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;

/**
 * Emit one generic v1 animation-lane candidate from a v1 work order. Catalog
 * selection and recipe emission are independent of encounter genre or scale;
 * callers supply the query, v1 binding requirements, provides, and fallback.
 */
export function emitAnimationCandidate({
  work_order,
  selection,
  query,
  bindings,
  provides = undefined,
  fallback = {},
  worker_id = "animation-worker",
  occurred_at = "2026-09-08T00:00:00.000Z",
} = {}) {
  assertWorkOrder(work_order);
  assertQuery(query);
  assertSelection(selection);
  assertBindings(bindings, selection, query);
  assertWorkerIds({ encounter_id: work_order.encounter_id, work_id: work_order.work_id, worker_id });
  if (!validTimestamp(occurred_at)) throw new TypeError("occurred_at must be an ISO-8601 timestamp");
  const selectedProvides = provides ?? work_order.requested_provides;
  if (!validTags(selectedProvides) || selectedProvides.length === 0) throw new TypeError("provides must contain semantic tags");
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) throw new TypeError("fallback must be an object");
  if (fallback.animation_id !== undefined) assertId(fallback.animation_id, "fallback.animation_id");
  if (fallback.module_ids !== undefined && (!Array.isArray(fallback.module_ids) || fallback.module_ids.some((id) => !ID.test(id)))) {
    throw new TypeError("fallback.module_ids must contain stable ids");
  }

  if (selection.used_fallback && selection.entry.animation_id !== fallback.animation_id) {
    throw new TypeError("fallback selection must match fallback.animation_id");
  }
  const module = animationRecipeModule(selection.entry, {
    occurred_at,
    provides: selectedProvides,
    bindings,
    fallback_module_ids: fallback.module_ids || [],
    scale_profile: query.scale_profile,
  });
  const event = (sequence, kind, extra = {}) => ({
    schema_version: "1",
    event_id: `${work_order.work_id}-${sequence}`,
    work_id: work_order.work_id,
    encounter_id: work_order.encounter_id,
    worker_id,
    sequence,
    occurred_at,
    kind,
    ...extra,
  });
  const events = [
    event(0, "accepted", { message: "Animation work accepted." }),
    event(1, "started", { message: "Selecting a compatible animation manifest." }),
    event(2, "progress", { progress: 0.5, message: "Rig, binding, scale, and tags checked." }),
    event(3, "candidate_produced", { module, message: selection.used_fallback ? "Known fallback selected." : "Compatible animation selected." }),
    event(4, "completed", { progress: 1, message: "Animation recipe candidate emitted." }),
  ];
  return deepFreeze({ module, events, selection });
}

/**
 * Synthetic bootstrap proof only. It supplies one small ocean query to the
 * generic emitter and never represents a source asset export or runtime proof.
 */
export function emitSmallOceanFixture({
  catalog,
  encounter_id = "small-ocean-fixture",
  work_id = "small-ocean-animation-work",
  worker_id = "animation-worker",
  occurred_at = "2026-09-08T00:00:00.000Z",
} = {}) {
  const bindings = {
    "animation.rig.rig.ocean.biped.v1": "required",
    "animation.model.binding.ocean.biped.v1": "required",
    "animation.scale.small": "required",
  };
  if (!catalog || typeof catalog.select !== "function") throw new TypeError("catalog.select is required");
  const query = {
    rig_id: "rig.ocean.biped.v1", model_binding_id: "binding.ocean.biped.v1", scale_profile: "small",
    required_tags: ["locomotion.swim", "attack.pincer", "reaction.stagger"],
  };
  const selection = catalog.select({ ...query, fallback_animation_id: "known-small-ocean-fallback" });
  return emitAnimationCandidate({
    work_order: {
      schema_version: "1",
      work_id,
      encounter_id,
      lane: "animation.lane",
      deadline_at: occurred_at,
      requested_provides: ["animation.small.ocean"],
      host_capabilities: {
        schema_version: "1", host_id: "synthetic-host", host_build: "0", platform: "synthetic",
        scripting_backend: "il2cpp", execution_kinds: ["recipe"], loaders: Object.keys(bindings), contracts: [],
        limits: { memory_mb: 1, preload_seconds: 0 },
      },
      input_module_ids: [],
      attempt: 1,
    },
    selection,
    query,
    bindings,
    fallback: { animation_id: "known-small-ocean-fallback" },
    worker_id,
    occurred_at,
  });
}

function animationRecipeModule(entry, { occurred_at, provides, bindings, fallback_module_ids, scale_profile }) {
  return {
    schema_version: "1",
    module_id: entry.animation_id,
    revision: entry.revision,
    execution_kind: "recipe",
    provides,
    requires: [],
    conflicts: [],
    compatibility: { host_contract_version: "1", bindings },
    quality: { tier: 0, score: entry.quality_score },
    inline_recipe: {
      recipe_kind: entry.kind,
      animation_id: entry.animation_id,
      animation_revision: entry.revision,
      rig_id: entry.rig_id,
      model_binding_id: entry.model_binding_id,
      duration_seconds: entry.duration_seconds,
      scale_profiles: entry.scale_profiles,
      selected_scale_profile: scale_profile,
      tags: entry.tags,
      source: entry.kind === "preloaded_clip" ? entry.clip : entry.recipe,
    },
    fallback_module_ids,
    provenance: { producer: "animation-worker", created_at: occurred_at, label: entry.provenance.label },
  };
}

function assertWorkOrder(workOrder) {
  const fields = new Set(["schema_version", "work_id", "encounter_id", "lane", "deadline_at", "requested_provides", "host_capabilities", "input_module_ids", "depends_on_work_ids", "resource_leases", "attempt", "instruction"]);
  const required = ["schema_version", "work_id", "encounter_id", "lane", "deadline_at", "requested_provides", "host_capabilities", "input_module_ids", "attempt"];
  if (!workOrder || typeof workOrder !== "object" || Array.isArray(workOrder)
    || Object.keys(workOrder).some((key) => !fields.has(key)) || required.some((key) => !(key in workOrder))) {
    throw new TypeError("work_order must match the v1 EncounterWorkOrder fields");
  }
  if (workOrder.schema_version !== "1" || !TAG.test(workOrder.lane) || !validTimestamp(workOrder.deadline_at)) {
    throw new TypeError("work_order must match the v1 EncounterWorkOrder fields");
  }
  assertWorkerIds({ encounter_id: workOrder.encounter_id, work_id: workOrder.work_id, worker_id: "animation-worker" });
  if (!validTags(workOrder.requested_provides) || workOrder.requested_provides.length === 0) throw new TypeError("work_order.requested_provides must contain semantic tags");
  if (!validIds(workOrder.input_module_ids) || (workOrder.depends_on_work_ids !== undefined && !validIds(workOrder.depends_on_work_ids))
    || (workOrder.resource_leases !== undefined && !validTags(workOrder.resource_leases))
    || !Number.isInteger(workOrder.attempt) || workOrder.attempt < 1
    || (workOrder.instruction !== undefined && (typeof workOrder.instruction !== "string" || workOrder.instruction.length > 16000))) {
    throw new TypeError("work_order must match the v1 EncounterWorkOrder fields");
  }
  assertHostCapabilities(workOrder.host_capabilities);
}

function assertQuery(query) {
  if (!query || typeof query !== "object") throw new TypeError("query is required");
  for (const key of ["rig_id", "model_binding_id", "scale_profile"]) {
    if (!TAG.test(query[key] || "")) throw new TypeError(`query.${key} must be a semantic tag`);
  }
  if (!validTags(query.required_tags || [])) throw new TypeError("query.required_tags must contain semantic tags");
  if (query.functional_tags !== undefined && !validTags(query.functional_tags)) throw new TypeError("query.functional_tags must contain semantic tags");
  if (query.aesthetic_tags !== undefined && !validTags(query.aesthetic_tags)) throw new TypeError("query.aesthetic_tags must contain semantic tags");
}

function assertSelection(selection) {
  const entry = selection?.entry;
  if (!selection || typeof selection !== "object" || typeof selection.used_fallback !== "boolean" || !entry || typeof entry !== "object") {
    throw new TypeError("selection must contain an animation entry and fallback state");
  }
  assertId(entry.animation_id, "selection.entry.animation_id");
  if (!Number.isInteger(entry.revision) || entry.revision < 1 || !new Set(["preloaded_clip", "procedural_recipe"]).has(entry.kind)
    || !TAG.test(entry.rig_id || "") || !TAG.test(entry.model_binding_id || "") || !Number.isFinite(entry.duration_seconds) || entry.duration_seconds < 0
    || !validTags(entry.scale_profiles) || entry.scale_profiles.length === 0 || !Number.isFinite(entry.quality_score) || entry.quality_score < 0
    || !entry.provenance || typeof entry.provenance.producer !== "string" || typeof entry.provenance.label !== "string" || entry.provenance.label.length > 128
    || !validTimestamp(entry.provenance.imported_at) || entry.acceptance_state !== "accepted") {
    throw new TypeError("selection.entry must be a valid animation manifest");
  }
  if (!entry.tags || !validTags(entry.tags.locomotion) || !validTags(entry.tags.attack) || !validTags(entry.tags.reaction)) {
    throw new TypeError("selection.entry must define locomotion, attack, and reaction tags");
  }
  if ((entry.kind === "preloaded_clip" && (!entry.clip || typeof entry.clip.clip_id !== "string" || typeof entry.clip.preload_key !== "string"))
    || (entry.kind === "procedural_recipe" && (!entry.recipe || typeof entry.recipe !== "object" || Array.isArray(entry.recipe)))) {
    throw new TypeError("selection.entry must carry its declared execution payload");
  }
}

function assertBindings(bindings, selection, query) {
  const { entry } = selection;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) || Object.keys(bindings).length === 0) {
    throw new TypeError("bindings must be a non-empty object");
  }
  for (const [key, value] of Object.entries(bindings)) {
    if (!TAG.test(key) || typeof value !== "string" || value.length === 0 || value.length > 128) {
      throw new TypeError("bindings must map semantic tags to v1 binding values");
    }
  }
  for (const key of [`animation.rig.${entry.rig_id}`, `animation.model.${entry.model_binding_id}`, `animation.scale.${query.scale_profile}`]) {
    if (!(key in bindings)) throw new TypeError(`bindings must cover ${key}`);
  }
  const entryTags = new Set([...entry.tags.locomotion, ...entry.tags.attack, ...entry.tags.reaction, ...(entry.functional_tags || [])]);
  if (entry.rig_id !== query.rig_id || entry.model_binding_id !== query.model_binding_id
    || !entry.scale_profiles.includes(query.scale_profile)
    || (!selection.used_fallback && query.required_tags.some((tag) => !entryTags.has(tag)))) {
    throw new TypeError("selection.entry must satisfy the emitted query");
  }
}

function assertHostCapabilities(host) {
  const fields = new Set(["schema_version", "host_id", "host_build", "platform", "scripting_backend", "execution_kinds", "loaders", "contracts", "limits"]);
  const required = [...fields];
  if (!host || typeof host !== "object" || Array.isArray(host) || Object.keys(host).some((key) => !fields.has(key)) || required.some((key) => !(key in host))
    || host.schema_version !== "1" || !ID.test(host.host_id || "") || typeof host.host_build !== "string" || host.host_build.length === 0 || host.host_build.length > 128
    || typeof host.platform !== "string" || host.platform.length === 0 || host.platform.length > 64 || !["mono", "il2cpp"].includes(host.scripting_backend)
    || !Array.isArray(host.execution_kinds) || host.execution_kinds.length === 0 || new Set(host.execution_kinds).size !== host.execution_kinds.length
    || host.execution_kinds.some((kind) => !["recipe", "runtime_asset", "managed_plugin", "remote_logic"].includes(kind))
    || !validTags(host.loaders) || !validContracts(host.contracts)) {
    throw new TypeError("host_capabilities must match the v1 HostCapabilityManifest fields");
  }
  const limits = host.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || Object.keys(limits).some((key) => !["memory_mb", "preload_seconds", "artifact_bytes", "actors"].includes(key))
    || !Number.isInteger(limits.memory_mb) || limits.memory_mb < 1 || !Number.isInteger(limits.preload_seconds) || limits.preload_seconds < 0
    || (limits.artifact_bytes !== undefined && (!Number.isInteger(limits.artifact_bytes) || limits.artifact_bytes < 0))
    || (limits.actors !== undefined && (!Number.isInteger(limits.actors) || limits.actors < 1))) {
    throw new TypeError("host_capabilities must match the v1 HostCapabilityManifest fields");
  }
}

function validTags(value) { return Array.isArray(value) && new Set(value).size === value.length && value.every((tag) => TAG.test(tag)); }
function validIds(value) { return Array.isArray(value) && new Set(value).size === value.length && value.every((id) => ID.test(id)); }
function validContracts(value) { return Array.isArray(value) && new Set(value).size === value.length && value.every((contract) => /^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$/.test(contract)); }
function assertId(value, name) { if (!ID.test(value || "")) throw new TypeError(`${name} must be a stable id`); }
function assertWorkerIds({ encounter_id, work_id, worker_id }) {
  for (const [name, value] of Object.entries({ encounter_id, work_id, worker_id })) assertId(value, name);
  if (work_id.length > 61) throw new TypeError("work_id must leave room for worker event sequence IDs");
}
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
