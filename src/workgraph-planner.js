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
  const componentGraph = planComponentGraph(spec);
  const roots = componentGraph.components.map((component) => ({
    ...common,
    work_id: workId(spec, component),
    lane: component.lane,
    requested_provides: component.requested_provides,
    depends_on_work_ids: [],
    instruction: instructionFor(spec, component),
  }));
  const assembly = {
    ...common,
    work_id: workId(spec, { lane: "assembly", revision: componentGraph.baseline_id }),
    lane: "assembly",
    requested_provides: ["encounter.assembly.receipt"],
    depends_on_work_ids: roots.map((order) => order.work_id),
    instruction: `Assemble only the declared component revisions or their deterministic fallbacks. ${canonicalJson({ format: "assembly-inputs.v1", baseline_id: componentGraph.baseline_id, component_ids: componentGraph.components.map((component) => component.component_id) })}`,
  };
  const validation = {
    ...common,
    work_id: workId(spec, { lane: "validation", revision: componentGraph.baseline_id }),
    lane: "validation",
    requested_provides: ["encounter.validation.report"],
    depends_on_work_ids: [assembly.work_id],
    instruction: `Validate the assembled encounter inputs and preserve all fallback decisions. ${canonicalJson({ format: "validation-inputs.v1", baseline_id: componentGraph.baseline_id })}`,
  };

  return deepFreeze(assertEncounterWorkGraph({
    schema_version: "2",
    encounter_id: spec.encounter_id,
    component_graph: componentGraph,
    work_orders: [...roots, assembly, validation],
  }));
}

/**
 * Select immutable component revisions or their declared fallbacks at the
 * assembler seam. This stays independent from delivery order and from any
 * particular worker or asset format.
 */
export function assembleEncounterInputs(graph, receipts = []) {
  assertEncounterWorkGraph(graph);
  if (!graph.component_graph) throw new TypeError("assembly inputs require a component graph");
  const byWorkId = receiptIndex(receipts);
  const componentOrders = graph.work_orders.filter((order) => !["assembly", "validation"].includes(order.lane));
  if (componentOrders.length !== graph.component_graph.components.length) throw new TypeError("component graph and work orders must remain aligned");
  const selections = graph.component_graph.components.map((component, index) => {
    const work = componentOrders[index];
    const receipt = byWorkId.get(work.work_id);
    const source = receipt?.status === "completed" ? "candidate" : "fallback";
    return {
      component_id: component.component_id,
      component_revision_id: component.component_revision.revision_id,
      lane: component.lane,
      source,
      selected_module_id: source === "candidate" ? component.candidate_module_id : component.fallback.module_id,
      fallback_reason: source === "fallback" ? receipt?.status || "missing-receipt" : undefined,
    };
  });
  return deepFreeze({
    format: "encounter-assembly-inputs.v1",
    encounter_id: graph.encounter_id,
    baseline_id: graph.component_graph.baseline_id,
    valid: true,
    selections,
    assembly_input_sha256: digestCanonical({ encounter_id: graph.encounter_id, baseline_id: graph.component_graph.baseline_id, selections }),
  });
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
  if (graph.component_graph !== undefined) assertComponentGraph(graph);
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
  if (!validProductionGate(spec.production_gate)) {
    throw new TypeError("planner requires an unexpired compatible production gate");
  }
}

function planComponentGraph(spec) {
  const roles = [...spec.desired_roles].sort();
  const centralSocket = (role, ordinal) => socketId(spec.encounter_id, "central-body", role, ordinal);
  const components = [];
  const add = ({ slot, kind, lane, requestedProvides, attachmentContract = { consumes: [], provides: [] }, role = undefined }) => {
    const component_id = componentId(spec.encounter_id, slot);
    const component_revision = immutableRevision({ component_id, slot, kind, lane, requestedProvides, attachmentContract, role, spec: componentSpecProjection(spec) });
    components.push({
      component_id,
      component_revision,
      candidate_module_id: moduleId(component_id, component_revision.revision_id, "candidate"),
      fallback: { module_id: moduleId(component_id, component_revision.revision_id, "fallback"), requested_provides: [...requestedProvides] },
      slot,
      kind,
      lane,
      role,
      requested_provides: [...requestedProvides],
      attachment_contract: attachmentContract,
    });
  };

  add({
    slot: "central-body",
    kind: "central-body",
    lane: "body-source",
    requestedProvides: ["encounter.body.source"],
    attachmentContract: {
      consumes: [],
      provides: roles.flatMap((role) => [
        socketContract(centralSocket(role, "segment-1"), "body-segment", role),
        socketContract(centralSocket(role, "segment-2"), "body-segment", role),
        socketContract(centralSocket(role, "critical"), "critical-spot", role),
      ]),
    },
  });

  for (const role of roles) {
    const firstOutput = socketId(spec.encounter_id, "body-segment", role, "1-output");
    add({
      slot: `body-segment-${role}-1`,
      kind: "body-segment",
      lane: "body-segment-source",
      role,
      requestedProvides: ["encounter.body.segment.source"],
      attachmentContract: { consumes: [socketContract(centralSocket(role, "segment-1"), "body-segment", role)], provides: [socketContract(firstOutput, "body-segment", role)] },
    });
    add({
      slot: `body-segment-${role}-2`,
      kind: "body-segment",
      lane: "body-segment-source",
      role,
      requestedProvides: ["encounter.body.segment.source"],
      attachmentContract: { consumes: [socketContract(centralSocket(role, "segment-2"), "body-segment", role)], provides: [socketContract(socketId(spec.encounter_id, "body-segment", role, "2-output"), "body-segment", role)] },
    });
    add({
      slot: `critical-spot-${role}`,
      kind: "critical-spot",
      lane: "critical-spot-module",
      role,
      requestedProvides: ["encounter.critical-spot.module"],
      attachmentContract: { consumes: [socketContract(centralSocket(role, "critical"), "critical-spot", role)], provides: [] },
    });
    add({
      slot: `motion-clip-${role}`,
      kind: "motion-clip",
      lane: "motion-clip",
      role,
      requestedProvides: ["encounter.motion.clip"],
      attachmentContract: { consumes: [socketContract(firstOutput, "body-segment", role)], provides: [] },
    });
  }
  add({ slot: "material-binding", kind: "material-binding", lane: "material-binding", requestedProvides: ["encounter.material.binding"] });
  add({
    slot: "arena-envelope",
    kind: "arena-envelope",
    lane: "arena-envelope",
    requestedProvides: ["encounter.arena.envelope"],
    attachmentContract: { consumes: [], provides: [] },
  });
  add({ slot: "combat-recipe", kind: "combat-recipe", lane: "combat-recipe", requestedProvides: ["encounter.combat.recipe"] });
  const baseline_id = `baseline-${digestCanonical({ encounter_id: spec.encounter_id, components: components.map((component) => component.fallback.module_id) }).slice(0, 32)}`;
  return { format: "encounter-component-graph.v1", baseline_id, components };
}

