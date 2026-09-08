# Myth Maker encounter generator

Myth Maker is an encounter-generation service for an existing Unity FPS. It
creates the next encounter while the player is in the preceding one (or ahead
of play when capacity permits): novel actors, variants, loot, encounter spaces,
abilities, and the data or assets that describe them.

This repository is **only** the encounter generator. It does not own the FPS's
combat, movement, weapons, save system, matchmaking, Unity project, or release
pipeline. Generated output is an untrusted candidate until the host game
validates its contract and explicitly accepts it.

## Hackathon project plan

[`docs/encounter-runtime-project-plan.md`](docs/encounter-runtime-project-plan.md)
defines the draft-by-deadline encounter model, concrete checkpoints, and work
that can proceed in parallel. It also records the demo bootstrap: selected
Mech-project assets and animation clips will seed the encounter catalogs, while
the design itself remains generic.

The first stable machine-readable interchange boundary is in
[`contracts/`](contracts/). It covers host capabilities, encounter requests,
parallel work orders, worker events, composable modules, and frozen playable
packages. These contracts deliberately support recipe, runtime-asset, managed
plugin, and remote-logic execution without encoding any particular encounter
shape or genre.

## Implemented starting architecture

```text
Encounter coordinator
  -> Cloudflare Worker + component ownership lease
  -> external encounter agents / computer-use dispatcher
  -> external computer-use workers
  -> future GPU asset-generation runtime
  -> review / Unity import / continuation
```

The lightweight Cloudflare runtime lives in [`src/worker.js`](src/worker.js).
It keeps request authorization, idempotency, and one active job per
project/component in a Durable Object, then forwards opaque computer-use work to
an external dispatcher. It does not run a model or Blender itself; agents outside
Cloudflare remain responsible for deciding what to ask the computer-use workers
to do. The GPU/Blender worker integration remains deliberately unshipped until
its desktop runtime has a passing cloud smoke test.

## Architecture reference and engineering audit

The intended end-state is documented in Miro as [Boss Encounter Generation —
Original Architecture](https://miro.com/app/board/uXjVHpB5q5w=/). Despite the
board's historical title, the architecture is for generic encounters: a
collector agent, a per-asset swarm manager, semantic entity knowledge, separate
asset and animation stores, and Blender/animation workers. It is a useful
product-flow sketch, but not yet an executable architecture.

### What is implemented versus sketched

| Miro responsibility | Evidence in this repository | Assessment |
| --- | --- | --- |
| Encounter intake and scoped ownership | `POST /v1/encounters` routes work to a Durable Object named by `project_id:component_id`. | Implemented, with a clear concurrency seam. |
| Job submission and external work dispatch | `EncounterCoordinator` validates a small submission, records a job, and sends the opaque `computer_use` request to one dispatcher. | Implemented as a narrow ingress adapter. |
| Collector planning and semantic inventory | No collector implementation, entity schema, query adapter, or inventory store. | Not implemented. |
| Asset/animation swarm and artifact stores | No worker protocol, artifact manifest, asset database, animation database, or provenance/version model. | Not implemented. |
| Worker inspection and steering | No `GET/POST /worker/[id]`, callback, event stream, or state transition beyond `queued`/`blocked`. | Not implemented. |
| Unity import, review, and acceptance | Deliberately outside this repository; the README correctly treats generated output as untrusted. | Correctly deferred to the host game. |

### Strengths

- **A narrow, deep coordination module.** One request interface hides
  authorization, validation, idempotency, component serialization, and
  dispatch. That creates useful locality for the implemented slice.
- **Collision control at the right initial granularity.** Naming the Durable
  Object from `project_id:component_id` prevents two active jobs for the same
  component from dispatching concurrently.
- **Safe trust boundary.** Ingress authorization is checked before routing,
  and the Cloudflare runtime forwards opaque computer-use work rather than
  pretending to run a model or Blender at the edge.
- **Explicit acceptance boundary.** Generated output remains a candidate until
  the owning Unity project validates and accepts it; this avoids treating
  generated assets as production-ready by default.

### Material weaknesses and risks

| Priority | Weakness | Why it matters | Recommended direction |
| --- | --- | --- | --- |
| P0 | Dispatch is not durably acknowledged end-to-end. A crash after the dispatcher receives a request but before the coordinator records `queued` can cause a re-dispatch; a failed dispatch has no retry policy or dead-letter record. | Expensive or destructive desktop work can run twice, while jobs can also remain permanently `dispatching` or `blocked`. | Use a stable externally supplied work ID, a transactional/outbox-style dispatch record, dispatcher-side deduplication, bounded retries, and an explicit terminal/recovery policy. |
| P1 | The lifecycle stops at `queued`. There is no callback/event interface, worker identity, heartbeat, cancellation, steering, or result acceptance state. | The public job-status route cannot prove progress, completion, or which worker performed the work. | Define a versioned job state machine and a signed worker-event adapter before adding a fleet. |
| P1 | `computer_use` is an untyped opaque object. There is no encounter spec, deterministic seed, requested-output manifest, compatibility target, or acceptance criteria. | The system cannot reliably decide whether an asset answers the encounter request or is compatible with the host game. | Introduce a versioned work-order and result-manifest contract; make validation operate on that contract, not free-form prompts. |
| P1 | The Miro semantic, asset, and animation stores have no source-of-truth or provenance design. | Reuse, dependency resolution, rig compatibility, licensing, and rollback are undefined; a later swarm would amplify inconsistency. | Start with immutable artifact manifests and a semantic catalog keyed by stable IDs, hashes, compatibility metadata, and parent derivations. |
| P1 | Component-level serialization does not protect shared resources such as rigs, materials, environments, or an asset catalog. | Parallel jobs can still conflict through dependencies outside their own component IDs. | Model resource ownership explicitly and acquire ordered leases for all mutable/shared resources, or make generated artifacts immutable until acceptance. |
| P2 | Idempotency keys are not bound to a request fingerprint and are persisted only after a successful dispatch. | Reusing a key with different content silently returns the prior result; retry behavior differs between successful and failed attempts. | Persist a canonical request hash with the key and reject mismatches; define retry identity before dispatch. |
| P2 | There are no timeouts, resource budgets, audit trail, tracing, or operational metrics. | A swarm cannot be cost-controlled, debugged, or safely scaled without knowing each attempt, artifact, and transition. | Add structured event records, correlation IDs, deadline/budget fields, and minimum success/failure/latency metrics. |
| P2 | The test suite currently proves only route scoping and one happy-path idempotency case. | Authorization, malformed/changed retries, dispatch failures, recovery, and lifecycle behavior can regress unnoticed. | Add contract tests for every state transition and failure mode; later add an isolated dispatcher integration test. |

### Recommended sequencing

Do not begin by spawning Blender or animation agents. First make the
coordinator a trustworthy module: specify the versioned work order and result
manifest, persist a recoverable state machine and immutable event history, and
bind idempotency to the canonical request. Then add one dispatcher adapter with
receipt/callback verification. Only once its artifacts can be validated and
accepted by the Unity host should semantic reuse, asset generation, and swarm
fan-out be introduced.

This preserves the Miro design's strongest idea—specialized generation behind a
small encounter request—without making the public interface expose the swarm's
unbounded operational complexity.

## Local validation

```sh
npm test
```

The suite covers Cloudflare request routing, idempotent dispatch, and structural
contract integrity. It does not make cloud calls or prove a deployed account.
