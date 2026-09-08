import assert from "node:assert/strict";
import test from "node:test";

import { CompositionSwarmCoordinator, compositionContentSha256 } from "../src/composition-swarm-coordinator.js";

const host = {
  schema_version: "1", host_id: "generic-host", host_build: "1", platform: "linux",
  scripting_backend: "il2cpp", execution_kinds: ["recipe"], loaders: ["recipe-loader"],
  contracts: ["generic.core.v1"], limits: { memory_mb: 64, preload_seconds: 1 },
};

function module(id, revision, score, overrides = {}) {
  const result = {
    schema_version: "2", module_id: id, revision, content_sha256: "0".repeat(64),
    execution_kind: "recipe", provides: ["generic.core"], requires: ["generic.core.v1"], conflicts: [],
    compatibility: { host_contract_version: "1", bindings: { "recipe-loader": "v1" } },
    quality: { tier: 1, score, evidence: ["validated:fixture"] }, inline_recipe: { id },
    fallback_module_refs: [], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [] },
    fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" },
    ...overrides,
  };
  result.content_sha256 = compositionContentSha256(result);
  return result;
}

function manifest(overrides = {}) {
  const baseline = module("baseline-core", 1, 1);
  const upgrades = overrides.upgrade_candidates || [];
  return {
    schema_version: "2", manifest_id: "generic-manifest", composition_id: "generic-composition",
    host_capabilities: host, baseline_modules: [baseline], upgrade_candidates: upgrades,
    module_graph: [{ module_ref: { module_id: baseline.module_id, revision: baseline.revision, content_sha256: baseline.content_sha256 }, depends_on: [] }, ...upgrades.map((upgrade) => ({ module_ref: { module_id: upgrade.module_id, revision: upgrade.revision, content_sha256: upgrade.content_sha256 }, depends_on: [] }))],
    required_provides: ["generic.core"], geometric_stitching: { state: "unimplemented", reason: "no geometry stitch adapter" },
    ...overrides,
  };
}

function work(id, overrides = {}) {
  const result = {
    schema_version: "2", work_id: id, lane: "refinement", deadline_at: "2026-09-09T00:00:00Z", required_worker_capabilities: ["recipe.author"],
    provided_capabilities: ["generic.core"], input_module_revisions: [], depends_on_work_ids: [],
    dependency_release: { required_status: "accepted_validated", required_provides: [] },
    resource_claims: [], fidelity_kind: "component", assembly_role: "component_refinement",
    ...overrides,
  };
  if (!("assembly_role" in overrides) && result.fidelity_kind === "whole") result.assembly_role = "whole_validation";
  return result;
}

function register(coordinator) {
  coordinator.registerWorker({ worker_id: "worker", capabilities: ["recipe.author"], ownership: [] });
}

function claimAndAccept(coordinator, workId, result, workerId = "worker") {
  coordinator.claimWork(workId, workerId);
  return coordinator.acceptResult({ work_id: workId, module: result, worker_id: workerId, validation_evidence: ["host-contract"] });
}

test("keeps a playable baseline and deterministically promotes accepted compatible revisions only after a whole pass", () => {
  const upgrade = module("upgrade-core", 1, 8);
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const works = [work("upgrade-work"), work("whole-work", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["upgrade-work"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } })];
  const first = new CompositionSwarmCoordinator({ manifest: manifest({ upgrade_candidates: [upgrade, whole] }), work_items: works, now: () => "2026-09-08T00:00:01Z" });
  const second = new CompositionSwarmCoordinator({ manifest: manifest({ upgrade_candidates: [upgrade, whole] }), work_items: works, now: () => "2026-09-08T00:00:01Z" });
  register(first); register(second);
  const beforeWhole = claimAndAccept(first, "upgrade-work", upgrade);
  claimAndAccept(second, "upgrade-work", upgrade);
  assert.equal(beforeWhole.active_receipt.selected_modules[0].module_id, "baseline-core");
  const a = claimAndAccept(first, "whole-work", whole);
  const b = claimAndAccept(second, "whole-work", whole);
  assert.equal(a.active_receipt.selected_modules[0].module_id, "upgrade-core");
  assert.deepEqual(a.active_receipt, b.active_receipt);
  assert.equal(a.previous_receipt.selected_modules[0].module_id, "baseline-core");
});

