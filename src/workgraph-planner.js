import { createHash } from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMANTIC_TAG = /^[a-z][a-z0-9_.-]{0,95}$/;

/**
 * Build the small, deterministic work graph used by the dispatcher seam.
 *
 * This is intentionally a plan for generic encounter fragments. The planner
 * has no asset taxonomy or actor-specific branch: callers provide the
 * EncounterSpec, and every lane expresses a v1 `requested_provides` tag.
 */
export function planEncounterWork(spec) {
  assertEncounterSpec(spec);
  const common = {
    schema_version: "2",
    encounter_id: spec.encounter_id,
    deadline_at: spec.deadline_at,
    host_capabilities: structuredClone(spec.host_capabilities),
    input_module_ids: [],
    attempt: spec.attempt || 1,
    production_gate: structuredClone(spec.production_gate),
  };
  const lanes = spec.work_lanes || [
    { lane: "body-source", provides: "encounter.body.source" },
    { lane: "animation-recipe", provides: "encounter.animation.recipe" },
    { lane: "combat-recipe", provides: "encounter.combat.recipe" },
  ];
  const roots = lanes.map(({ lane, provides }) => ({
    ...common,
    work_id: workId(spec, lane),
    lane,
    requested_provides: [provides],
    depends_on_work_ids: [],
    instruction: instructionFor(spec, lane),
  }));
  const validation = {
    ...common,
    work_id: workId(spec, "validation"),
    lane: "validation",
    requested_provides: ["encounter.validation.report"],
    depends_on_work_ids: roots.map((order) => order.work_id),
    instruction: instructionFor(spec, "validation"),
  };

  return deepFreeze(assertEncounterWorkGraph({
    schema_version: "2",
    encounter_id: spec.encounter_id,
    work_orders: [...roots, validation],
  }));
}

export function assertEncounterWorkGraph(graph) {
  if (!graph || graph.schema_version !== "2" || !ID.test(graph.encounter_id)
      || !Array.isArray(graph.work_orders) || graph.work_orders.length === 0) {
    throw new TypeError("work graph must contain v2 work orders for one encounter");
  }
  const ids = new Set();
  for (const order of graph.work_orders) {
    assertWorkOrder(order, graph.encounter_id);
    if (ids.has(order.work_id)) throw new TypeError(`duplicate work_id ${order.work_id}`);
    ids.add(order.work_id);
  }
  for (const order of graph.work_orders) {
    for (const dependency of order.depends_on_work_ids || []) {
      if (!ids.has(dependency)) throw new TypeError(`unknown dependency ${dependency}`);
      if (dependency === order.work_id) throw new TypeError(`work order ${order.work_id} cannot depend on itself`);
    }
  }
  assertAcyclic(graph.work_orders);
  return graph;
}

/** Validate one published v2 work order at an external-dispatch boundary. */
export function assertEncounterWorkOrder(order) {
  if (!order || !ID.test(order.encounter_id)) {
    throw new TypeError("work order must name a v2 encounter");
  }
  assertWorkOrder(order, order.encounter_id);
  return order;
}

function assertEncounterSpec(spec) {
  if (!spec || spec.schema_version !== "2" || !ID.test(spec.encounter_id)
      || !Number.isInteger(spec.seed) || spec.seed < 0 || (spec.attempt !== undefined && (!Number.isInteger(spec.attempt) || spec.attempt < 1)) || !validTimestamp(spec.deadline_at)
      || !validCapabilities(spec.host_capabilities) || !spec.objective || !SEMANTIC_TAG.test(spec.objective.kind)
      || !spec.arena_envelope || !Array.isArray(spec.desired_roles) || spec.desired_roles.length === 0
      || !uniqueTags(spec.desired_roles)) {
    throw new TypeError("planner requires an EncounterSpec-compatible v2 request");
  }
  if (spec.work_lanes !== undefined && !validWorkLanes(spec.work_lanes)) {
    throw new TypeError("planner requires unique generic work lanes");
  }
  if (!validProductionGate(spec.production_gate)) {
    throw new TypeError("planner requires an unexpired compatible production gate");
  }
}

