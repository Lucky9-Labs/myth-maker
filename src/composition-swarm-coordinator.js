import { createHash } from "node:crypto";

import { createSqliteCatalog } from "./catalog-sqlite.js";
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
  constructor({ manifest, work_items = [], catalog = createSqliteCatalog(), now = () => new Date().toISOString() } = {}) {
    assertCompositionManifest(manifest);
    if (!Array.isArray(work_items)) throw new TypeError("work_items must be an array");
    if (!catalog || typeof catalog.admitCompositionModuleRevision !== "function" || typeof catalog.getCompositionModule !== "function") throw new TypeError("coordinator requires the composition revision catalog port");
    this.manifest = freeze(clone(manifest));
    this.catalog = catalog;
    this.now = now;
    this.work = new Map();
    this.workers = new Map();
    this.modules = new Map();
    this.stale = new Set();
    this.claims = new Map();
    this.fidelityPhase = "component"; // Baseline creation was the initial whole pass.

    const declared = [...manifest.baseline_modules, ...manifest.upgrade_candidates].sort(compareRef);
    for (const module of declared) this.catalog.admitCompositionModuleRevision(module);
    for (const module of manifest.baseline_modules) this.modules.set(refKey(module), { module: freeze(clone(this.catalog.getCompositionModule(module.module_id, module.revision))), state: "accepted", baseline: true });
    for (const module of manifest.upgrade_candidates) this.modules.set(refKey(module), { module: freeze(clone(this.catalog.getCompositionModule(module.module_id, module.revision))), state: "candidate", baseline: false });
    for (const item of work_items) this.#storeWorkItem(item);
    assertThreeDAssemblyPlan(this.manifest, [...this.work.values()].map((entry) => entry.item));
    const initial = this.#compose(undefined, undefined, [], this.now());
    this.receipts = [initial.receipt];
    this.packages = [initial.package];
    this.active = initial.receipt;
    this.activePackage = initial.package;
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
    const output = this.modules.get(refKey(item.output_module_ref));
    if (!output || output.baseline) throw new TypeError(`work ${item.work_id} must declare one manifest upgrade output revision`);
    if ([...this.work.values()].some((entry) => refKey(entry.item.output_module_ref) === refKey(item.output_module_ref))) throw new TypeError(`module output ${item.output_module_ref.module_id}@${item.output_module_ref.revision} already has an owner`);
    assertWorkOwnsModule(item, output.module, graphNode(this.manifest, item.output_module_ref));
    const timestamp = this.now();
    this.work.set(item.work_id, { item: freeze(clone(item)), status: "pending", worker_id: undefined, result: undefined, created_at: timestamp, updated_at: timestamp });
    assertAcyclic([...this.work.values()].map(({ item: workItem }) => workItem));
  }

  registerWorker(worker) {
    if (!worker || !ID.test(worker.worker_id || "") || !uniqueTags(worker.capabilities, true)
      || !uniqueTags(worker.ownership)) throw new TypeError("worker needs stable identity, capabilities, and ownership");
    const previous = this.workers.get(worker.worker_id);
    if (previous && canonicalJson(previous) !== canonicalJson(worker)) throw new TypeError(`worker ${worker.worker_id} registration is immutable`);
    this.workers.set(worker.worker_id, freeze(clone(worker)));
    return this.projection();
  }

  /** The build-room read model: no hidden scheduler state is needed to render it. */
  projection() {
    return freeze({
      schema_version: "2",
      composition_id: this.manifest.composition_id,
      current_whole: clone(this.active),
      receipt_history: this.receipts.map(clone),
      work_items: [...this.work.values()].map((entry) => projectWork(entry, this.now())).sort(byWork),
      active_refinement_lanes: [...this.work.values()].filter((entry) => entry.status === "running").map(({ item, worker_id }) => ({ work_id: item.work_id, lane: item.lane, worker_id })).sort(byWork),
      workers: [...this.workers.values()].map((worker) => clone(worker)).sort((a, b) => a.worker_id.localeCompare(b.worker_id)),
      dependency_edges: this.#projectEdges(),
      resource_claims: [...this.claims.entries()].flatMap(([resource_id, claims]) => claims.map((claim) => ({ resource_id, ...claim }))).sort((a, b) => a.resource_id.localeCompare(b.resource_id) || a.work_id.localeCompare(b.work_id)),
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
      if (entry.status === "pending" && blockers.length === 0 && (item.fidelity_kind === this.fidelityPhase || this.#isStaleRepair(entry))) ready.push(item.work_id);
    }
    return freeze({ ready_work_ids: ready.sort(), dependency_edges: edges.sort(compareEdge) });
  }

  claimWork(workId, workerId) {
    const entry = this.work.get(workId); const worker = this.workers.get(workerId);
    if (!entry || !worker) throw new TypeError("work and worker must exist");
    if (!this.plan().ready_work_ids.includes(workId)) throw new TypeError(`work ${workId} is not released`);
    const missing = entry.item.required_worker_capabilities.filter((capability) => !worker.capabilities.includes(capability));
    if (missing.length) throw new TypeError(`worker lacks required capabilities: ${missing.join(", ")}`);
    if (!worker.ownership.includes(entry.item.output_owner)) throw new TypeError(`worker ${workerId} does not own composition output ${entry.item.output_owner}`);
    for (const claim of entry.item.resource_claims) {
      if (claim.mode === "exclusive_write" && !worker.ownership.includes(claim.resource_id)) {
        throw new TypeError(`worker ${workerId} does not own exclusive resource ${claim.resource_id}`);
      }
      const held = this.claims.get(claim.resource_id) || [];
      if (held.some((current) => current.mode === "exclusive_write" || claim.mode === "exclusive_write")) {
        throw new TypeError(`resource claim conflict for ${claim.resource_id}`);
      }
    }
    const validationSnapshot = entry.item.fidelity_kind === "whole" ? this.#validationSnapshot(entry) : undefined;
    for (const claim of entry.item.resource_claims) this.claims.set(claim.resource_id, [...(this.claims.get(claim.resource_id) || []), { work_id: workId, mode: claim.mode }]);
    entry.status = "running"; entry.worker_id = workerId; entry.started_at = this.now(); entry.updated_at = entry.started_at;
    if (validationSnapshot) entry.validation_snapshot = validationSnapshot;
    return freeze({ work_id: workId, worker_id: workerId, status: "running", ...(entry.validation_snapshot ? { validation_snapshot: clone(entry.validation_snapshot) } : {}) });
  }

  /**
   * An accepted result must name a closed v2 module and validation evidence.
   * Results may arrive from an external dispatcher, so claiming is optional;
   * the coordinator still records the actual bound worker when it is known.
   */
  acceptResult({ work_id, module, validation_evidence, worker_id = undefined, validated_snapshot_sha256 = undefined } = {}) {
    if (!ID.test(work_id || "") || !Array.isArray(validation_evidence) || validation_evidence.length === 0
      || validation_evidence.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) {
      throw new TypeError("accepted result requires work_id and non-empty validation_evidence");
    }
    assertCompositionModule(module);
    const entry = this.work.get(work_id);
    if (!entry) throw new TypeError(`work ${work_id} is not declared by the closed manifest graph`);
    if (!this.workers.has(worker_id || "") || entry.worker_id !== worker_id) throw new TypeError("result must come from the registered worker that owns claimed work");
    if (!["running", "completed_unvalidated"].includes(entry.status)) throw new TypeError(`work ${work_id} cannot be accepted from ${entry.status}`);
    if (refKey(entry.item.output_module_ref) !== refKey(module)) throw new TypeError("result must match the work item's exact declared output revision");
    if (!this.workers.get(worker_id).ownership.includes(entry.item.output_owner)) throw new TypeError("result worker no longer owns the declared composition output");
    if (!entry.item.provided_capabilities.every((capability) => module.provides.includes(capability))) throw new TypeError("result module does not satisfy the work item's declared provided capabilities");
    const declared = this.modules.get(refKey(module));
    const catalogDeclared = this.catalog.getCompositionModule(module.module_id, module.revision);
    if (!declared || !catalogDeclared || canonicalJson(module) !== canonicalJson(declared.module) || canonicalJson(module) !== canonicalJson(catalogDeclared)) throw new TypeError("result must exactly match an immutable catalog and manifest candidate");
    assertWorkOwnsModule(entry.item, module, graphNode(this.manifest, module));
    if (entry.item.fidelity_kind === "whole") {
      const currentSnapshot = this.#validationSnapshot(entry);
      if (!SHA256.test(validated_snapshot_sha256 || "") || validated_snapshot_sha256 !== entry.validation_snapshot?.snapshot_sha256 || currentSnapshot.snapshot_sha256 !== entry.validation_snapshot.snapshot_sha256) throw new TypeError("whole validation must commit the exact claimed composition snapshot receipt");
    }
    const before = this.active;
    const previousById = latestAcceptedForId(this.modules, module.module_id);
    this.modules.set(refKey(module), { module: freeze(clone(module)), state: "accepted", baseline: this.manifest.baseline_modules.some((baseline) => baseline.module_id === module.module_id) });
    this.stale.delete(refKey(module));
    this.#resolveStaleReplacements(module);
    entry.status = "accepted_validated"; entry.result = freeze({ module: clone(module), validation_evidence: [...validation_evidence].sort(), ...(validated_snapshot_sha256 ? { validated_snapshot_sha256 } : {}) });
    if (worker_id) entry.worker_id = worker_id;
    entry.completed_at = this.now(); entry.updated_at = entry.completed_at; this.#releaseClaims(work_id);
    const stale = previousById && previousById.revision !== module.revision ? this.#invalidateDependents(previousById, module) : [];
    this.fidelityPhase = entry.item.fidelity_kind === "component" ? "whole" : "component";
    // A component result is intentionally not active until the next whole pass
    // accepts it. Never replace a proven whole with stale descendants either.
    if (this.stale.size === 0 && entry.item.fidelity_kind === "whole") {
      const next = this.#compose(before, this.activePackage, [], entry.validation_snapshot.assembled_at);
      this.receipts.push(next.receipt); this.packages.push(next.package); this.active = next.receipt; this.activePackage = next.package;
    }
    return freeze({ active_receipt: clone(this.active), previous_receipt: clone(before), stale_module_refs: stale.map(moduleRef) });
  }

  failWork(workId, reason = "worker failed") {
    const entry = this.work.get(workId); if (!entry) throw new TypeError("work must exist");
    entry.status = "failed"; entry.failure = String(reason).slice(0, 512); entry.completed_at = this.now(); entry.updated_at = entry.completed_at; this.#releaseClaims(workId);
    return this.projection();
  }

  activeReceipt() { return freeze(clone(this.active)); }

  /** Project one admitted v2 work item into the existing v1 dispatcher boundary. */
  async dispatchReady(dispatcher) {
    if (!dispatcher || typeof dispatcher.dispatchWorkOrder !== "function") throw new TypeError("dispatcher must expose dispatchWorkOrder");
    const launches = [];
    for (const workId of this.plan().ready_work_ids) {
      const entry = this.work.get(workId);
      const worker = [...this.workers.values()].sort((a, b) => a.worker_id.localeCompare(b.worker_id)).find((candidate) => this.#workerCanClaim(entry, candidate));
      if (!worker) continue;
      this.claimWork(workId, worker.worker_id);
      const order = toV1WorkOrder(this.manifest, entry.item);
      launches.push((async () => {
        try {
          const result = await dispatcher.dispatchWorkOrder(order);
          if (result.receipt.status === "completed") { entry.status = "completed_unvalidated"; entry.updated_at = this.now(); this.#releaseClaims(workId); }
          else this.failWork(workId, result.receipt.status);
          return { work_id: workId, worker_id: worker.worker_id, receipt: result.receipt };
        } catch (error) {
          this.failWork(workId, error.message || error);
          return { work_id: workId, worker_id: worker.worker_id, receipt: { status: "failed", error: String(error.message || error).slice(0, 512) } };
        }
      })());
    }
    return freeze((await Promise.all(launches)).sort(byWork));
  }

  #blockers(entry) {
    const blockers = [];
    for (const id of entry.item.depends_on_work_ids) {
      const dependency = this.work.get(id);
      if (!dependency || dependency.status !== entry.item.dependency_release.required_status) blockers.push({ work_id: id, state: "blocked", reason: "terminal accepted and validated result required" });
      else if (!entry.item.dependency_release.required_provides.every((tag) => dependency.result?.module.provides.includes(tag))) blockers.push({ work_id: id, state: "blocked", reason: "accepted result lacks required provide" });
    }
    for (const ref of entry.item.input_module_revisions) if (this.stale.has(refKey(ref)) || !this.modules.get(refKey(ref)) || this.modules.get(refKey(ref)).state !== "accepted") blockers.push({ work_id: entry.item.work_id, state: "blocked", reason: `input ${ref.module_id}@${ref.revision} is unavailable or stale` });
    if (entry.item.fidelity_kind === "whole" && this.stale.size && !this.#isStaleRepair(entry)) blockers.push({ work_id: entry.item.work_id, state: "blocked", reason: "composition has stale descendants" });
    return blockers;
  }

  #workerCanClaim(entry, worker) {
    if (!entry.item.required_worker_capabilities.every((capability) => worker.capabilities.includes(capability)) || !worker.ownership.includes(entry.item.output_owner)) return false;
    for (const claim of entry.item.resource_claims) {
      if (claim.mode === "exclusive_write" && !worker.ownership.includes(claim.resource_id)) return false;
      if ((this.claims.get(claim.resource_id) || []).some((current) => current.mode === "exclusive_write" || claim.mode === "exclusive_write")) return false;
    }
    return true;
  }

  #projectEdges() {
    const edges = [];
    for (const entry of this.work.values()) for (const dependencyId of entry.item.depends_on_work_ids) {
      const dependency = this.work.get(dependencyId);
      const satisfied = dependency?.status === entry.item.dependency_release.required_status && entry.item.dependency_release.required_provides.every((tag) => dependency.result?.module.provides.includes(tag));
      edges.push({ from_work_id: dependencyId, to_work_id: entry.item.work_id, state: satisfied ? "satisfied" : "blocked", reason: satisfied ? "accepted and validated dependency" : "terminal accepted and validated result required" });
    }
    return edges.sort(compareEdge);
  }

  #invalidateDependents(oldModule, replacementModule) {
    const stale = [];
    const queue = [moduleRef(oldModule)];
    while (queue.length) {
      const parent = queue.shift();
      for (const node of this.manifest.module_graph) {
        if (!node.depends_on.some((dependency) => refKey(dependency) === refKey(parent))) continue;
        if (refKey(node.module_ref) === refKey(replacementModule)) continue;
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

  #isStaleRepair(entry) {
    const output = this.modules.get(refKey(entry.item.output_module_ref))?.module;
    return [...this.stale].some((key) => {
      const staleModule = this.modules.get(key)?.module;
      return staleModule && output && staleModule.fidelity.composition_unit === output.fidelity.composition_unit && canonicalJson(staleModule.provides) === canonicalJson(output.provides);
    });
  }

  #releaseClaims(workId) {
    for (const [resource, held] of this.claims) {
      const remaining = held.filter((claim) => claim.work_id !== workId);
      if (remaining.length) this.claims.set(resource, remaining); else this.claims.delete(resource);
    }
  }

  #compose(previous, previousPackage, forcedRefs = [], assembledAt = this.now()) {
    const forced = new Set(forcedRefs.map(refKey));
    const accepted = [...this.modules.entries()].filter(([key, entry]) => entry.state === "accepted" || forced.has(key)).map(([, entry]) => entry);
    const baseline = accepted.filter((entry) => entry.baseline).map(({ module }) => module);
    // A later accepted revision of a baseline identity replaces its prior revision.
    const canonicalBaseline = latestById(baseline);
    const candidates = latestById(accepted.filter((entry) => !entry.baseline).map(({ module }) => module));
    const result = assembleEncounterPackage({ host: this.manifest.host_capabilities, encounterId: this.manifest.composition_id, packageId: this.manifest.manifest_id, baselineModules: canonicalBaseline.map(toV1Module), candidateModules: candidates.map(toV1Module), previousPackage, assembledAt });
    const baselineIds = new Set(canonicalBaseline.map((module) => module.module_id));
    const selected = result.package.module_ids.map((id) => [...canonicalBaseline, ...candidates].find((module) => module.module_id === id)).filter(Boolean).map((module) => ({ ...moduleRef(module), quality_score: module.quality.score, selection_reason: baselineIds.has(module.module_id) ? "guaranteed playable baseline" : "highest compatible accepted candidate" })).sort(compareRef);
    const selectedModules = result.package.module_ids.map((id) => [...canonicalBaseline, ...candidates].find((module) => module.module_id === id)).filter(Boolean);
    const missing = this.manifest.required_provides.filter((tag) => !selectedModules.some((module) => module.provides.includes(tag)));
    if (missing.length) throw new TypeError(`assembled composition is missing required provides: ${missing.join(", ")}`);
    const body = { schema_version: "2", receipt_id: `${this.manifest.manifest_id}-receipt`, revision: result.package.revision, assembled_at: assembledAt, selected_modules: selected, rejected_conflicts: result.rejections, validation_evidence: selected.flatMap((selection) => this.#validationEvidence(selection)).sort(), fallback_provenance: result.package.fallback_provenance, source_package_revision: result.package.revision, source_package_sha256: result.package.manifest_sha256, geometric_stitching: this.manifest.geometric_stitching };
    return freeze({ receipt: { ...body, receipt_sha256: hash(body) }, package: result.package });
  }

  #validationSnapshot(entry) {
    const assembledAt = entry.validation_snapshot?.assembled_at || this.now();
    const preview = this.#compose(this.active, this.activePackage, [entry.item.output_module_ref], assembledAt);
    const inputRefs = preview.receipt.selected_modules.filter((ref) => refKey(ref) !== refKey(entry.item.output_module_ref)).map(moduleRef).sort(compareRef);
    if (canonicalJson(inputRefs) !== canonicalJson([...entry.item.input_module_revisions].sort(compareRef))) throw new TypeError("whole validation inputs must equal the exact selected composition snapshot");
    const body = { assembled_at: assembledAt, source_package_revision: preview.package.revision, source_package_sha256: preview.package.manifest_sha256, selected_modules: preview.receipt.selected_modules.map(moduleRef).sort(compareRef) };
    return freeze({ ...body, snapshot_sha256: hash(body) });
  }

  #validationEvidence(selection) {
    return [...this.work.values()].filter((entry) => entry.status === "accepted_validated" && refKey(entry.result?.module || {}) === refKey(selection)).flatMap((entry) => entry.result.validation_evidence);
  }
}

export function assertCompositionManifest(value) {
  const fields = new Set(["schema_version", "manifest_id", "composition_id", "host_capabilities", "baseline_modules", "upgrade_candidates", "module_graph", "required_provides", "geometric_stitching"]);
  if (!plain(value) || Object.keys(value).some((key) => !fields.has(key)) || value.schema_version !== "2" || !ID.test(value.manifest_id || "") || !ID.test(value.composition_id || "") || !Array.isArray(value.baseline_modules) || value.baseline_modules.length === 0 || !Array.isArray(value.upgrade_candidates) || !Array.isArray(value.module_graph) || !uniqueTags(value.required_provides, true) || !plain(value.geometric_stitching) || value.geometric_stitching.state !== "unimplemented" || typeof value.geometric_stitching.reason !== "string" || value.geometric_stitching.reason.length === 0) throw new TypeError("invalid closed v2 CompositionManifest; geometric stitching remains unimplemented until an exact-input validator exists");
  // Existing assembler remains the source of truth for host compatibility.
  const all = [...value.baseline_modules, ...value.upgrade_candidates]; all.forEach(assertCompositionModule);
  const refs = new Set(all.map(refKey));
  const revisionIds = new Set(all.map(revisionKey));
  if (revisionIds.size !== all.length) throw new TypeError("one immutable content hash is allowed for each module_id and revision");
  if (new Set(all.map(refKey)).size !== all.length || value.module_graph.some((node) => !plain(node) || Object.keys(node).some((key) => key !== "module_ref" && key !== "depends_on") || !validRef(node.module_ref) || !validRefs(node.depends_on))) throw new TypeError("manifest needs a closed module graph");
  if (value.module_graph.some((node) => !refs.has(refKey(node.module_ref)) || node.depends_on.some((ref) => !refs.has(refKey(ref)))) || new Set(value.module_graph.map((node) => refKey(node.module_ref))).size !== refs.size || value.module_graph.length !== refs.size) throw new TypeError("module graph must contain every manifest module exactly once");
  for (const module of all) {
    const node = graphNode(value, module);
    if (canonicalJson([...node.depends_on].sort(compareRef)) !== canonicalJson([...module.provenance.parent_module_refs].sort(compareRef))) throw new TypeError(`module graph parents must equal immutable provenance for ${module.module_id}@${module.revision}`);
  }
  assertAcyclicModuleGraph(value.module_graph);
  return value;
}

export function assertCompositionModule(value) {
  const fields = new Set(["schema_version", "module_id", "revision", "content_sha256", "execution_kind", "provides", "requires", "conflicts", "compatibility", "quality", "artifact", "entrypoint", "inline_recipe", "fallback_module_refs", "provenance", "fidelity", "attachment_seams"]);
  if (!plain(value) || Object.keys(value).some((key) => !fields.has(key)) || value.schema_version !== "2" || !ID.test(value.module_id || "") || !Number.isInteger(value.revision) || value.revision < 1 || !SHA256.test(value.content_sha256 || "") || !["recipe", "runtime_asset", "managed_plugin", "remote_logic"].includes(value.execution_kind) || !uniqueTags(value.provides, true) || !uniqueTags(value.requires) || !uniqueTags(value.conflicts) || !plain(value.compatibility) || !plain(value.quality) || !Array.isArray(value.fallback_module_refs) || !plain(value.provenance) || !plain(value.fidelity)) throw new TypeError("invalid closed v2 CompositionModule");
  if (!validRefs(value.fallback_module_refs) || !validRefs(value.provenance.parent_module_refs || []) || typeof value.provenance.producer !== "string" || value.provenance.producer.length === 0 || !timestamp(value.provenance.created_at) || !["whole", "component", "layer"].includes(value.fidelity.kind) || !ID.test(value.fidelity.layer_id || "") || !ID.test(value.fidelity.composition_unit || "") || value.content_sha256 !== compositionContentSha256(value)) throw new TypeError("module needs an immutable content hash, provenance, and fidelity ownership");
  if (value.execution_kind === "recipe" && !plain(value.inline_recipe)) throw new TypeError("recipe module needs inline_recipe");
  if (value.attachment_seams !== undefined && (!Array.isArray(value.attachment_seams) || value.attachment_seams.some((seam) => !plain(seam) || Object.keys(seam).some((key) => !["seam_id", "attachment_kind"].includes(key)) || !ID.test(seam.seam_id || "") || !TAG.test(seam.attachment_kind || "")))) throw new TypeError("attachment seams must be explicit");
  return value;
}

export function assertCompositionWorkItem(value) {
  const fields = new Set(["schema_version", "work_id", "lane", "deadline_at", "required_worker_capabilities", "provided_capabilities", "input_module_revisions", "output_module_ref", "output_owner", "depends_on_work_ids", "dependency_release", "resource_claims", "fidelity_kind", "assembly_role"]);
  if (!plain(value) || Object.keys(value).some((key) => !fields.has(key)) || value.schema_version !== "2" || !ID.test(value.work_id || "") || !TAG.test(value.lane || "") || !timestamp(value.deadline_at) || !uniqueTags(value.required_worker_capabilities, true) || !uniqueTags(value.provided_capabilities, true) || !validRefs(value.input_module_revisions) || !validRef(value.output_module_ref) || !TAG.test(value.output_owner || "") || !validIds(value.depends_on_work_ids) || !plain(value.dependency_release) || Object.keys(value.dependency_release).some((key) => !["required_status", "required_provides"].includes(key)) || value.dependency_release.required_status !== "accepted_validated" || !uniqueTags(value.dependency_release.required_provides) || !Array.isArray(value.resource_claims) || !FIDELITY_KINDS.has(value.fidelity_kind) || !["component_refinement", "whole_validation", "geometric_stitch_validation"].includes(value.assembly_role)) throw new TypeError("invalid closed v2 CompositionWorkItem");
  let prior = "";
  for (const claim of value.resource_claims) { if (!plain(claim) || Object.keys(claim).some((key) => !["resource_id", "mode", "media_type"].includes(key)) || !TAG.test(claim.resource_id || "") || !CLAIM_MODES.has(claim.mode) || (claim.media_type !== undefined && (typeof claim.media_type !== "string" || claim.media_type.length === 0 || claim.media_type.length > 128)) || claim.resource_id <= prior) throw new TypeError("resource claims must be ordered shared-read/exclusive-write claims"); prior = claim.resource_id; }
  return value;
}

function toV1Module(module) { return { schema_version: "1", module_id: module.module_id, revision: module.revision, execution_kind: module.execution_kind, provides: module.provides, requires: module.requires, conflicts: module.conflicts, compatibility: module.compatibility, quality: module.quality, ...(module.artifact ? { artifact: module.artifact } : {}), ...(module.entrypoint ? { entrypoint: module.entrypoint } : {}), ...(module.inline_recipe ? { inline_recipe: module.inline_recipe } : {}), fallback_module_ids: module.fallback_module_refs.map((ref) => ref.module_id), provenance: { producer: module.provenance.producer, created_at: module.provenance.created_at, parent_module_ids: module.provenance.parent_module_refs.map((ref) => ref.module_id) } }; }
function toV1WorkOrder(manifest, item) { const order = { schema_version: "1", work_id: item.work_id, encounter_id: manifest.composition_id, lane: item.lane, deadline_at: item.deadline_at, requested_provides: item.provided_capabilities, host_capabilities: manifest.host_capabilities, input_module_ids: item.input_module_revisions.map((ref) => ref.module_id), depends_on_work_ids: item.depends_on_work_ids, resource_leases: item.resource_claims.map((claim) => claim.resource_id), attempt: 1, instruction: `v2 composition work ${item.work_id}` }; assertEncounterWorkOrder(order); return order; }
function latestAcceptedForId(records, id) { return latestById([...records.values()].filter((entry) => entry.state === "accepted" && entry.module.module_id === id).map(({ module }) => module))[0]; }
function latestById(modules) { return [...new Map([...modules].sort((a, b) => a.revision - b.revision || a.content_sha256.localeCompare(b.content_sha256)).map((module) => [module.module_id, module])).values()]; }
function moduleRef(module) { return { module_id: module.module_id, revision: module.revision, content_sha256: module.content_sha256 }; }
function refKey(ref) { return `${ref.module_id}@${ref.revision}:${ref.content_sha256}`; }
function revisionKey(ref) { return `${ref.module_id}@${ref.revision}`; }
function validRef(value) { return plain(value) && Object.keys(value).every((key) => ["module_id", "revision", "content_sha256"].includes(key)) && ID.test(value.module_id || "") && Number.isInteger(value.revision) && value.revision > 0 && SHA256.test(value.content_sha256 || ""); }
function validRefs(value) { return Array.isArray(value) && value.every(validRef) && new Set(value.map(refKey)).size === value.length; }
function validIds(value) { return Array.isArray(value) && value.every((item) => ID.test(item)) && new Set(value).size === value.length; }
function uniqueTags(value, required = false) { return Array.isArray(value) && (!required || value.length > 0) && value.every((item) => TAG.test(item)) && new Set(value).size === value.length; }
function timestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }
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
function assertThreeDAssemblyPlan(manifest, items) { if (items.some((item) => item.assembly_role === "geometric_stitch_validation")) throw new TypeError("geometric stitch validation cannot be scheduled before an exact-input validator is implemented"); }
function graphNode(manifest, ref) { return manifest.module_graph.find((node) => refKey(node.module_ref) === refKey(ref)); }
function assertWorkOwnsModule(item, module, node) {
  if (!node || refKey(item.output_module_ref) !== refKey(module)) throw new TypeError("work output must name one exact manifest module revision");
  const componentKind = module.fidelity.kind === "component" || module.fidelity.kind === "layer";
  if ((item.fidelity_kind === "whole") !== (module.fidelity.kind === "whole") || (item.fidelity_kind === "component" && !componentKind)) throw new TypeError("work fidelity kind must match its exact output module");
  if ((item.assembly_role === "component_refinement") !== (item.fidelity_kind === "component") || (item.assembly_role === "whole_validation") !== (item.fidelity_kind === "whole")) throw new TypeError("assembly role must match work fidelity kind");
  if (canonicalJson([...item.input_module_revisions].sort(compareRef)) !== canonicalJson([...node.depends_on].sort(compareRef)) || canonicalJson([...node.depends_on].sort(compareRef)) !== canonicalJson([...module.provenance.parent_module_refs].sort(compareRef))) throw new TypeError("work inputs, graph parents, and module provenance must match exactly");
  if (!item.provided_capabilities.every((tag) => module.provides.includes(tag))) throw new TypeError("work output must provide every declared capability");
}
function assertAcyclicModuleGraph(nodes) { const known = new Map(nodes.map((node) => [refKey(node.module_ref), node])); const visiting = new Set(), visited = new Set(); function visit(key) { if (visited.has(key)) return; if (visiting.has(key)) throw new TypeError("module graph dependencies must be acyclic"); visiting.add(key); for (const parent of known.get(key).depends_on) visit(refKey(parent)); visiting.delete(key); visited.add(key); } for (const key of known.keys()) visit(key); }
function projectWork(entry, observedAt) { const terminal = ["accepted_validated", "failed", "stale"].includes(entry.status); const end = terminal ? entry.completed_at || entry.updated_at : observedAt; const start = entry.started_at || entry.created_at; return { work_id: entry.item.work_id, lane: entry.item.lane, status: entry.status, worker_id: entry.worker_id, output_module_ref: clone(entry.item.output_module_ref), output_owner: entry.item.output_owner, depends_on_work_ids: [...entry.item.depends_on_work_ids], input_module_revisions: entry.item.input_module_revisions.map(clone), required_worker_capabilities: [...entry.item.required_worker_capabilities], provided_capabilities: [...entry.item.provided_capabilities], resource_claims: entry.item.resource_claims.map(clone), fidelity_kind: entry.item.fidelity_kind, assembly_role: entry.item.assembly_role, deadline_at: entry.item.deadline_at, created_at: entry.created_at, started_at: entry.started_at, completed_at: entry.completed_at, updated_at: entry.updated_at, elapsed_ms: Math.max(0, Date.parse(end) - Date.parse(start)), validation_evidence: entry.result?.validation_evidence || [], validated_snapshot_sha256: entry.result?.validated_snapshot_sha256, failure: entry.failure, validation_snapshot: clone(entry.validation_snapshot) }; }
