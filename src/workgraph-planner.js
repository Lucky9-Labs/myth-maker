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
    attempt: 1,
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

function assertEncounterSpec(spec) {
  if (!spec || spec.schema_version !== "1" || !ID.test(spec.encounter_id)
      || !Number.isInteger(spec.seed) || spec.seed < 0 || !validTimestamp(spec.deadline_at)
      || !spec.host_capabilities || !spec.objective || !SEMANTIC_TAG.test(spec.objective.kind)
      || !spec.arena_envelope || !Array.isArray(spec.desired_roles) || spec.desired_roles.length === 0) {
    throw new TypeError("planner requires an EncounterSpec-compatible v1 request");
  }
}

function assertWorkOrder(order, encounterId) {
  const required = ["schema_version", "work_id", "encounter_id", "lane", "deadline_at", "requested_provides", "host_capabilities", "input_module_ids", "attempt"];
  if (!order || Object.keys(order).some((key) => !new Set([...required, "depends_on_work_ids", "resource_leases", "instruction"]).has(key))
      || required.some((key) => !(key in order)) || order.schema_version !== "1"
      || !ID.test(order.work_id) || order.encounter_id !== encounterId || !SEMANTIC_TAG.test(order.lane)
      || !validTimestamp(order.deadline_at) || !Array.isArray(order.requested_provides) || order.requested_provides.length === 0
      || !order.requested_provides.every((tag) => SEMANTIC_TAG.test(tag))
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
  return `wg-${createHash("sha256").update(`${spec.encounter_id}:${spec.seed}:${lane}`).digest("hex").slice(0, 32)}`;
}

function instructionFor(spec, lane) {
  const roles = [...spec.desired_roles].sort().join(", ");
  return `Propose a ${lane} fragment for objective ${spec.objective.kind}; preserve the declared arena envelope and roles: ${roles}.`;
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