function validWorkLanes(lanes) {
  return Array.isArray(lanes) && lanes.length > 0 && lanes.length <= 32
    && lanes.every((lane) => closedRecord(lane, ["lane", "provides"])
      && SEMANTIC_TAG.test(lane.lane) && SEMANTIC_TAG.test(lane.provides))
    && new Set(lanes.map((lane) => lane.lane)).size === lanes.length
    && new Set(lanes.map((lane) => lane.provides)).size === lanes.length;
}

function assertWorkOrder(order, encounterId) {
  const required = ["schema_version", "work_id", "encounter_id", "lane", "deadline_at", "requested_provides", "host_capabilities", "input_module_ids", "attempt"];
  if (!order || Object.keys(order).some((key) => !new Set([...required, "production_gate", "depends_on_work_ids", "resource_leases", "instruction"]).has(key))
      || required.some((key) => !(key in order)) || order.schema_version !== "2"
      || !ID.test(order.work_id) || order.encounter_id !== encounterId || !SEMANTIC_TAG.test(order.lane)
      || !validTimestamp(order.deadline_at) || !Array.isArray(order.requested_provides) || order.requested_provides.length === 0
      || !uniqueTags(order.requested_provides) || !validCapabilities(order.host_capabilities)
      || !Array.isArray(order.input_module_ids) || !order.input_module_ids.every((id) => ID.test(id))
      || !Number.isInteger(order.attempt) || order.attempt < 1) {
    throw new TypeError("work order does not match the v2 dispatcher shape");
  }
  for (const field of ["requested_provides", "input_module_ids", "depends_on_work_ids", "resource_leases"]) {
    if (field in order && (!Array.isArray(order[field]) || new Set(order[field]).size !== order[field].length)) {
      throw new TypeError(`${field} must be a unique array`);
    }
  }
  if (order.depends_on_work_ids && !order.depends_on_work_ids.every((id) => ID.test(id))) {
    throw new TypeError("depends_on_work_ids must contain v1 IDs");
  }
  if (order.resource_leases && !uniqueTags(order.resource_leases)) {
    throw new TypeError("resource_leases must contain v1 semantic tags");
  }
  if (order.instruction !== undefined && (typeof order.instruction !== "string" || order.instruction.length > 16000)) {
    throw new TypeError("instruction must be a string of at most 16000 characters");
  }
  if (!validProductionGate(order.production_gate, order.requested_provides)) {
    throw new TypeError("work order must carry an unexpired compatible production gate");
  }
}

function validProductionGate(gate, requestedProvides = undefined) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return false;
  if (gate.kind === "concept_lineage") {
    if (!closedRecord(gate, ["kind", "encounter_intent", "art_direction_revision", "concept_reference_revision", "lineage"])
        || !validEncounterIntent(gate.encounter_intent)
        || !validArtDirection(gate.art_direction_revision)
        || !validConceptReference(gate.concept_reference_revision)
        || !validLineage(gate.lineage)) return false;
    return sameReference(gate.art_direction_revision.encounter_intent, referenceOf(gate.encounter_intent, "intent_id"))
      && sameReference(gate.concept_reference_revision.art_direction_revision, referenceOf(gate.art_direction_revision, "art_direction_id"))
      && sameReference(gate.lineage.encounter_intent, referenceOf(gate.encounter_intent, "intent_id"))
      && sameReference(gate.lineage.art_direction_revision, referenceOf(gate.art_direction_revision, "art_direction_id"))
      && sameReference(gate.lineage.concept_reference_revision, referenceOf(gate.concept_reference_revision, "concept_reference_id"));
  }
  if (gate.kind === "reuse_maintenance_waiver") {
    return closedRecord(gate, ["kind", "waiver", "requested_provides"])
      && validReuseMaintenanceWaiver(gate.waiver) && uniqueTags(gate.requested_provides)
      && (requestedProvides === undefined || sameTagSet(gate.requested_provides, requestedProvides));
  }
  if (gate.kind !== "bootstrap_waiver" || !closedRecord(gate, ["kind", "waiver"])) return false;
  const waiver = gate.waiver;
  if (!closedRecord(waiver, ["kind", "bounded_reason", "approver", "approved_at", "expires_at", "requested_provides", "not_concept_compliant"])
      || waiver.kind !== "bootstrap_waiver" || typeof waiver.bounded_reason !== "string" || waiver.bounded_reason.length < 1 || waiver.bounded_reason.length > 512
      || !ID.test(waiver.approver) || !validTimestamp(waiver.approved_at) || !validTimestamp(waiver.expires_at)
      || Date.parse(waiver.approved_at) > Date.parse(waiver.expires_at) || Date.parse(waiver.expires_at) <= Date.now() || !uniqueTags(waiver.requested_provides)
      || waiver.not_concept_compliant !== true) return false;
  return requestedProvides === undefined || sameTagSet(waiver.requested_provides, requestedProvides);
}

