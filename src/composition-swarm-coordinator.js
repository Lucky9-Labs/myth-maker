import { createHash } from "node:crypto";

import { assembleEncounterPackage } from "./encounter-package-assembler.js";
import { assertEncounterWorkOrder } from "./workgraph-planner.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CLAIM_MODES = new Set(["shared_read", "exclusive_write"]);
const FIDELITY_KINDS = new Set(["whole", "component"]);

/**
 * Coordinator-owned, deterministic composition state over the existing v1
 * module assembler and work dispatcher. v2 adds scheduling/provenance data;
 * outbound work is projected into the closed v1 work-order envelope.
 */
export class CompositionSwarmCoordinator {
  constructor({ manifest, work_items = [], now = () => new Date().toISOString() } = {}) {
    assertCompositionManifest(manifest);
    if (!Array.isArray(work_items)) throw new TypeError("work_items must be an array");
    this.manifest = freeze(clone(manifest));
    this.now = now;
    this.work = new Map();
    this.workers = new Map();
    this.modules = new Map();
    this.stale = new Set();
    this.claims = new Map();
    this.fidelityPhase = "component"; // Baseline creation was the initial whole pass.

    for (const module of manifest.baseline_modules) this.modules.set(refKey(module), { module: freeze(clone(module)), state: "accepted", baseline: true });
    for (const module of manifest.upgrade_candidates) this.modules.set(refKey(module), { module: freeze(clone(module)), state: "candidate", baseline: false });
    for (const item of work_items) this.#storeWorkItem(item);
    assertThreeDAssemblyPlan(this.manifest, [...this.work.values()].map((entry) => entry.item));
    this.receipts = [this.#assemble(undefined)];
    this.active = this.receipts[0];
  }

  addWorkItem(item) {
    assertCompositionWorkItem(item);
    if (this.work.has(item.work_id)) throw new TypeError(`duplicate work_id ${item.work_id}`);
    assertThreeDAssemblyPlan(this.manifest, [...this.work.values()].map((entry) => entry.item).concat(item));
    this.#storeWorkItem(item);
    return this.projection();
  }

  #storeWorkItem(item) {
    assertCompositionWorkItem(item);
    if (this.work.has(item.work_id)) throw new TypeError(`duplicate work_id ${item.work_id}`);
    this.work.set(item.work_id, { item: freeze(clone(item)), status: "pending", worker_id: undefined, result: undefined });
    assertAcyclic([...this.work.values()].map(({ item: workItem }) => workItem));
  }

  registerWorker(worker) {
    if (!worker || !ID.test(worker.worker_id || "") || !uniqueTags(worker.capabilities, true)
      || !uniqueTags(worker.ownership)) throw new TypeError("worker needs stable identity, capabilities, and ownership");
    this.workers.set(worker.worker_id, freeze(clone(worker)));
    return this.projection();
  }

  /** The build-room read model: no hidden scheduler state is needed to render it. */
  projection() {
    const plan = this.plan();
    return freeze({
      schema_version: "2",
      composition_id: this.manifest.composition_id,
      current_whole: clone(this.active),
      active_refinement_lanes: [...this.work.values()].filter((entry) => entry.status === "running").map(({ item, worker_id }) => ({ work_id: item.work_id, lane: item.lane, worker_id })).sort(byWork),
      workers: [...this.workers.values()].map((worker) => clone(worker)).sort((a, b) => a.worker_id.localeCompare(b.worker_id)),
      dependency_edges: plan.dependency_edges,
      module_selection_reasons: this.active.selected_modules.map(({ module_id, revision, content_sha256, selection_reason, quality_score }) => ({ module_id, revision, content_sha256, selection_reason, quality_score })),
      geometric_stitching: clone(this.manifest.geometric_stitching),
      fidelity_cycle: { phase: this.fidelityPhase, next_required_kind: this.fidelityPhase },
    });
  }

