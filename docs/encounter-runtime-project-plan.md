# Encounter Runtime — Hackathon Project Plan

## Goal

When a player begins a run, Myth Maker begins compiling a new **encounter** in
parallel. At the encounter-door cutoff—nominally 30–40 minutes later—the host
game loads the best **playable encounter package** assembled so far. Work that
has not completed never prevents the encounter from loading.

This is a general encounter system. A giant creature is a possible demo
blueprint, not a special type in the schema, endpoint, catalog, or runtime.

## Architecture board

The living visual companion to this plan is the [Miro encounter architecture
board](https://miro.com/app/board/uXjVHpB5q5w=/). It preserves the original
collector, asset-swarm, catalog, worker-observation, and worker-steering ideas,
and now carries the encounter-generic draft-by-deadline flow and checkpoint
summary below.

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
returns one immutable package.

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
