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
    schema_version: "1",
    encounter_id: spec.encounter_id,
    deadline_at: spec.deadline_at,
    host_capabilities: structuredClone(spec.host_capabilities),
    input_module_ids: [],
    attempt: spec.attempt || 1,
  };
  const lanes = [
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

  return deepFreeze({
    schema_version: "1",
    encounter_id: spec.encounter_id,
    work_orders: [...roots, validation],
  });
}

export function assertEncounterWorkGraph(graph) {
  if (!graph || graph.schema_version !== "1" || !ID.test(graph.encounter_id)
      || !Array.isArray(graph.work_orders) || graph.work_orders.length === 0) {
    throw new TypeError("work graph must contain v1 work orders for one encounter");
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

/** Validate one published v1 work order at an external-dispatch boundary. */
export function assertEncounterWorkOrder(order) {
  if (!order || !ID.test(order.encounter_id)) {
    throw new TypeError("work order must name a v1 encounter");
  }
  assertWorkOrder(order, order.encounter_id);
  return order;
}

function assertEncounterSpec(spec) {
  if (!spec || spec.schema_version !== "1" || !ID.test(spec.encounter_id)
      || !Number.isInteger(spec.seed) || spec.seed < 0 || (spec.attempt !== undefined && (!Number.isInteger(spec.attempt) || spec.attempt < 1)) || !validTimestamp(spec.deadline_at)
      || !validCapabilities(spec.host_capabilities) || !spec.objective || !SEMANTIC_TAG.test(spec.objective.kind)
      || !spec.arena_envelope || !Array.isArray(spec.desired_roles) || spec.desired_roles.length === 0
      || !uniqueTags(spec.desired_roles)) {
    throw new TypeError("planner requires an EncounterSpec-compatible v1 request");
  }
}

function assertWorkOrder(order, encounterId) {
  const required = ["schema_version", "work_id", "encounter_id", "lane", "deadline_at", "requested_provides", "host_capabilities", "input_module_ids", "attempt"];
  if (!order || Object.keys(order).some((key) => !new Set([...required, "depends_on_work_ids", "resource_leases", "instruction"]).has(key))
      || required.some((key) => !(key in order)) || order.schema_version !== "1"
      || !ID.test(order.work_id) || order.encounter_id !== encounterId || !SEMANTIC_TAG.test(order.lane)
      || !validTimestamp(order.deadline_at) || !Array.isArray(order.requested_provides) || order.requested_provides.length === 0
      || !uniqueTags(order.requested_provides) || !validCapabilities(order.host_capabilities)
      || !Array.isArray(order.input_module_ids) || !order.input_module_ids.every((id) => ID.test(id))
      || !Number.isInteger(order.attempt) || order.attempt < 1) {
    throw new TypeError("work order does not match the v1 dispatcher shape");
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
}

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
