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
that can proceed in parallel. Its immediate, authoritative target is **D0**:
one generic component work order from Build Room must produce a local
Blender-generated `.blend`, PNG render, and GLB; pass hash and strict GLB
validation; create a newly produced immutable catalog revision; compose into an
`AssemblyReceipt`; visibly render and select the package in Build Room; accept
a later compatible worker revision for the same encounter; and reach simple
host runtime combat where player and encounter can damage one another. The
tentacled creature is only the first demo blueprint, not a special encounter
type. Until that chain is demonstrated, infrastructure polish, broad taxonomy,
and advanced steering are not milestone progress. Markdown is authoritative
implementation direction; Miro remains diagrams only.

The plan also records the demo bootstrap: selected Mech-project assets and
animation clips will seed the encounter catalogs, while the design itself
remains generic.

Two explicit, unimplemented follow-on workstreams keep the asset boundary
clear: a **Texture/Material Worker** will publish immutable texture-set and
material-binding revisions, while an **Arena Worker** will publish immutable
arena revisions linked to the encounter semantic entity. Catalog metadata and
receipts describe and verify those revisions; they are not a blob store. The
plan defines the required provenance, compatibility, acceptance, and Build
Room evidence without treating alien-oceanic styling as schema or as an
implementation claim.

The first stable machine-readable interchange boundary is in
[`contracts/`](contracts/). It covers host capabilities, encounter requests,
parallel work orders, worker events, composable modules, and frozen playable
packages. These contracts deliberately support recipe, runtime-asset, managed
plugin, and remote-logic execution without encoding any particular encounter
shape or genre.

## Concept-first production gate

The canonical future production boundary is the closed, generic
[`ConceptFirstAssetProductionGate`](contracts/v1/concept-first-asset-production-gate.schema.json).
Before a new model, material/texture, animation, arena, audio, effect, or any
future asset type is dispatched, its worker brief must pin immutable
`EncounterIntent`, `ArtDirectionRevision`, and generated-or-selected
`ConceptReferenceRevision` records plus acceptance constraints. Art direction
defines the player-facing beat, silhouette, scale, palette/material cues, arena
relationship, animation/combat beats, and constraints—not merely an aesthetic
prompt.

An immutable candidate records that lineage, interpretation constraints,
provenance, and source/runtime acceptance independently. The assembler must
reject missing or incompatible lineage before selection and leave an
inspectable selection, rejection, deviation, or fallback receipt. The one
exception is a recorded, time-bounded reuse or maintenance waiver with a
bounded reason, approver, and asset scope.

This is an adoption contract and architectural gate, not a claim about the
currently active Build Room or worker implementation. The current D0 local
Blender body output is explicitly **pre-gate bootstrap evidence**: it proves a
bounded local artifact path, not that concept-first dispatch, assembly, or
cloud execution exists. When adopted, Build Room must expose the visual concept
→ candidate → assembled-package lineage while preserving its existing honest
local, remote, reported, and simulated evidence labels.

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
to do. The GPU/Blender **cloud** worker integration remains deliberately
unshipped until its desktop runtime has a passing cloud smoke test. The Build
Room's optional local Blender CLI slice is a non-deployed, receipt-bearing
process proof; it does not contact Cloudflare or Modal and does not establish a
cloud, Unity-load, or player-facing acceptance claim.

## Infrastructure foundation

[`infra/terraform/`](infra/terraform/) contains an offline-reviewable,
environment-oriented Cloudflare and Railway foundation. It names the ingress
Worker, preserves the coordinator Durable Object migration, and models an empty
Railway dispatcher seam without claiming an image, endpoint, or domain exists.
Modal remains code-deployed; [`modal/infrastructure.py`](modal/infrastructure.py)
generates the non-secret configuration handoff across all three platforms.

```sh
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
python3 modal/infrastructure.py --environment dev --check-files
```

These commands are offline-safe except for Terraform downloading pinned provider
binaries. They never create remote resources. See
[`infra/terraform/README.md`](infra/terraform/README.md) for the explicit
credentialed bootstrap and remote-state guidance.

The internal, generic V0 catalog persistence seam is documented in
[`docs/catalog-v0.md`](docs/catalog-v0.md). It uses one SQLite database for
semantic entities, source/runtime assets, and animations, while encounter hit
evidence remains an operational projection rather than a fourth catalog.

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
| Collector planning and semantic inventory | Internal V0 SQLite catalog stores append-only semantic entities, relationships, and affordances; `findCompatibleParts()` is the planner-facing query seam. | Implemented as a local catalog proof; no collector scheduler yet. |
| Asset/animation swarm and artifact stores | Internal V0 SQLite catalog stores source receipts separately from runtime artifacts, compatibility/binding metadata, acceptance states, immutable revisions, and provenance parents. | Implemented as a synthetic local persistence proof; no worker protocol or verified host import yet. |
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