function validReuseMaintenanceWaiver(waiver) {
  return closedRecord(waiver, ["kind", "bounded_reason", "approver", "approved_at", "expires_at", "asset_ids"])
    && ["reuse", "maintenance"].includes(waiver.kind)
    && typeof waiver.bounded_reason === "string" && waiver.bounded_reason.length > 0 && waiver.bounded_reason.length <= 512
    && ID.test(waiver.approver) && validTimestamp(waiver.approved_at) && validTimestamp(waiver.expires_at)
    && Date.parse(waiver.approved_at) <= Date.parse(waiver.expires_at) && Date.parse(waiver.expires_at) > Date.now() && Array.isArray(waiver.asset_ids)
    && waiver.asset_ids.length > 0 && new Set(waiver.asset_ids).size === waiver.asset_ids.length && waiver.asset_ids.every((id) => ID.test(id));
}

function validEncounterIntent(record) {
  return closedRecord(record, ["intent_id", "revision", "content_sha256", "player_facing_beat", "constraints"])
    && ID.test(record.intent_id) && positiveInteger(record.revision) && sha256(record.content_sha256)
    && nonEmptyText(record.player_facing_beat) && nonEmptyTextList(record.constraints);
}

function validArtDirection(record) {
  return closedRecord(record, ["art_direction_id", "revision", "content_sha256", "encounter_intent", "player_facing_beat", "silhouette", "scale", "palette_material_cues", "arena_relationship", "animation_combat_beats", "constraints"])
    && ID.test(record.art_direction_id) && positiveInteger(record.revision) && sha256(record.content_sha256)
    && validReference(record.encounter_intent) && ["player_facing_beat", "silhouette", "scale", "palette_material_cues", "arena_relationship"].every((field) => nonEmptyText(record[field]))
    && nonEmptyTextList(record.animation_combat_beats) && nonEmptyTextList(record.constraints);
}

function validConceptReference(record) {
  return closedRecord(record, ["concept_reference_id", "revision", "content_sha256", "mode", "art_direction_revision", "artifact", "interpretation_constraints"])
    && ID.test(record.concept_reference_id) && positiveInteger(record.revision) && sha256(record.content_sha256)
    && ["generated", "selected"].includes(record.mode) && validReference(record.art_direction_revision)
    && closedRecord(record.artifact, ["uri", "sha256", "media_type"]) && typeof record.artifact.uri === "string" && record.artifact.uri.length > 0 && sha256(record.artifact.sha256)
    && nonEmptyText(record.artifact.media_type) && nonEmptyTextList(record.interpretation_constraints);
}

