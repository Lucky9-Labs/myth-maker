# Generic WorkGraph dispatcher

`planEncounterWork(spec)` produces deterministic, published-v2
`EncounterWorkOrder` records plus a planning-only `component_graph`. The graph
is parameterized solely by the supplied `EncounterSpec`: one central body,
two body segments per desired role, one critical-spot module and motion clip
per desired role, then material binding, arena envelope, combat recipe,
assembly, and validation. No lane, identifier, or fallback refers to a
particular creature or genre.

Every component has a stable encounter-and-slot identity, a content-addressed
immutable revision, and explicit attachment/socket contracts. Workers receive
that contract in their closed v2 `instruction` field; the published work-order
schema is unchanged. Independent component work orders have no dependencies.
Assembly depends on their terminal receipts, then validation depends on
assembly. `assembleEncounterInputs(graph, receipts)` is a planning-only,
delivery-order-independent input plan: it names a completed component's
*planned* module or that component's named fallback, so a failed or absent
horizontal lane does not deadlock later assembly. It is not an
`AssemblyReceipt`, does not treat a worker status as artifact acceptance, and
must be passed through the existing module/package assembler once workers emit
real candidate modules.

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

It launches real local Node child processes for every independent lane and
prints the graph, events, receipts, and start/complete timestamps. This is not
Modal, GPU, Blender, Cloudflare, or deployed-Railway evidence.

For the demo-scale one-shot receipt, run:

```sh
npm run demo:encounter-stress -- --output .local-stress-artifacts/one-shot.json
```

That command records observed local Node-process overlap and immutable
component-plan/dispatcher receipts. It explicitly records Blender GUI, local
Blender CLI, Modal remote, Unity import, and host combat as `not_run`; it is a
planning/dispatch simulation, not generated-asset, package-assembly, or
player-facing proof.