Do not begin a cloud Blender/animation fleet before the coordinator is
trustworthy: specify the versioned work order and result manifest, persist a
recoverable state machine and immutable event history, and bind idempotency to
the canonical request. Then add one dispatcher adapter with receipt/callback
verification. The optional local Blender CLI Build Room slice is deliberately
limited to proving that chain with immutable local artifacts; it is not a cloud
worker or host acceptance path. Semantic reuse, cloud fan-out, and any Unity
load claim still require host validation and acceptance.

This preserves the Miro design's strongest idea—specialized generation behind a
small encounter request—without making the public interface expose the swarm's
unbounded operational complexity.

## Local validation

```sh
npm test
```

The suite covers Cloudflare request routing, idempotent dispatch, and structural
contract integrity. It does not make cloud calls or prove a deployed account.

## Local encounter build room

Run the dependency-free inspection viewer with:

```sh
npm run build-room
```

For one complete, local-only generated-asset receipt, run:

```sh
npm run demo:local-blender
```

That command submits a bounded Build Room request and uses the installed local
Blender CLI to create a small ocean-inspired demo mesh from a deterministic
seed. It persists a content-addressed `.blend` checkpoint, checked `glb.v1`
output, rendered PNG thumbnail, exact Blender command receipts, a newly
produced catalog asset revision, and an assembler package revision under
`.local-blender-artifacts/`. The demo creature is bootstrap content only; the
module remains the generic `encounter.body` capability. It is **local Blender
CLI evidence only**, not Modal/cloud execution, Unity-load validation, or
player-facing proof.

It listens at [http://127.0.0.1:4173](http://127.0.0.1:4173). Node's watch mode
restarts it when its source changes, so the local viewer remains easy to patch;
the projection and replay log are persisted to `.build-room-state.json` across
those restarts. The browser creates local encounter, request, and
worker-correlation IDs and shows elapsed time, an event-driven directed topology
(request/encounter → planner → coordinator → dispatcher → worker lanes),
sequence-ordered worker events, catalog counters, and artifact/package revisions.

The evidence label is deliberate:

- **Simulated fixture (not live)** is a UI preview only.
- **Local process receipt (observed)** means this local Node process accepted a
  browser submission; it does not imply an external coordinator was called.
- **Coordinator/dispatcher report (unverified)** is a translated event with no
  claim that Modal or Blender was observed.
- **Modal remote receipt (observed)** requires `source: "modal_remote"` plus a
  receipt with `request_id` and `observed_at`.
- **Blender window/screenshot/stream (observed)** requires
  `source: "blender_window"` plus an observed screenshot path or stream URL and
  an observation timestamp. Both Modal and Blender labels also require a local
  bridge to present the configured `x-build-room-observer-token`; otherwise
receipt-shaped input is rejected rather than displayed as observed.
- **Local Blender CLI evidence (observed)** is emitted only by the optional
  generated-asset checkbox/API flag. It includes a rendered local thumbnail and
  exact source/output hashes and command receipts, but makes none of the
  Modal, Unity-load, or player-facing claims above.

The adapter seam is `POST /api/ingest/coordinator` or
`POST /api/ingest/dispatcher`. It accepts the coordinator's worker-event fields
(`encounter_id`, `worker_id`, `sequence`, `occurred_at`, `kind`, and optional
`module`), projects `module_id` and `revision` as an artifact revision, and
defaults its evidence to unverified. It does not connect to a deployed
coordinator or synthesize Modal/Blender receipts. A thin authenticated bridge
may relay real `GET /v1/encounters/:encounterId`, work-item event, and freeze
responses into that seam once those endpoints and credentials are actually in
scope. The browser uses Server-Sent Events for projection updates; it does not
poll and requires no rebuild or page refresh after a trusted adapter event.

`GET /api/builds` returns active builds plus a bounded (20-entry) recent terminal
history. Each live derived record includes request/encounter IDs, the directed
work-graph worker summaries and evidence tiers, timestamps, catalog counters,
revision totals, and a navigation URL. `GET /api/builds/:requestId` is the
request-keyed detail projection. The root page lists these live records and
opens detail at `/?build=:requestId`; the detail view always links back to the
dashboard. The index receives an SSE projection stream, so local submissions
and adapter updates appear without a manual refresh. Catalog zeroes are labeled
`not_connected`; revision counts are `reported` until a source-specific receipt
establishes stronger evidence.

Active detail views include **Steer active build**. `POST /api/builds/:requestId/steer`
queues an optional instruction through the local adapter and returns a `steer_id`.
The corresponding adapter ingress is `POST /api/ingest/steering`. Receipts may
be `queued`, `accepted`, `pending`, `failed`, or `committed`; **accepted is never
shown as applied**. A receipt is only committed when it includes
`successor_response.created: true`, preserving the gateway's successor-response
commit boundary without an approval gate.