  plan() {
    const ready = [], edges = [];
    for (const entry of this.work.values()) {
      const { item } = entry;
      const blockers = this.#blockers(entry);
      for (const blocker of blockers) edges.push({ from_work_id: blocker.work_id, to_work_id: item.work_id, state: blocker.state, reason: blocker.reason });
      if (entry.status === "pending" && blockers.length === 0 && item.fidelity_kind === this.fidelityPhase) ready.push(item.work_id);
    }
    return freeze({ ready_work_ids: ready.sort(), dependency_edges: edges.sort(compareEdge) });
  }

  claimWork(workId, workerId) {
    const entry = this.work.get(workId); const worker = this.workers.get(workerId);
    if (!entry || !worker) throw new TypeError("work and worker must exist");
    if (!this.plan().ready_work_ids.includes(workId)) throw new TypeError(`work ${workId} is not released`);
    const missing = entry.item.required_worker_capabilities.filter((capability) => !worker.capabilities.includes(capability));
    if (missing.length) throw new TypeError(`worker lacks required capabilities: ${missing.join(", ")}`);
    for (const claim of entry.item.resource_claims) {
      if (claim.mode === "exclusive_write" && !worker.ownership.includes(claim.resource_id)) {
        throw new TypeError(`worker ${workerId} does not own exclusive resource ${claim.resource_id}`);
      }
      const held = this.claims.get(claim.resource_id) || [];
      if (held.some((current) => current.mode === "exclusive_write" || claim.mode === "exclusive_write")) {
        throw new TypeError(`resource claim conflict for ${claim.resource_id}`);
      }
    }
    for (const claim of entry.item.resource_claims) this.claims.set(claim.resource_id, [...(this.claims.get(claim.resource_id) || []), { work_id: workId, mode: claim.mode }]);
    entry.status = "running"; entry.worker_id = workerId;
    return freeze({ work_id: workId, worker_id: workerId, status: "running" });
  }

  /**
   * An accepted result must name a closed v2 module and validation evidence.
   * Results may arrive from an external dispatcher, so claiming is optional;
   * the coordinator still records the actual bound worker when it is known.
   */
  acceptResult({ work_id, module, validation_evidence, worker_id = undefined } = {}) {
    if (!ID.test(work_id || "") || !Array.isArray(validation_evidence) || validation_evidence.length === 0
      || validation_evidence.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) {
      throw new TypeError("accepted result requires work_id and non-empty validation_evidence");
    }
    assertCompositionModule(module);
    const entry = this.work.get(work_id);
    if (!entry) throw new TypeError(`work ${work_id} is not declared by the closed manifest graph`);
    if (!this.workers.has(worker_id || "") || entry.worker_id !== worker_id) throw new TypeError("result must come from the registered worker that owns claimed work");
    if (!["running", "completed_unvalidated"].includes(entry.status)) throw new TypeError(`work ${work_id} cannot be accepted from ${entry.status}`);
    if (!entry.item.provided_capabilities.every((capability) => module.provides.includes(capability))) throw new TypeError("result module does not satisfy the work item's declared provided capabilities");
    const declared = this.modules.get(refKey(module));
    if (!declared || canonicalJson(module) !== canonicalJson(declared.module)) throw new TypeError("result must exactly match an immutable manifest candidate");
    if (!entry.item.input_module_revisions.every((input) => module.provenance.parent_module_refs.some((parent) => refKey(parent) === refKey(input)))) throw new TypeError("result provenance must name every declared input module revision");
    const before = this.active;
    const previousById = latestAcceptedForId(this.modules, module.module_id);
    this.modules.set(refKey(module), { module: freeze(clone(module)), state: "accepted", baseline: this.manifest.baseline_modules.some((baseline) => baseline.module_id === module.module_id) });
    this.stale.delete(refKey(module));
    this.#resolveStaleReplacements(module);
    entry.status = "accepted_validated"; entry.result = freeze({ module: clone(module), validation_evidence: [...validation_evidence].sort() });
    if (worker_id) entry.worker_id = worker_id;
    this.#releaseClaims(work_id);
    const stale = previousById && previousById.revision !== module.revision ? this.#invalidateDependents(previousById) : [];
    this.fidelityPhase = entry.item.fidelity_kind === "component" ? "whole" : "component";
    // A component result is intentionally not active until the next whole pass
    // accepts it. Never replace a proven whole with stale descendants either.
    if (this.stale.size === 0 && entry.item.fidelity_kind === "whole") {
      const next = this.#assemble(before);
      if (shouldPublishReceipt(next, before)) { this.receipts.push(next); this.active = next; }
    }
    return freeze({ active_receipt: clone(this.active), previous_receipt: clone(before), stale_module_refs: stale.map(moduleRef) });
  }