test("releases successors only after accepted and validated dependencies, respecting capabilities and resource claims", () => {
  const candidate = module("candidate-core", 1, 2);
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(), work_items: [
    work("author", { resource_claims: [{ resource_id: "artifact.author", mode: "exclusive_write" }] }),
    work("validate", { fidelity_kind: "whole", depends_on_work_ids: ["author"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] }, resource_claims: [{ resource_id: "artifact.author", mode: "shared_read" }] }),
  ], manifest: manifest({ upgrade_candidates: [candidate] }) });
  coordinator.registerWorker({ worker_id: "writer", capabilities: ["recipe.author"], ownership: ["artifact.author"] });
  coordinator.registerWorker({ worker_id: "reviewer", capabilities: ["recipe.author"], ownership: [] });
  assert.deepEqual(coordinator.plan().ready_work_ids, ["author"]);
  coordinator.claimWork("author", "writer");
  coordinator.acceptResult({ work_id: "author", module: candidate, worker_id: "writer", validation_evidence: ["host-contract"] });
  assert.deepEqual(coordinator.plan().ready_work_ids, ["validate"]);
  assert.equal(coordinator.claimWork("validate", "reviewer").status, "running");
});

test("blocks invalidated descendants while retaining the last valid playable composite", () => {
  const base = module("baseline-core", 1, 1);
  const child = module("child-core", 1, 3, { provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [{ module_id: "baseline-core", revision: 1, content_sha256: base.content_sha256 }] } });
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const next = module("baseline-core", 2, 2);
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest({ baseline_modules: [base], upgrade_candidates: [child, whole, next], module_graph: [
    { module_ref: { module_id: base.module_id, revision: 1, content_sha256: base.content_sha256 }, depends_on: [] },
    { module_ref: { module_id: child.module_id, revision: 1, content_sha256: child.content_sha256 }, depends_on: [{ module_id: base.module_id, revision: 1, content_sha256: base.content_sha256 }] },
    { module_ref: { module_id: whole.module_id, revision: 1, content_sha256: whole.content_sha256 }, depends_on: [] },
    { module_ref: { module_id: next.module_id, revision: 2, content_sha256: next.content_sha256 }, depends_on: [] },
  ] }), work_items: [work("child-work"), work("whole-work", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["child-work"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } }), work("base-work")] });
  register(coordinator);
  claimAndAccept(coordinator, "child-work", child);
  claimAndAccept(coordinator, "whole-work", whole);
  const prior = coordinator.activeReceipt();
  const invalidated = claimAndAccept(coordinator, "base-work", next);
  assert.equal(invalidated.stale_module_refs[0].module_id, "child-core");
  assert.deepEqual(coordinator.activeReceipt(), prior, "last valid composite remains playable while child is stale");
});

test("machine-visibly refuses concurrent mutation of one Blender source and requires a stitch node", () => {
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(), work_items: [
    work("part-a", { resource_claims: [{ resource_id: "source.shared-blend", mode: "exclusive_write", media_type: "application/x-blender" }] }),
    work("part-b", { resource_claims: [{ resource_id: "source.shared-blend", mode: "exclusive_write", media_type: "application/x-blender" }] }),
  ] });
  coordinator.registerWorker({ worker_id: "one", capabilities: ["recipe.author"], ownership: ["source.shared-blend"] });
  coordinator.registerWorker({ worker_id: "two", capabilities: ["recipe.author"], ownership: ["source.shared-blend"] });
  coordinator.claimWork("part-a", "one");
  assert.throws(() => coordinator.claimWork("part-b", "two"), /resource claim conflict/);
  assert.equal(coordinator.projection().geometric_stitching.state, "unimplemented");
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest({ geometric_stitching: { state: "implemented", reason: "fixture" } }), work_items: [
    work("part-only", { resource_claims: [{ resource_id: "source.part-blend", mode: "exclusive_write", media_type: "application/x-blender" }] }),
  ] }), /stitch\/assembly\/validation node dependent/);
});

test("projects admitted v2 work through the existing v1 dispatcher but does not release unvalidated completion", async () => {
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(), work_items: [
    work("author"),
    work("whole-pass", { fidelity_kind: "whole", depends_on_work_ids: ["author"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] }, resource_claims: [] }),
  ] });
  coordinator.registerWorker({ worker_id: "writer", capabilities: ["recipe.author"], ownership: ["artifact.author"] });
  let received;
  const dispatched = await coordinator.dispatchReady({ async dispatchWorkOrder(order) {
    received = order;
    return { receipt: { status: "completed" } };
  } });
  assert.equal(dispatched[0].work_id, "author");
  assert.equal(received.schema_version, "1");
  assert.equal(received.encounter_id, "generic-composition");
  assert.deepEqual(coordinator.plan().ready_work_ids, []);
});

test("keeps failed work terminal and records declared fallback/rejection evidence after its whole pass", () => {
  const fallback = module("plugin-primary", 1, 9, {
    execution_kind: "managed_plugin", artifact: { uri: "https://example.test/plugin", sha256: "b".repeat(64), media_type: "application/octet-stream" }, entrypoint: "Plugin.Entry",
    fallback_module_refs: [{ module_id: "baseline-core", revision: 1, content_sha256: module("baseline-core", 1, 1).content_sha256 }],
  });
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest({ upgrade_candidates: [fallback, whole] }), work_items: [
    work("primary"), work("whole", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["primary"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } }), work("failed"),
  ] });
  register(coordinator);
  coordinator.claimWork("failed", "worker"); coordinator.failWork("failed", "fixture failure");
  claimAndAccept(coordinator, "primary", fallback);
  const result = claimAndAccept(coordinator, "whole", whole);
  assert.equal(result.active_receipt.fallback_provenance.used_fallback, true);
  assert.equal(result.active_receipt.rejected_conflicts[0].module_id, "plugin-primary");
  assert.deepEqual(coordinator.plan().ready_work_ids, []);
});

