import assert from "node:assert/strict";
import test from "node:test";

import { CompositionSwarmCoordinator, compositionContentSha256 } from "../src/composition-swarm-coordinator.js";

const host = {
  schema_version: "1", host_id: "generic-host", host_build: "1", platform: "linux",
  scripting_backend: "il2cpp", execution_kinds: ["recipe"], loaders: ["recipe-loader"],
  contracts: ["generic.core.v1"], limits: { memory_mb: 64, preload_seconds: 1 },
};
const ref = (value) => ({ module_id: value.module_id, revision: value.revision, content_sha256: value.content_sha256 });

function module(id, revision, score, overrides = {}) {
  const result = {
    schema_version: "2", module_id: id, revision, content_sha256: "0".repeat(64),
    execution_kind: "recipe", provides: ["generic.core"], requires: ["generic.core.v1"], conflicts: [],
    compatibility: { host_contract_version: "1", bindings: { "recipe-loader": "v1" } },
    quality: { tier: 1, score, evidence: ["validated:fixture"] }, inline_recipe: { id },
    fallback_module_refs: [], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [] },
    fidelity: { layer_id: "part", composition_unit: "part", kind: "component" },
    ...overrides,
  };
  result.content_sha256 = compositionContentSha256(result);
  return result;
}

function baseline() {
  return module("baseline-core", 1, 1, { fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
}

function manifest(base, upgrades = [], overrides = {}) {
  return {
    schema_version: "2", manifest_id: "generic-manifest", composition_id: "generic-composition",
    host_capabilities: host, baseline_modules: [base], upgrade_candidates: upgrades,
    module_graph: [base, ...upgrades].map((candidate) => ({ module_ref: ref(candidate), depends_on: candidate.provenance.parent_module_refs })),
    required_provides: ["generic.core"], geometric_stitching: { state: "unimplemented", reason: "no exact-input geometry validator" },
    ...overrides,
  };
}

function work(id, output, overrides = {}) {
  const kind = output.fidelity.kind === "whole" ? "whole" : "component";
  return {
    schema_version: "2", work_id: id, lane: "refinement", deadline_at: "2026-09-09T00:00:00Z",
    required_worker_capabilities: ["recipe.author"], provided_capabilities: [...output.provides],
    input_module_revisions: output.provenance.parent_module_refs, output_module_ref: ref(output),
    output_owner: `composition.${output.fidelity.composition_unit}`, depends_on_work_ids: [],
    dependency_release: { required_status: "accepted_validated", required_provides: [] }, resource_claims: [],
    fidelity_kind: kind, assembly_role: kind === "whole" ? "whole_validation" : "component_refinement",
    ...overrides,
  };
}

function register(coordinator, workerId = "worker", ownership = ["composition.part", "composition.whole"]) {
  coordinator.registerWorker({ worker_id: workerId, capabilities: ["recipe.author"], ownership });
}

function acceptClaimed(coordinator, workId, result, workerId = "worker", evidence = ["host-contract"]) {
  return coordinator.acceptResult({ work_id: workId, module: result, worker_id: workerId, validation_evidence: evidence });
}

function claimAndAccept(coordinator, workId, result, workerId = "worker", evidence = ["host-contract"]) {
  const claim = coordinator.claimWork(workId, workerId);
  return coordinator.acceptResult({ work_id: workId, module: result, worker_id: workerId, validation_evidence: evidence, validated_snapshot_sha256: claim.validation_snapshot?.snapshot_sha256 });
}

test("promotes exact accepted component revisions only after validating the claimed whole snapshot", () => {
  const base = baseline();
  const upgrade = module("upgrade-core", 1, 8);
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(upgrade)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base, [upgrade, whole]), work_items: [work("upgrade-work", upgrade), work("whole-work", whole, { depends_on_work_ids: ["upgrade-work"], dependency_release: { required_status: "accepted_validated", required_provides: ["generic.core"] } })], now: () => "2026-09-08T00:00:01Z" });
  register(coordinator);
  const beforeWhole = claimAndAccept(coordinator, "upgrade-work", upgrade);
  assert.equal(beforeWhole.active_receipt.selected_modules[0].module_id, "baseline-core");
  const claim = coordinator.claimWork("whole-work", "worker");
  assert.throws(() => coordinator.acceptResult({ work_id: "whole-work", module: whole, worker_id: "worker", validation_evidence: ["host-contract"], validated_snapshot_sha256: "a".repeat(64) }), /exact claimed composition snapshot/);
  const promoted = coordinator.acceptResult({ work_id: "whole-work", module: whole, worker_id: "worker", validation_evidence: ["host-contract"], validated_snapshot_sha256: claim.validation_snapshot.snapshot_sha256 });
  assert.equal(promoted.active_receipt.selected_modules.some((entry) => entry.module_id === "upgrade-core"), true);
  assert.equal(promoted.active_receipt.source_package_revision, 2);
});

