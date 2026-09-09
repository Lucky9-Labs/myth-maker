# Encounter Runtime — Hackathon Project Plan

## Goal

When a player begins a run, Myth Maker begins compiling a new **encounter** in
parallel. At the encounter-door cutoff—nominally 30–40 minutes later—the host
game loads the best **playable encounter package** assembled so far. Work that
has not completed never prevents the encounter from loading.

This is a general encounter system. A giant creature is a possible demo
blueprint, not a special type in the schema, endpoint, catalog, or runtime.

## Authoritative direction and architecture board

This Markdown plan is the authoritative implementation and project direction.
The Miro board is diagrams-only: it may illustrate an approved direction, but
it does not add, reorder, or satisfy milestones.

The living visual companion to this plan is the [Miro encounter architecture
board](https://miro.com/app/board/uXjVHpB5q5w=/). It preserves the original
collector, asset-swarm, catalog, worker-observation, and worker-steering ideas,
and now carries the encounter-generic draft-by-deadline flow and checkpoint
summary below.

## Current technical status — 2026-09-09

This section is the current evidence ledger. It supersedes older prose in this
plan where they conflict. A merged implementation, an independently downloaded
artifact, a provider receipt, a local renderer capture, and a joined player
run are different evidence tiers; none is used as a substitute for another.

### Proven

**Myth Maker main includes the current production-lineage work.** Myth Maker
PRs #103 and #104 are merged. The fresh proof chain is tied to modal encounter
`encounter-deterministic-kraken-20260909-22`, work
`work-deterministic-kraken-20260909-22`, job
`deterministic-encounter-kraken-20260909-22`, and function call
`fc-01M22C47C6FHPGK3W66QNY6P63`.

**The deterministic source, accepted runtime bytes, and publication receipts
are hash-bound.** The source GLB is 441,172 bytes with SHA-256
`b7d08d8ae7a70e232e0f363e7c078b885d50ecbd768f3b7bc72693176b924ffa`.
Clean merged-main rematerialization produced the accepted macOS Mono
AssetBundle: 375,855 bytes with SHA-256
`05583aab5eedf0926c196df44fe7c2849a529fb49ff3e44363dbea88665f1223`,
publicly locatable at
[`05583aab5eedf0926c196df44fe7c2849a529fb49ff3e44363dbea88665f1223.bundle`](https://myth-maker-dev-dispatcher-dev.up.railway.app/v2/artifacts/05583aab5eedf0926c196df44fe7c2849a529fb49ff3e44363dbea88665f1223.bundle).
The corresponding publication SHA-256 is
`adbd5780fe43a533aa944a295f6a720381d2f33932551f9bf8b0f752ff1166b0`,
the catalog SHA-256 is
`6f70cb9953c3c61ae660e0927dea4b046a727e71d1eb9c0f6c97cbb1909a4222`,
the package-manifest SHA-256 is
`ba7c298df02eeee9a5e07d36b30f1dd92558bdbd02ef7668a5fa043482206e2f`,
and the assembly-receipt SHA-256 is
`5dfdab0b517ca603e4dcd5d96d14fafc487654552a47a41094f5d8f90b4e85a0`.
The discovery package is signed by `package-discovery-ed25519-v1`.

**The prior bundle discrepancy is reconciled, not ignored.** The earlier
reported `0f30` bundle was overwritten and is no longer available; it cannot
serve as locatable accepted-artifact evidence. The clean merged-main
rematerialization above created the current locatable accepted bytes. Its
render SHA-256, `150d3fb16163b68160d9c66f2ca8a7a164750f947011e3ed24a8b67162af447c`,
is identical to the prior render, reconciling the visual output while keeping
the accepted artifact identity anchored to the current bundle bytes.

**The signed-remote Unity run proves the fresh runtime chain at its recorded
scope.** Mech PR #49 is merged. The run verified one bundle module and the
exact manifest artifact hash and length, rendered 92,736 non-background pixels,
applied 25 critical damage from a base 10, left player HP at 92 after the
attack, and reached both victory and restart. Batch mode did not write a
full-window screenshot. The explicit RenderTexture proof and receipt passed,
but this is not claimed as player-facing first-person visual proof.

### Blocked / separately required

**Custom AI modeling cannot start with the available credential.** A local call
to `/v1/responses` returns HTTP 401 `invalid_api_key` before actions begin. A
Responses-API-capable credential is required. A successful `/v1/models` call,
if one is available, is not sufficient evidence that custom AI modeling can
run.

**Cloudflare redeployment has a distinct credential dependency.** Redeploy
token 9109 remains separately required for a new Cloudflare deployment. The
existing route works; that does not satisfy the redeployment credential gate.

## D0 — Core demo target

D0 is the non-negotiable proof that this repository can produce one real,
generic encounter upgrade. The tentacled creature is only the first demo
blueprint; no D0 interface, catalog type, or runtime rule is creature-specific.

The following observable chain is the exact D0 acceptance chain, in order:

1. A **Build Room** request creates a generic component work order.
2. That order produces actual local Blender artifacts: a generated `.blend`, a
   PNG render, and a GLB.
3. The artifacts are hash-addressed and the GLB passes strict validation.
4. Acceptance creates a newly produced immutable catalog revision—not a
   fixture—and records its provenance.
5. The assembler composes the revision and emits an `AssemblyReceipt`.
6. Build Room shows an actual render and the selected package for that request.
7. At least one later worker revision upgrades that same encounter; the
   assembler selects the compatible successor and produces a new receipt.
8. In the host demo, simple runtime combat proves that both player and
   encounter can damage one another.
9. Build Room visibly reports the material and arena work orders, their worker
   IDs, dependencies, receipts, artifacts, and revision counts; it also shows
   the compatible selection, fallback, or rejection outcome for each. Its
   evidence tier must remain honest about what was observed, reported, or only
   simulated.

"Actual" in D0 means locally produced during the demonstrated request. A
synthetic catalog entry, pre-existing file, receipt-shaped event, static image,
or simulated fixture cannot substitute for any link in the chain. The render
and selected package must be tied to the same request, catalog revision, and
assembly receipt by stable IDs and hashes.

### Current first ladder-stage status

The local Blender/Build Room slice now produces one simple appendage demo
blueprint with a real embedded GLB sway clip. Its selected package contains
generic `encounter.body` and `encounter.animation` modules bound to the same
checked runtime hash; SQLite appends immutable revisions for both domains and
preserves exact parent hashes and prior package fallback history. The second
revision stays in this first stage by changing only the one appendage's recovery
arc and clip duration. A time-bounded maintenance waiver is recorded because
concept-first runtime enforcement has not landed. These are local Blender CLI
and automated GLB-structure receipts only—not host runtime loading, player
combat, or proof that the gate is enforced.

### Concept-first asset-production gate

Every new production dispatch for every asset type—model, material/texture,
animation, arena, audio, effects, and a future type—must be derived from one
immutable `EncounterIntent`, one immutable `ArtDirectionRevision`, and one
immutable `ConceptReferenceRevision`. The concept reference can be generated
or selected, but it is always revisioned before production begins. This is an
architecture invariant, not a preferred worker prompt.

`ArtDirectionRevision` is a player-facing contract. It must state the intended
player-facing beat, silhouette, scale, palette/material cues, arena
relationship, animation/combat beats, and non-negotiable constraints. A worker
brief cites the exact immutable intent, direction, and concept revisions plus
its acceptance constraints; a worker may not replace those with an unpinned
summary or a new styling decision.

The normal dispatch exception is an explicitly recorded `reuse` or
`maintenance` waiver. It has a named asset scope, a bounded reason, an
approver, and a time-bound expiry. The existing D0 path uses a distinct,
scoped `bootstrap_waiver` that declares itself not concept-compliant; neither
waiver is an informal route around the concept gate.

Every immutable asset revision records its lineage or waiver, interpretation
constraints, provenance, and independent source- and runtime-acceptance
statuses. Before selection, the assembler verifies that the candidate carries
compatible lineage. It rejects an absent or incompatible lineage rather than
selecting the candidate, then records a selection, rejection, deviation, or
fallback receipt against the package revision.

Build Room is an inspection surface for this relationship, not evidence that a
cloud worker ran: it must be able to show **visual concept → asset candidate →
assembled package** and the supporting immutable receipts. Its labels continue
to distinguish local observed evidence, remote observed evidence, translated
reports, and simulation. The closed, type-neutral adoption schema is
[`concept-first-asset-production-gate.schema.json`](../contracts/v1/concept-first-asset-production-gate.schema.json);
it intentionally contains no genre, actor, or demo-specific fields.

The generic planner and dispatcher now carry the full immutable intent,
direction, concept, and exact lineage—or a bounded waiver—on every v2 work
order. They reject missing, mismatched, and expired gate payloads before a
backend launch, and preserve the gate in each worker receipt. Catalog and
assembler lineage selection remain later slices. Current D0 body outputs remain
pre-gate bootstrap evidence: their explicit bootstrap waiver preserves the
bounded local path without relabeling any artifact as concept-first compliant.

### Follow-on material and arena workstreams

These are explicit generic workstreams for the post-D0 path. They define
ownership and acceptance only; neither worker is implemented or implied by the
current D0 evidence.

**Texture/Material Worker.** This worker owns immutable texture-set and
material-binding revisions. A texture-set revision records albedo, normal,
roughness/metallic, emissive, and mask artifacts; each artifact records
provenance and a SHA-256. A material-binding revision records the compatible
scale profile, material slots, semantic tags, and the texture-set revisions it
binds. Source acceptance verifies the declared sources, provenance, hashes,
and compatibility metadata. Runtime acceptance separately verifies that the
host can bind the revision to the intended scale and material slots. A revision
that fails either acceptance remains a candidate with a visible rejection,
rather than becoming a package fragment.

**Arena Worker.** This worker owns immutable arena revisions linked to the
encounter's semantic entity. Each revision carries arena geometry, collision,
navigation data, lighting and dressing, spawn and critical-spot markers, and
deterministic play-envelope metadata. Source acceptance verifies the immutable
revision, its semantic-entity link, provenance, hashes, and declared
dependencies. Runtime acceptance separately verifies the host's collision,
navigation, marker, and play-envelope compatibility. Dressing can be absent or
rejected without invalidating a deterministic playable envelope.

The catalog stores semantic metadata, revision manifests, compatibility data,
and acceptance receipts. It is **not** a blob store: immutable artifact bytes
belong behind a separately addressed blob-store seam, with manifests pointing
to them by stable reference and SHA-256. “Alien-oceanic” and similar styling
may appear only as aesthetic demo data in semantic tags; they never become
schema, endpoint, catalog-type, or runtime special cases.

Until D0 is demonstrated end to end, unrelated speculative expansion—including
production-infrastructure polish, broad taxonomy work, and advanced
steering—does not count as milestone progress and must not displace fixing D0.
The broader C0–C5 plan remains in force after D0.

## Demo definition of playable

The first package is playable when, in a dedicated Mech-game demo scene:

- the player can move, aim, and damage an encounter target;
- the target has visible HP and one or more critical spots that take modified
  damage;
- the target can damage the player with at least three readable attacks;
- the encounter has an objective/end state and can be restarted; and
- the package falls back to known baseline fragments if no generated work
  arrives before the cutoff.

Visual fidelity, unique meshes, full authored animation, and generated world
dressing improve the package but are not prerequisites for this result.

## The small encounter interface

The host game asks for one result and never coordinates individual workers:

```text
startEncounter(spec, deadline) -> encounterId
getEncounter(encounterId) -> progress, workers, currentPackage
steerWorker(workerId, instruction) -> accepted command
freezeEncounter(encounterId) -> PlayableEncounterPackage
```

The coordinator implementation owns planning, worker fan-out, catalog lookup,
candidate scoring, and cutoff behavior behind that interface.

### Core records

```text
EncounterSpec
  seed, player build, objective, arena envelope, deadline, desired roles

EncounterFragment
  kind, recipe or artifact reference, compatibility keys, quality tier, score

PlayableEncounterPackage
  encounter spec version, selected fragments, combat recipe, arena recipe,
  manifest hash, fallback provenance

ConceptFirstAssetProductionGate
  immutable intent + art direction + concept -> worker brief -> asset candidate
  -> assembly selection, rejection, deviation, or fallback receipt
```

Compatibility keys initially cover scale, rig/model binding, collision profile,
ability target contract, and host-game version. A fragment is useful only if it
can bind into the current package.

The versioned JSON Schemas in [`../contracts/v1/`](../contracts/v1/) firm this
boundary up under the generic name `EncounterModule`. They also define the host
capability, work-order, worker-event, and frozen-package envelopes needed for
horizontal scheduling. Four execution kinds are available when the host
advertises them: declarative `recipe`, downloaded `runtime_asset`, in-process
`managed_plugin`, and server/sidecar `remote_logic`. Recipe and fallback support
remain mandatory architecture paths; dynamic managed code is an optional host
capability until it passes an actual player spike.

## Progressive compilation model

```text
player starts run
  -> create deadline-bound encounter job
  -> immediately assemble baseline combat package
  -> collector: desired / existing / missing
  -> swarm produces compatible fragments in parallel
  -> assembler continuously selects the best package so far
  -> cutoff freezes that package
  -> host game loads it
```

The fallback is a real combat package, not a loading screen. The package may
gain a new silhouette, move, clip, material, environmental visual, or arena
detail while the player is elsewhere in the run; at the cutoff it becomes
immutable for that encounter.

## Demo catalog bootstrap

For the hackathon, preload selected Mech-project assets and animation clips as
catalog entries. This gives the assembler compatible pieces before generation
has produced anything novel.

Each imported entry needs a small manifest, rather than a hard-coded reference
from encounter logic:

| Catalog | Required demo metadata |
| --- | --- |
| Asset catalog | stable source ID, prefab/mesh reference, scale profile, material slots, collision proxy, functional and aesthetic tags |
| Animation catalog | stable source ID, rig/model-binding ID, clip name, duration, locomotion/attack/reaction tags |
| Semantic catalog | roles, objectives, combat affordances, aesthetic tags, and allowed relationships |

`Demo Mech Bootstrap` is the provenance label for these entries. It is seed
content for the demo, not a claim that Myth Maker owns the source project or
that the catalogs are permanently Mech-specific. Import/export axes, model
bindings, and current runtime compatibility must be checked in the active Unity
checkout before an entry is accepted.

## Checkpoints

The checkpoints below are deliberately preserved as the post-D0 expansion
path. They may support D0 only when they directly repair a missing D0 link.

### C0 — Catalog seed and contracts

Create the three manifest shapes above and import a deliberately small set of
Mech assets/clips. Add a catalog browser or JSON inspection output that proves
which baseline fragments are available.

**Done when:** a caller can select one compatible mesh/prefab fragment and one
compatible clip by manifest data alone.

### C1 — Combatable baseline in the host game

Build the smallest generic encounter target in the Mech demo scene: shared HP,
critical spots, three attacks, player damage, objective, and restart.

**Done when:** a player can run around, take damage, damage critical spots, and
finish or lose the encounter without any swarm output. Reuse the host's existing
damage and target interfaces where they fit; do not create a parallel combat
simulation.

### C2 — Encounter package assembler

Implement `EncounterSpec`, `EncounterFragment`, and
`PlayableEncounterPackage`; assemble the C1 baseline from C0 catalog entries.
Add a deterministic score that prefers compatible upgrades over incompatible
but prettier ones.

**Done when:** swapping a compatible fragment changes the loaded encounter;
an incompatible fragment is rejected with a visible reason; the baseline still
loads with an empty candidate list.

### C3 — Deadline job and worker observability

Extend the coordinator from submit/queued behavior to a deadline-bound job
event log, worker IDs, candidate receipts, current-package status, and worker
steering. The job starts when the run starts, not when the player reaches the
door.

**Done when:** the UI or inspection route shows workers and the current best
package; a steering request changes a worker's next priority; freezing a job
returns one immutable package. For production candidates, the inspection route
also shows the pinned concept → candidate → package relationship and whether
each evidence item was locally observed, remotely observed, reported, or
simulated.

### C4 — Horizontal draft lanes

Attach independent workers to the same fragment contract:

- **combat lane:** move recipes, telegraphs, critical-spot placement, phase
  proposals;
- **body lane:** procedural silhouette, materials, or generated model
  candidates;
- **animation lane:** compatible clips, retargeting, or procedural motion;
- **arena lane:** deterministic play envelope plus optional world dressing;
- **presentation lane:** VFX, audio, and encounter UI.

The World Labs/Gaussian-splat idea belongs in the optional arena-dressing
adapter. It may enrich the rendered space, but deterministic collision,
traversal, and attack-impact surfaces remain in the arena envelope. Integration
capability and import behavior are unverified until tested.

**Done when:** at least two lanes can complete in either order and the assembler
produces the same valid baseline if either one is absent.

### C5 — Full run proof

Start a run, let C3/C4 operate through the normal play time, approach the
encounter door, freeze the latest valid package, and play it end to end in the
host game.

**Done when:** there is a short runtime capture showing the player reaches a
finished-or-fallback encounter, exchanges damage with it, and completes or
fails the objective. A successful job record alone is not sufficient proof.

## Parallel work plan

| Wave | Parallel work | Depends on | Join point |
| --- | --- | --- | --- |
| 0 | C0 catalog manifests; C1 host-game combat slice; C2 record/interface design | none | compatible baseline-fragment contract |
| 1 | Coordinator/event-log work; package assembler; demo catalog importer | C0/C2 interface agreement | one baseline package can be selected and reported |
| 2 | Combat, body, animation, arena, and presentation lanes | C2 fragment contract; C3 receipts | each lane emits a candidate fragment |
| 3 | Cutoff/freeze behavior; host-game loader; operator worker controls | C1, C2, C3 | one immutable package loads at the door |
| 4 | Full-run capture and iteration on scoring/priorities | C4 and C5 | demonstrated draft-by-deadline encounter |

Avoid giving workers ownership of the loaded Unity scene. They emit fragments;
the assembler is the only module that composes and freezes the package. That
keeps the swarm horizontal without making compatibility a distributed problem.

## Not required for the hackathon slice

- production-grade asset generation or full rigging coverage;
- a permanent global catalog or broad content taxonomy;
- online/multiplayer synchronization;
- a finished integration with World Labs or any other external generator;
- a new general-purpose combat rewrite in the Mech project.

The next implementation decision is C0/C1 ownership: identify the active Mech
checkout and choose the small list of assets and clips to seed, while the
encounter-runtime side creates the generic manifest and package contracts.