function validLineage(lineage) {
  return closedRecord(lineage, ["kind", "encounter_intent", "art_direction_revision", "concept_reference_revision"])
    && lineage.kind === "concept_lineage" && validReference(lineage.encounter_intent)
    && validReference(lineage.art_direction_revision) && validReference(lineage.concept_reference_revision);
}

function validReference(reference) {
  return closedRecord(reference, ["id", "revision", "content_sha256"])
    && ID.test(reference.id) && positiveInteger(reference.revision) && sha256(reference.content_sha256);
}

function referenceOf(record, idField) {
  return { id: record[idField], revision: record.revision, content_sha256: record.content_sha256 };
}

function sameReference(left, right) {
  return left?.id === right.id && left?.revision === right.revision && left?.content_sha256 === right.content_sha256;
}

function sameTagSet(scope, requested) {
  return requested.every((tag) => scope.includes(tag));
}

function closedRecord(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function positiveInteger(value) { return Number.isInteger(value) && value >= 1; }
function sha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function nonEmptyText(value) { return typeof value === "string" && value.length > 0 && value.length <= 2000; }
function nonEmptyTextList(value) { return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(nonEmptyText); }

function assertAcyclic(orders) {
  const byId = new Map(orders.map((order) => [order.work_id, order]));
  const visiting = new Set();
  const visited = new Set();
  function visit(workId) {
    if (visited.has(workId)) return;
    if (visiting.has(workId)) throw new TypeError("work graph dependencies must be acyclic");
    visiting.add(workId);
    for (const parent of byId.get(workId).depends_on_work_ids || []) visit(parent);
    visiting.delete(workId);
    visited.add(workId);
  }
  for (const order of orders) visit(order.work_id);
}

function workId(spec, lane) {
  return `wg-${createHash("sha256").update(canonicalJson({ spec, lane })).digest("hex").slice(0, 32)}`;
}

function instructionFor(spec, lane) {
  const roles = [...spec.desired_roles].sort().join(", ");
  return `Propose a ${lane} fragment for objective ${spec.objective.kind}; preserve the declared arena envelope and roles: ${roles}.`;
}

function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function uniqueTags(values) {
  return Array.isArray(values) && values.every((value) => SEMANTIC_TAG.test(value))
    && new Set(values).size === values.length;
}

function validCapabilities(value) {
  const fields = new Set(["schema_version", "host_id", "host_build", "platform", "scripting_backend", "execution_kinds", "loaders", "contracts", "limits"]);
  const executions = new Set(["recipe", "runtime_asset", "managed_plugin", "remote_logic"]);
  const contract = /^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$/;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.has(key))
    || value.schema_version !== "1" || !ID.test(value.host_id)
    || typeof value.host_build !== "string" || value.host_build.length < 1 || value.host_build.length > 128
    || typeof value.platform !== "string" || value.platform.length < 1 || value.platform.length > 64
    || !["mono", "il2cpp"].includes(value.scripting_backend)
    || !Array.isArray(value.execution_kinds) || value.execution_kinds.length === 0
    || !value.execution_kinds.every((kind) => executions.has(kind)) || new Set(value.execution_kinds).size !== value.execution_kinds.length
    || !uniqueTags(value.loaders) || !Array.isArray(value.contracts) || !value.contracts.every((name) => contract.test(name))
    || new Set(value.contracts).size !== value.contracts.length) return false;
  const limitFields = new Set(["memory_mb", "preload_seconds", "artifact_bytes", "actors"]);
  const limits = value.limits;
  return Boolean(limits) && typeof limits === "object" && !Array.isArray(limits)
    && Object.keys(limits).every((key) => limitFields.has(key))
    && Number.isInteger(limits.memory_mb) && limits.memory_mb >= 1
    && Number.isInteger(limits.preload_seconds) && limits.preload_seconds >= 0
    && (limits.artifact_bytes === undefined || (Number.isInteger(limits.artifact_bytes) && limits.artifact_bytes >= 0))
    && (limits.actors === undefined || (Number.isInteger(limits.actors) && limits.actors >= 1));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