test("binds graph parents, exact output, fidelity kind, and immutable output ownership", () => {
  const base = baseline();
  const parent = module("parent", 1, 2, { provides: ["generic.parent"] });
  const child = module("child", 1, 3, { provides: ["generic.child"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(parent)] } });
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest(base, [parent, child]), work_items: [work("child", child, { input_module_revisions: [] })] }), /work inputs, graph parents/);
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest(base, [parent]), work_items: [work("wrong", parent, { fidelity_kind: "whole", assembly_role: "whole_validation" })] }), /fidelity kind/);
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base, [parent, child]), work_items: [work("parent", parent), work("child", child, { depends_on_work_ids: ["parent"] })] });
  register(coordinator, "unowned", ["composition.whole"]);
  assert.throws(() => coordinator.claimWork("parent", "unowned"), /does not own composition output/);
  register(coordinator);
  coordinator.claimWork("parent", "worker");
  assert.throws(() => coordinator.acceptResult({ work_id: "parent", module: child, worker_id: "worker", validation_evidence: ["host"] }), /exact declared output/);
});

test("dispatches independent lanes concurrently, chooses an actual owner, and cleans failed claims", async () => {
  const base = baseline();
  const a = module("part-a", 1, 2, { provides: ["generic.a"], fidelity: { layer_id: "a", composition_unit: "a", kind: "component" } });
  const b = module("part-b", 1, 2, { provides: ["generic.b"], fidelity: { layer_id: "b", composition_unit: "b", kind: "component" } });
  const failed = module("part-failed", 1, 2, { provides: ["generic.failed"], fidelity: { layer_id: "failed", composition_unit: "failed", kind: "component" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base, [a, b, failed]), work_items: [work("a", a), work("b", b), work("failed", failed)] });
  register(coordinator, "a-no-owner", []);
  register(coordinator, "z-owner", ["composition.a", "composition.b", "composition.failed"]);
  let inFlight = 0; let maxInFlight = 0;
  const results = await coordinator.dispatchReady({ async dispatchWorkOrder(order) { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((resolve) => setTimeout(resolve, 25)); inFlight -= 1; if (order.work_id === "failed") throw new Error("transport failed"); return { receipt: { status: "completed" } }; } });
  assert.ok(maxInFlight > 1);
  assert.equal(results.every((entry) => entry.worker_id === "z-owner"), true);
  assert.equal(coordinator.projection().work_items.find((entry) => entry.work_id === "failed").status, "failed");
  assert.equal(coordinator.projection().resource_claims.length, 0);
});

test("catalog rejects conflicting identities and enforces immediate revision parents", () => {
  const base = baseline();
  const first = module("revisioned", 1, 2);
  const conflicting = module("revisioned", 1, 3, { inline_recipe: { id: "different" } });
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest(base, [first, conflicting]) }), /one immutable content hash/);
  const skipped = module("revisioned", 2, 3);
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest(base, [skipped]) }), /follow the current catalog revision/);
});

test("enforces required provides on every canonical assembler package", () => {
  const base = baseline();
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest(base, [], { required_provides: ["generic.missing"] }) }), /missing required provides/);
});

test("a mismatched whole snapshot fails before work or resource ownership is mutated", () => {
  const base = baseline();
  const rejected = module("rejected-plugin", 1, 9, { execution_kind: "managed_plugin", artifact: { uri: "https://example.test/plugin", sha256: "c".repeat(64), media_type: "application/octet-stream" }, entrypoint: "Plugin.Entry" });
  const whole = module("whole", 1, 0, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(base), ref(rejected)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base, [rejected, whole]), work_items: [work("rejected", rejected), work("whole", whole, { depends_on_work_ids: ["rejected"], resource_claims: [{ resource_id: "composition.snapshot", mode: "exclusive_write" }] })] });
  register(coordinator, "worker", ["composition.part", "composition.whole", "composition.snapshot"]);
  claimAndAccept(coordinator, "rejected", rejected);
  assert.throws(() => coordinator.claimWork("whole", "worker"), /exact selected composition snapshot/);
  const projected = coordinator.projection();
  assert.equal(projected.work_items.find((entry) => entry.work_id === "whole").status, "pending");
  assert.deepEqual(projected.resource_claims, []);
});

test("keeps full dependency topology, status, evidence, deadlines, and terminal timers in projection", () => {
  let now = "2026-09-08T00:00:00Z";
  const base = baseline();
  const component = module("component", 1, 2, { provides: ["generic.component"] });
  const whole = module("whole", 1, 0, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: now, parent_module_refs: [ref(base), ref(component)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base, [component, whole]), work_items: [work("component", component), work("whole", whole, { depends_on_work_ids: ["component"] })], now: () => now });
  register(coordinator);
  assert.equal(coordinator.projection().dependency_edges[0].state, "blocked");
  coordinator.claimWork("component", "worker"); now = "2026-09-08T00:00:02Z"; acceptClaimed(coordinator, "component", component);
  const projection = coordinator.projection();
  assert.equal(projection.dependency_edges[0].state, "satisfied");
  assert.equal(projection.work_items.find((entry) => entry.work_id === "component").elapsed_ms, 2000);
  assert.deepEqual(projection.work_items.find((entry) => entry.work_id === "component").validation_evidence, ["host-contract"]);
  assert.equal(projection.work_items.find((entry) => entry.work_id === "whole").deadline_at, "2026-09-09T00:00:00Z");
});