function componentSpecProjection(spec) {
  return {
    encounter_id: spec.encounter_id,
    seed: spec.seed,
    objective: spec.objective,
    arena_envelope: spec.arena_envelope,
    desired_roles: [...spec.desired_roles].sort(),
    attempt: spec.attempt || 1,
  };
}

function immutableRevision(value) {
  const content_sha256 = digestCanonical(value);
  return { revision_id: `revision-${content_sha256.slice(0, 32)}`, content_sha256 };
}

function componentId(encounterId, slot) { return `component-${digestCanonical({ encounterId, slot }).slice(0, 32)}`; }
function moduleId(componentId, revisionId, source) { return `module-${digestCanonical({ componentId, revisionId, source }).slice(0, 32)}`; }
function socketId(encounterId, owner, role, ordinal) { return `socket-${digestCanonical({ encounterId, owner, role, ordinal }).slice(0, 32)}`; }
function socketContract(socket_id, kind, role) { return { socket_id, kind, role }; }

function assertComponentGraph(graph) {
  const componentGraph = graph.component_graph;
  if (!componentGraph || componentGraph.format !== "encounter-component-graph.v1" || !ID.test(componentGraph.baseline_id)
      || !Array.isArray(componentGraph.components) || componentGraph.components.length === 0) {
    throw new TypeError("component graph must contain immutable generic components");
  }
  const seenComponents = new Set();
  const seenRevisions = new Set();
  for (const component of componentGraph.components) {
    if (!component || !ID.test(component.component_id) || !component.component_revision
        || !ID.test(component.component_revision.revision_id) || !sha256(component.component_revision.content_sha256)
        || !ID.test(component.candidate_module_id) || !ID.test(component.fallback?.module_id)
        || !SEMANTIC_TAG.test(component.kind) || !SEMANTIC_TAG.test(component.lane)
        || !uniqueTags(component.requested_provides)
        || !validAttachmentContract(component.attachment_contract)) {
      throw new TypeError("component graph contains an invalid component contract");
    }
    if (seenComponents.has(component.component_id) || seenRevisions.has(component.component_revision.revision_id)) {
      throw new TypeError("component graph component and revision IDs must be immutable and unique");
    }
    seenComponents.add(component.component_id);
    seenRevisions.add(component.component_revision.revision_id);
  }
}

function validAttachmentContract(contract) {
  const validSocket = (socket) => socket && ID.test(socket.socket_id) && SEMANTIC_TAG.test(socket.kind)
    && (socket.role === undefined || SEMANTIC_TAG.test(socket.role));
  return contract && Array.isArray(contract.consumes) && Array.isArray(contract.provides)
    && contract.consumes.every(validSocket) && contract.provides.every(validSocket);
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

function workId(spec, component) {
  return `wg-${createHash("sha256").update(canonicalJson({ spec, component })).digest("hex").slice(0, 32)}`;
}

function instructionFor(spec, component) {
  const roles = [...spec.desired_roles].sort().join(", ");
  return `Produce one immutable ${component.kind} revision for objective ${spec.objective.kind}; preserve the declared arena envelope and roles: ${roles}. ${canonicalJson({ format: "component-brief.v1", component_id: component.component_id, component_revision: component.component_revision, candidate_module_id: component.candidate_module_id, fallback: component.fallback, attachment_contract: component.attachment_contract })}`;
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

function digestCanonical(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function receiptIndex(receipts) {
  if (receipts instanceof Map) return receipts;
  if (!Array.isArray(receipts)) throw new TypeError("assembly receipts must be an array or Map");
  return new Map(receipts.filter((receipt) => receipt && typeof receipt.work_id === "string").map((receipt) => [receipt.work_id, receipt]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
