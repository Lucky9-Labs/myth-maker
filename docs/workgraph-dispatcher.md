# Generic WorkGraph dispatcher

`planEncounterWork(spec)` produces deterministic, published-v1
`EncounterWorkOrder` records for four generic lanes: a source fragment, an
animation recipe, a combat recipe, and a validation report. The first three
have no dependencies and the validation order depends on all three. It uses
only the supplied `EncounterSpec` fields; fixture aesthetics are not planner
inputs or schema branches.

`EncounterDispatcher` accepts an injected worker backend and receipt store.
It launches ready work concurrently, preserves each worker's ordered v1 events,
and retains a completed receipt under the stable `work_id`. A repeated delivery
returns that receipt and never launches the worker again. The built-in `Map`
store is deliberately local/test-only. Railway must inject a durable store with
`get(workId)` and `set(workId, receipt)` semantics before claiming recovery
across a process restart.

`createRailwayDispatchHandler({ dispatcher })` is the control-plane HTTP seam.
It accepts the coordinator's raw v1 work order and verifies the same stable
`x-work-id` header that `WorkDispatcherAdapter` sends in coordinator PR #6.
It returns `202` for a new local launch and `200` with the stored receipt for a
deduplicated retry. The coordinator remains responsible for dependencies and
worker-event persistence; this adapter never claims a local result was
delivered back to Cloudflare.

Run the offline concurrency proof:

```sh
npm run example:workgraph
```

It launches three real local Node child processes for the independent lanes and
prints the graph, events, receipts, and start/complete timestamps. This is not
Modal, GPU, Blender, Cloudflare, or deployed-Railway evidence.