  failWork(workId, reason = "worker failed") {
    const entry = this.work.get(workId); if (!entry) throw new TypeError("work must exist");
    entry.status = "failed"; entry.failure = String(reason).slice(0, 512); this.#releaseClaims(workId);
    return this.projection();
  }

  activeReceipt() { return freeze(clone(this.active)); }

  /** Project one admitted v2 work item into the existing v1 dispatcher boundary. */
  async dispatchReady(dispatcher) {
    if (!dispatcher || typeof dispatcher.dispatchWorkOrder !== "function") throw new TypeError("dispatcher must expose dispatchWorkOrder");
    const launched = [];
    for (const workId of this.plan().ready_work_ids) {
      const entry = this.work.get(workId);
      const worker = [...this.workers.values()].sort((a, b) => a.worker_id.localeCompare(b.worker_id)).find((candidate) => entry.item.required_worker_capabilities.every((capability) => candidate.capabilities.includes(capability)));
      if (!worker) continue;
      this.claimWork(workId, worker.worker_id);
      const order = toV1WorkOrder(this.manifest, entry.item);
      const result = await dispatcher.dispatchWorkOrder(order);
      launched.push({ work_id: workId, worker_id: worker.worker_id, receipt: result.receipt });
      if (result.receipt.status === "completed") {
        entry.status = "completed_unvalidated";
        this.#releaseClaims(workId);
      } else this.failWork(workId, result.receipt.status);
    }
    return freeze(launched.sort(byWork));
  }

  #blockers(entry) {
    const blockers = [];
    for (const id of entry.item.depends_on_work_ids) {
      const dependency = this.work.get(id);
      if (!dependency || dependency.status !== entry.item.dependency_release.required_status) blockers.push({ work_id: id, state: "blocked", reason: "terminal accepted and validated result required" });
      else if (!entry.item.dependency_release.required_provides.every((tag) => dependency.result?.module.provides.includes(tag))) blockers.push({ work_id: id, state: "blocked", reason: "accepted result lacks required provide" });
    }
    for (const ref of entry.item.input_module_revisions) if (this.stale.has(refKey(ref)) || !this.modules.get(refKey(ref)) || this.modules.get(refKey(ref)).state !== "accepted") blockers.push({ work_id: entry.item.work_id, state: "blocked", reason: `input ${ref.module_id}@${ref.revision} is unavailable or stale` });
    return blockers;
  }

  #invalidateDependents(oldModule) {
    const stale = [];
    const queue = [moduleRef(oldModule)];
    while (queue.length) {
      const parent = queue.shift();
      for (const node of this.manifest.module_graph) {
        if (!node.depends_on.some((dependency) => refKey(dependency) === refKey(parent))) continue;
        const key = refKey(node.module_ref);
        if (this.stale.has(key)) continue;
        this.stale.add(key); stale.push(node.module_ref);
        const record = this.modules.get(key); if (record) record.state = "stale";
        queue.push(node.module_ref);
      }
    }
    for (const entry of this.work.values()) {
      if (entry.item.input_module_revisions.some((ref) => this.stale.has(refKey(ref)))) entry.status = "stale";
    }
    return stale.sort(compareRef);
  }

  #resolveStaleReplacements(module) {
    if (module.provenance.parent_module_refs.length === 0) return;
    for (const key of [...this.stale]) {
      const staleModule = this.modules.get(key)?.module;
      if (!staleModule || staleModule.fidelity.composition_unit !== module.fidelity.composition_unit) continue;
      if (canonicalJson(staleModule.provides) !== canonicalJson(module.provides)) continue;
      this.stale.delete(key);
    }
  }

  #releaseClaims(workId) {
    for (const [resource, held] of this.claims) {
      const remaining = held.filter((claim) => claim.work_id !== workId);
      if (remaining.length) this.claims.set(resource, remaining); else this.claims.delete(resource);
    }
  }

  #assemble(previous) {
    const accepted = [...this.modules.values()].filter((entry) => entry.state === "accepted");
    const baseline = accepted.filter((entry) => entry.baseline).map(({ module }) => module);
    // A later accepted revision of a baseline identity replaces its prior revision.
    const canonicalBaseline = latestById(baseline);
    const candidates = latestById(accepted.filter((entry) => !entry.baseline).map(({ module }) => module));
    const result = assembleEncounterPackage({ host: this.manifest.host_capabilities, encounterId: this.manifest.composition_id, packageId: this.manifest.manifest_id, baselineModules: canonicalBaseline.map(toV1Module), candidateModules: candidates.map(toV1Module), assembledAt: this.now() });
    const baselineIds = new Set(canonicalBaseline.map((module) => module.module_id));
    const selected = result.package.module_ids.map((id) => [...canonicalBaseline, ...candidates].find((module) => module.module_id === id)).filter(Boolean).map((module) => ({ ...moduleRef(module), quality_score: module.quality.score, selection_reason: baselineIds.has(module.module_id) ? "guaranteed playable baseline" : "highest compatible accepted candidate" })).sort(compareRef);
    const body = { schema_version: "2", receipt_id: `${this.manifest.manifest_id}-receipt`, revision: previous ? previous.revision + 1 : 1, assembled_at: this.now(), selected_modules: selected, rejected_conflicts: result.rejections, validation_evidence: selected.flatMap((selection) => this.#validationEvidence(selection)).sort(), fallback_provenance: result.package.fallback_provenance, source_package_sha256: result.package.manifest_sha256, geometric_stitching: this.manifest.geometric_stitching };
    return freeze({ ...body, receipt_sha256: hash(body) });
  }

  #validationEvidence(selection) {
    return [...this.work.values()].filter((entry) => entry.status === "accepted_validated" && refKey(entry.result?.module || {}) === refKey(selection)).flatMap((entry) => entry.result.validation_evidence);
  }
}

