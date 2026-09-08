# Generic WorkGraph dispatcher

`planEncounterWork(spec)` produces deterministic, published-v2
`EncounterWorkOrder` records for four generic lanes: a source fragment, an
animation recipe, a combat recipe, and a validation report. The first three
have no dependencies and the validation order depends on all three. It uses
only the supplied `EncounterSpec` fields; fixture aesthetics are not planner
inputs or schema branches.

V0 emits one `body-source` work item only. It does not yet split geometry into
multiple body parts or provide a stitch/join lane; that remains a planner
extension rather than an implied capability.

`EncounterDispatcher` accepts an injected worker backend and receipt store.
It launches ready work concurrently, preserves each worker's ordered v1 events,
and retains a terminal receipt under the stable `work_id`. A repeated delivery
returns that receipt and never launches the worker again. The built-in
`InMemoryReceiptStore` is deliberately local/test-only. Railway must inject a
durable store with atomic `claim(workId)`, `get(workId)`, and
`complete(workId, receipt)` semantics (including a crash-recoverable lease)
before claiming recovery across a process restart or instance boundary.

`createRailwayDispatchHandler({ dispatcher })` is the control-plane HTTP seam.
It accepts the coordinator's raw v2 work order and verifies the same stable
`x-work-id` header and bearer token that `WorkDispatcherAdapter` sends in
coordinator PR #6. It returns `202` for a new local launch and `200` with the
stored receipt for a deduplicated retry. Its required event sink posts each
stored event in sequence to coordinator #6's authenticated worker-event route;
the coordinator's event IDs make a replay safe after a callback interruption.
The coordinator remains responsible for dependencies and event persistence.

The standalone dispatcher validates closed v1 WorkerEvents and preserves their
per-worker order, but deliberately does **not** enforce `resource_leases`.
Coordinator PR #6 owns lease admission before it delivers a work order; do not
expose this adapter directly to uncoordinated lease-bearing work.

Run the offline concurrency proof:

```sh
npm run example:workgraph
```

It launches three real local Node child processes for the independent lanes and
prints the graph, events, receipts, and start/complete timestamps. This is not
Modal, GPU, Blender, Cloudflare, or deployed-Railway evidence.