test("rejects implemented geometric stitching until an exact-input validator exists", () => {
  const base = baseline();
  assert.throws(() => new CompositionSwarmCoordinator({ manifest: manifest(base, [], { geometric_stitching: { state: "implemented", reason: "manifest assertion" } }) }), /remains unimplemented/);
});

test("invalidates descendants, permits exact stale repair, and retains the playable whole", () => {
  const base1 = baseline();
  const child1 = module("child-one", 1, 3, { provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(base1)] } });
  const whole1 = module("whole-one", 1, 0, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(child1)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const base2 = module("baseline-core", 2, 2, { provenance: { producer: "fixture", created_at: "2026-09-08T00:00:01Z", parent_module_refs: [ref(base1)] } });
  const child2 = module("child-two", 1, 4, { provenance: { producer: "fixture", created_at: "2026-09-08T00:00:01Z", parent_module_refs: [ref(base2)] } });
  const whole2 = module("whole-two", 1, 1, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:01Z", parent_module_refs: [ref(child2)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base1, [child1, whole1, base2, child2, whole2]), work_items: [work("child-one", child1), work("whole-one", whole1, { depends_on_work_ids: ["child-one"] }), work("base-two", base2), work("child-two", child2, { depends_on_work_ids: ["base-two"] }), work("whole-two", whole2, { depends_on_work_ids: ["child-two"] })] });
  register(coordinator);
  claimAndAccept(coordinator, "child-one", child1); claimAndAccept(coordinator, "whole-one", whole1);
  const prior = coordinator.activeReceipt();
  const invalidated = claimAndAccept(coordinator, "base-two", base2);
  assert.equal(invalidated.stale_module_refs[0].module_id, "child-one");
  assert.deepEqual(coordinator.activeReceipt(), prior);
  assert.deepEqual(coordinator.plan().ready_work_ids, ["child-two"]);
  claimAndAccept(coordinator, "child-two", child2); const rebuilt = claimAndAccept(coordinator, "whole-two", whole2);
  assert.equal(rebuilt.active_receipt.selected_modules.some((entry) => entry.module_id === "child-two"), true);
});

test("recomposition is deterministic across reverse component completion", () => {
  const base = baseline();
  const a = module("upgrade-a", 1, 2, { provides: ["generic.a"], fidelity: { layer_id: "a", composition_unit: "a", kind: "component" } });
  const b = module("upgrade-b", 1, 3, { provides: ["generic.b"], fidelity: { layer_id: "b", composition_unit: "b", kind: "component" } });
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(base), ref(a), ref(b)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const works = [work("a", a), work("b", b), work("whole", whole, { depends_on_work_ids: ["a", "b"] })];
  const make = () => new CompositionSwarmCoordinator({ manifest: manifest(base, [a, b, whole]), work_items: works, now: () => "2026-09-08T00:00:01Z" });
  const first = make(); const second = make(); register(first, "worker", ["composition.a", "composition.b", "composition.whole"]); register(second, "worker", ["composition.a", "composition.b", "composition.whole"]);
  first.claimWork("a", "worker"); first.claimWork("b", "worker"); second.claimWork("a", "worker"); second.claimWork("b", "worker");
  acceptClaimed(first, "a", a); acceptClaimed(first, "b", b); acceptClaimed(second, "b", b); acceptClaimed(second, "a", a);
  assert.deepEqual(claimAndAccept(first, "whole", whole).active_receipt, claimAndAccept(second, "whole", whole).active_receipt);
});

test("records fallback and rejection evidence after exact whole validation", () => {
  const base = baseline();
  const primary = module("plugin-primary", 1, 9, { execution_kind: "managed_plugin", artifact: { uri: "https://example.test/plugin", sha256: "b".repeat(64), media_type: "application/octet-stream" }, entrypoint: "Plugin.Entry", fallback_module_refs: [ref(base)] });
  const whole = module("whole-validation", 1, 0, { provides: ["whole.validation"], provenance: { producer: "fixture", created_at: "2026-09-08T00:00:00Z", parent_module_refs: [ref(base)] }, fidelity: { layer_id: "whole", composition_unit: "whole", kind: "whole" } });
  const coordinator = new CompositionSwarmCoordinator({ manifest: manifest(base, [primary, whole]), work_items: [work("primary", primary), work("whole", whole, { depends_on_work_ids: ["primary"] })] });
  register(coordinator);
  claimAndAccept(coordinator, "primary", primary); const result = claimAndAccept(coordinator, "whole", whole);
  assert.equal(result.active_receipt.fallback_provenance.used_fallback, true);
  assert.equal(result.active_receipt.rejected_conflicts[0].module_id, "plugin-primary");
});
