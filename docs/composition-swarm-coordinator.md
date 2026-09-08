# Generic composition swarm coordinator (v2)

`CompositionSwarmCoordinator` extends the existing v1 planner, dispatcher, and
`assembleEncounterPackage()` selection engine. It is not
an encounter-shape, character, vehicle, or UI system: a composition is an
arbitrary coherent whole built from independently owned, immutable revisions.

## Implemented boundary

`contracts/v2/` publishes closed manifests, immutable module revisions,
capability-aware work items, and assembly receipts. Every module reference is
the exact triple `(module_id, revision, content_sha256)`. Modules carry parent
revision provenance, compatibility/binding data, an owned fidelity layer and
composition unit, plus optional attachment seams. A manifest always supplies a
compatible baseline; higher-scoring accepted candidates are selected by the
existing deterministic assembler. The v2 receipt records exact selected hashes,
scores/reasons, rejected conflicts, validation evidence, fallback provenance,
and the v1 package hash that it adapted from.

`content_sha256` is the SHA-256 of the module's canonical JSON with that field
removed. Result admission recomputes it, then requires byte-for-byte equality
with the exact output revision declared by its work item. The shared catalog
admits that identity first, rejects a second hash for the same
`(module_id, revision)`, and requires every later revision to name its exact
immediate predecessor. Work inputs, manifest-graph parents, and module
provenance must be the same ordered set. Unknown work IDs, unplanned outputs,
and graph/provenance substitutions fail closed.

Work admission requires declared worker capabilities and immutable output-owner
identity. A work item declares its exact input and output revisions, output
owner, provided capabilities, dependencies,
the required terminal result (`accepted_validated`), and lexically ordered
shared-read/exclusive-write claims. Its `assembly_role` explicitly distinguishes
component refinement, whole validation, and geometric stitch validation. A v1 dispatcher completion is only
`completed_unvalidated`; it cannot release a successor. A caller must submit a
closed v2 module with validation evidence through `acceptResult()` first.
`dispatchReady()` projects the already-admitted work item into the existing v1
`EncounterWorkOrder`, then calls the existing `EncounterDispatcher`; it does
not create a second dispatcher. Independent ready items are launched
concurrently. Worker selection is stable by worker ID but skips workers that do
not own the output or exclusive resources, and thrown dispatches release their
claims into a terminal failed result.

The fidelity policy starts component refinement after the baseline whole pass.
An accepted component requires a subsequent whole assemble/validate pass. When
that pass is claimed, the coordinator uses the canonical assembler to create an
immutable snapshot receipt over the exact selected module revisions and next
package revision. The worker must return that snapshot hash; any intervening
selection change makes acceptance fail. Accepting the exact whole pass advances
the assembler-owned package revision and reopens component refinement.

When a new revision supersedes an upstream revision, graph descendants and
work items that consume them are marked stale. A separately declared immutable
replacement descendant can be admitted only after its exact new parent revision
is accepted, then it needs another whole pass before promotion. The active
receipt stays playable until that rebuild/revalidation succeeds, so an
invalidated partial upgrade cannot replace the last coherent whole.

`projection()` is the build-room contract: it exposes the active receipt and
receipt history; every pending, running, completed-unvalidated,
accepted-validated, failed, or stale work item; stable dependency edges;
workers/capabilities/ownership; live claims; evidence; deadlines and terminal
timers; selection reasons; fidelity phase; and `geometric_stitching` state.
There are no human approval gates. Optional human steering belongs at the
Responses API path outside this coordinator.

## Parallel 3D rule and remaining gap

Two workers cannot obtain an `exclusive_write` claim to one `source.*.blend`
resource. Parallel geometry must instead use independently owned immutable
parts/layers followed by an explicit stitch/assembly/validation item. The
current repository has no geometric stitcher or exact-input validator:
manifests and receipts must say
`geometric_stitching.state: "unimplemented"`, which is machine-visible and
prevents a false claim of merged geometry. The current schemas and coordinator
reject both `implemented` and `geometric_stitch_validation`; enabling those
states requires a future validator contract whose receipt binds exact input
artifact hashes and seam results.

The coordinator's work/claim/receipt lifecycle is still an in-memory
orchestration proof, while generic module revision identity is authoritative in
the injected catalog port (SQLite locally; the same port can move to Railway).
It does not yet persist claims/receipts across process restart, validate a host
import, perform geometric stitching, or deploy infrastructure. Durable
coordinator state and a worker callback adapter are still required before
remote swarm operation.