export function assertCompositionManifest(value) {
  const fields = new Set(["schema_version", "manifest_id", "composition_id", "host_capabilities", "baseline_modules", "upgrade_candidates", "module_graph", "required_provides", "geometric_stitching"]);
  if (!plain(value) || Object.keys(value).some((key) => !fields.has(key)) || value.schema_version !== "2" || !ID.test(value.manifest_id || "") || !ID.test(value.composition_id || "") || !Array.isArray(value.baseline_modules) || value.baseline_modules.length === 0 || !Array.isArray(value.upgrade_candidates) || !Array.isArray(value.module_graph) || !uniqueTags(value.required_provides, true) || !plain(value.geometric_stitching) || !["implemented", "unimplemented"].includes(value.geometric_stitching.state) || typeof value.geometric_stitching.reason !== "string") throw new TypeError("invalid closed v2 CompositionManifest");
  // Existing assembler remains the source of truth for host compatibility.
  const all = [...value.baseline_modules, ...value.upgrade_candidates]; all.forEach(assertCompositionModule);
  const refs = new Set(all.map(refKey));
  if (new Set(all.map(refKey)).size !== all.length || value.module_graph.some((node) => !plain(node) || Object.keys(node).some((key) => key !== "module_ref" && key !== "depends_on") || !validRef(node.module_ref) || !Array.isArray(node.depends_on) || node.depends_on.some((ref) => !validRef(ref)))) throw new TypeError("manifest needs a closed module graph");
  if (value.module_graph.some((node) => !refs.has(refKey(node.module_ref)) || node.depends_on.some((ref) => !refs.has(refKey(ref)))) || new Set(value.module_graph.map((node) => refKey(node.module_ref))).size !== refs.size || value.module_graph.length !== refs.size) throw new TypeError("module graph must contain every manifest module exactly once");
  return value;
}

