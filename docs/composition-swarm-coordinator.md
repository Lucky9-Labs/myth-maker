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
with the predeclared manifest candidate and requires the result provenance to
name every exact input revision declared by its work item. Unknown work IDs and
unplanned module revisions fail closed.

Work admission requires declared worker capabilities and owner identity. A work
item declares its exact input revisions, provided capabilities, dependencies,
the required terminal result (`accepted_validated`), and lexically ordered
shared-read/exclusive-write claims. Its `assembly_role` explicitly distinguishes
component refinement, whole validation, and geometric stitch validation. A v1 dispatcher completion is only
`completed_unvalidated`; it cannot release a successor. A caller must submit a
closed v2 module with validation evidence through `acceptResult()` first.
`dispatchReady()` projects the already-admitted work item into the existing v1
`EncounterWorkOrder`, then calls the existing `EncounterDispatcher`; it does
not create a second dispatcher.

The fidelity policy starts component refinement after the baseline whole pass.
An accepted component requires a subsequent whole assemble/validate pass;
accepting that whole pass reopens component refinement. This prevents a local
lane from remaining perpetually ahead of coherent-whole validation.

When a new revision supersedes an upstream revision, graph descendants and
work items that consume them are marked stale. A separately declared immutable
replacement descendant can be admitted only after its exact new parent revision
is accepted, then it needs another whole pass before promotion. The active
receipt stays playable until that rebuild/revalidation succeeds, so an
invalidated partial upgrade cannot replace the last coherent whole.

`projection()` is the build-room contract: it exposes the active receipt,
running refinement lanes, workers/capabilities/ownership, dependency edge
states, selection reasons, fidelity phase, and `geometric_stitching` state.
There are no human approval gates. Optional human steering belongs at the
Responses API path outside this coordinator.

## Parallel 3D rule and remaining gap

Two workers cannot obtain an `exclusive_write` claim to one `source.*.blend`
resource. Parallel geometry must instead use independently owned immutable
parts/layers followed by an explicit stitch/assembly/validation item. The
current repository has no geometric stitcher: manifests and receipts must say
`geometric_stitching.state: "unimplemented"`, which is machine-visible and
prevents a false claim of merged geometry. If a manifest eventually declares
stitching implemented, any Blender-claim plan is rejected unless it contains a
whole `geometric_stitch_validation` node.

The coordinator is local, in-memory orchestration proof only. It does not yet
persist claims/receipts across process restart, validate a host import, perform
geometric stitching, or deploy any infrastructure. The catalog remains the
longer-term durable artifact/revision store; production persistence and a
worker callback adapter are still required before remote swarm operation.