test("is deterministic for reverse completion of concurrently claimed component lanes", () => {
  const a = module("upgrade-a", 1, 2, { provides: ["generic.a"] });
  const b = module("upgrade-b", 1, 3, { provides: ["generic.b"] });
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const works = [work("a", { provided_capabilities: ["generic.a"] }), work("b", { provided_capabilities: ["generic.b"] }), work("whole", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["a", "b"], dependency_release: { required_status: "accepted_validated", required_provides: [] } })];
  const make = () => new CompositionSwarmCoordinator({ manifest: manifest({ upgrade_candidates: [a, b, whole] }), work_items: works, now: () => "2026-09-08T00:00:01Z" });
  const first = make(), second = make(); register(first); register(second);
  for (const coordinator of [first, second]) { coordinator.claimWork("a", "worker"); coordinator.claimWork("b", "worker"); }
  first.acceptResult({ work_id: "a", module: a, worker_id: "worker", validation_evidence: ["a"] }); first.acceptResult({ work_id: "b", module: b, worker_id: "worker", validation_evidence: ["b"] });
  second.acceptResult({ work_id: "b", module: b, worker_id: "worker", validation_evidence: ["b"] }); second.acceptResult({ work_id: "a", module: a, worker_id: "worker", validation_evidence: ["a"] });
  const left = claimAndAccept(first, "whole", whole), right = claimAndAccept(second, "whole", whole);
  assert.deepEqual(left.active_receipt, right.active_receipt);
});

test("rebuilds against an accepted replacement revision and promotes only after revalidation", () => {
  const base1 = module("baseline-core", 1, 1), base2 = module("baseline-core", 2, 2);
  const child1 = module("child-one", 1, 3, { provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [{ module_id: base1.module_id, revision: 1, content_sha256: base1.content_sha256 }] } });
  const child2 = module("child-two", 1, 4, { provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [{ module_id: base2.module_id, revision: 2, content_sha256: base2.content_sha256 }] } });
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const ref = (item) => ({ module_id: item.module_id, revision: item.revision, content_sha256: item.content_sha256 });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest({ baseline_modules: [base1], upgrade_candidates: [child1, base2, child2, whole], module_graph: [
    { module_ref: ref(base1), depends_on: [] }, { module_ref: ref(child1), depends_on: [ref(base1)] }, { module_ref: ref(base2), depends_on: [] }, { module_ref: ref(child2), depends_on: [ref(base2)] }, { module_ref: ref(whole), depends_on: [] },
  ] }), work_items: [
    work("child-one"), work("whole-one", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["child-one"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } }),
    work("base-two"), work("whole-base", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["base-two"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } }),
    work("child-two", { input_module_revisions: [ref(base2)] }), work("whole-two", { fidelity_kind: "whole", provided_capabilities: ["whole.validation"], depends_on_work_ids: ["child-two"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } }),
  ] });
  register(coordinator);
  claimAndAccept(coordinator, "child-one", child1); claimAndAccept(coordinator, "whole-one", whole);
  claimAndAccept(coordinator, "base-two", base2); claimAndAccept(coordinator, "whole-base", whole);
  claimAndAccept(coordinator, "child-two", child2); const rebuilt = claimAndAccept(coordinator, "whole-two", whole);
  assert.equal(rebuilt.active_receipt.selected_modules.find((entry) => entry.module_id === "child-two").revision, 1);
  assert.equal(coordinator.plan().dependency_edges.some((edge) => edge.state === "blocked"), false);
});

test("rejects undeclared work and altered content under an otherwise valid revision reference", () => {
  const candidate = module("candidate-core", 1, 2);
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest({ upgrade_candidates: [candidate] }), work_items: [work("candidate")] });
  register(coordinator); coordinator.claimWork("candidate", "worker");
  const altered = structuredClone(candidate); altered.inline_recipe.id = "altered"; altered.content_sha256 = compositionContentSha256(altered);
  assert.throws(() => coordinator.acceptResult({ work_id: "candidate", module: altered, worker_id: "worker", validation_evidence: ["host-contract"] }), /immutable manifest candidate/);
  assert.throws(() => coordinator.acceptResult({ work_id: "unknown", module: candidate, worker_id: "worker", validation_evidence: ["host-contract"] }), /closed manifest graph/);
});