export function assertCompositionModule(value) {
  const fields = new Set(["schema_version", "module_id", "revision", "content_sha256", "execution_kind", "provides", "requires", "conflicts", "compatibility", "quality", "artifact", "entrypoint", "inline_recipe", "fallback_module_refs", "provenance", "fidelity", "attachment_seams"]);
  if (!plain(value) || Object.keys(value).some((key) => !fields.has(key)) || value.schema_version !== "2" || !ID.test(value.module_id || "") || !Number.isInteger(value.revision) || value.revision < 1 || !SHA256.test(value.content_sha256 || "") || !["recipe", "runtime_asset", "managed_plugin", "remote_logic"].includes(value.execution_kind) || !uniqueTags(value.provides, true) || !Array.isArray(value.requires) || !Array.isArray(value.conflicts) || !plain(value.compatibility) || !plain(value.quality) || !Array.isArray(value.fallback_module_refs) || !plain(value.provenance) || !plain(value.fidelity)) throw new TypeError("invalid closed v2 CompositionModule");
  if (!validRefs(value.fallback_module_refs) || !validRefs(value.provenance.parent_module_refs || []) || !["whole", "component", "layer"].includes(value.fidelity.kind) || !ID.test(value.fidelity.layer_id || "") || !ID.test(value.fidelity.composition_unit || "") || value.content_sha256 !== compositionContentSha256(value)) throw new TypeError("module needs an immutable content hash, provenance, and fidelity ownership");
  if (value.execution_kind === "recipe" && !plain(value.inline_recipe)) throw new TypeError("recipe module needs inline_recipe");
  if (value.attachment_seams !== undefined && (!Array.isArray(value.attachment_seams) || value.attachment_seams.some((seam) => !plain(seam) || !ID.test(seam.seam_id || "") || !TAG.test(seam.attachment_kind || "")))) throw new TypeError("attachment seams must be explicit");
  return value;
}

export function assertCompositionWorkItem(value) {
  const fields = new Set(["schema_version", "work_id", "lane", "deadline_at", "required_worker_capabilities", "provided_capabilities", "input_module_revisions", "depends_on_work_ids", "dependency_release", "resource_claims", "fidelity_kind", "assembly_role"]);
  if (!plain(value) || Object.keys(value).some((key) => !fields.has(key)) || value.schema_version !== "2" || !ID.test(value.work_id || "") || !TAG.test(value.lane || "") || !timestamp(value.deadline_at) || !uniqueTags(value.required_worker_capabilities, true) || !uniqueTags(value.provided_capabilities, true) || !validRefs(value.input_module_revisions) || !validIds(value.depends_on_work_ids) || !plain(value.dependency_release) || value.dependency_release.required_status !== "accepted_validated" || !uniqueTags(value.dependency_release.required_provides) || !Array.isArray(value.resource_claims) || !FIDELITY_KINDS.has(value.fidelity_kind) || !["component_refinement", "whole_validation", "geometric_stitch_validation"].includes(value.assembly_role)) throw new TypeError("invalid closed v2 CompositionWorkItem");
  let prior = "";
  for (const claim of value.resource_claims) { if (!plain(claim) || Object.keys(claim).some((key) => !["resource_id", "mode", "media_type"].includes(key)) || !TAG.test(claim.resource_id || "") || !CLAIM_MODES.has(claim.mode) || claim.resource_id <= prior) throw new TypeError("resource claims must be ordered shared-read/exclusive-write claims"); prior = claim.resource_id; }
  return value;
}

function toV1Module(module) { return { schema_version: "1", module_id: module.module_id, revision: module.revision, execution_kind: module.execution_kind, provides: module.provides, requires: module.requires, conflicts: module.conflicts, compatibility: module.compatibility, quality: module.quality, ...(module.artifact ? { artifact: module.artifact } : {}), ...(module.entrypoint ? { entrypoint: module.entrypoint } : {}), ...(module.inline_recipe ? { inline_recipe: module.inline_recipe } : {}), fallback_module_ids: module.fallback_module_refs.map((ref) => ref.module_id), provenance: { producer: module.provenance.producer, created_at: module.provenance.created_at, parent_module_ids: module.provenance.parent_module_refs.map((ref) => ref.module_id) } }; }
function toV1WorkOrder(manifest, item) { const order = { schema_version: "1", work_id: item.work_id, encounter_id: manifest.composition_id, lane: item.lane, deadline_at: item.deadline_at, requested_provides: item.provided_capabilities, host_capabilities: manifest.host_capabilities, input_module_ids: item.input_module_revisions.map((ref) => ref.module_id), depends_on_work_ids: item.depends_on_work_ids, resource_leases: item.resource_claims.map((claim) => claim.resource_id), attempt: 1, instruction: `v2 composition work ${item.work_id}` }; assertEncounterWorkOrder(order); return order; }
function latestAcceptedForId(records, id) { return latestById([...records.values()].filter((entry) => entry.state === "accepted" && entry.module.module_id === id).map(({ module }) => module))[0]; }
function latestById(modules) { return [...new Map([...modules].sort((a, b) => a.revision - b.revision || a.content_sha256.localeCompare(b.content_sha256)).map((module) => [module.module_id, module])).values()]; }
function shouldPublishReceipt(next, current) {
  const score = (receipt) => receipt.selected_modules.reduce((total, entry) => total + entry.quality_score, 0);
  const selected = (receipt) => receipt.selected_modules.map(refKey).join(",");
  return score(next) > score(current)
    || (selected(next) !== selected(current) && score(next) >= score(current))
    || next.rejected_conflicts.length > current.rejected_conflicts.length
    || next.fallback_provenance.used_fallback !== current.fallback_provenance.used_fallback;
}
function moduleRef(module) { return { module_id: module.module_id, revision: module.revision, content_sha256: module.content_sha256 }; }
function refKey(ref) { return `${ref.module_id}@${ref.revision}:${ref.content_sha256}`; }
function validRef(value) { return plain(value) && Object.keys(value).every((key) => ["module_id", "revision", "content_sha256"].includes(key)) && ID.test(value.module_id || "") && Number.isInteger(value.revision) && value.revision > 0 && SHA256.test(value.content_sha256 || ""); }
function validRefs(value) { return Array.isArray(value) && value.every(validRef) && new Set(value.map(refKey)).size === value.length; }
function validIds(value) { return Array.isArray(value) && value.every((item) => ID.test(item)) && new Set(value).size === value.length; }
function uniqueTags(value, required = false) { return Array.isArray(value) && (!required || value.length > 0) && value.every((item) => TAG.test(item)) && new Set(value).size === value.length; }
function timestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function compositionContentSha256(module) { const content = clone(module); delete content.content_sha256; return hash(content); }
function hash(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
function byWork(left, right) { return left.work_id.localeCompare(right.work_id); }
function compareEdge(left, right) { return left.from_work_id.localeCompare(right.from_work_id) || left.to_work_id.localeCompare(right.to_work_id) || left.reason.localeCompare(right.reason); }
function compareRef(left, right) { return left.module_id.localeCompare(right.module_id) || left.revision - right.revision || left.content_sha256.localeCompare(right.content_sha256); }
function assertAcyclic(items) { const known = new Map(items.map((item) => [item.work_id, item])); const visiting = new Set(), visited = new Set(); function visit(id) { if (visited.has(id)) return; if (visiting.has(id)) throw new TypeError("work dependencies must be acyclic"); visiting.add(id); for (const parent of known.get(id).depends_on_work_ids) { if (!known.has(parent)) throw new TypeError(`unknown work dependency ${parent}`); visit(parent); } visiting.delete(id); visited.add(id); } for (const item of items) visit(item.work_id); }
function assertThreeDAssemblyPlan(manifest, items) { if (manifest.geometric_stitching.state !== "implemented") return; const blenderWorkIds = items.filter((item) => item.resource_claims.some((claim) => claim.media_type === "application/x-blender")).map((item) => item.work_id); if (!blenderWorkIds.length) return; const stitch = items.find((item) => item.assembly_role === "geometric_stitch_validation" && item.fidelity_kind === "whole" && blenderWorkIds.every((id) => item.depends_on_work_ids.includes(id))); if (!stitch) throw new TypeError("implemented geometric work needs a stitch/assembly/validation node dependent on every Blender part"); }
