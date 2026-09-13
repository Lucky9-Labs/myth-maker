# Reef Skitter animation and swarm runtime

Reef Skitter is the first **already-parted** provider source. Its immutable
input and inspection are in `assets/reef-skitter/source/` and
`assets/reef-skitter/manifests/`. The input must retain each provider part as a
source node. The importer explicitly forbids monolithic-mesh segmentation.

## Animation source contract

The GUI-authored derivative `.blend` owns one rig/root plus 15 part bindings.
It must export exactly these clips, each with one transform track per retained
part:

| Clip | Loop | Root motion | Runtime transition |
| --- | --- | --- | --- |
| idle | yes | none | enter/exit at any normalized time |
| walk | yes | none | idle/walk/run blend by desired speed |
| run | yes | none | idle/walk/run blend by desired speed |
| attack | no | none | attack → idle after end event |
| death | no | none | terminal; freeze on final pose |

Root motion is intentionally disabled: navigation consumes its own deterministic
velocity, which keeps instanced creatures from drifting differently from their
authoritative gameplay positions.

## Cloud GUI authoring

`.github/workflows/reef-skitter-cloud-animation.yml` uses GitHub Actions only as
the trusted controller. All GUI authoring, Blender saves/reopens, viewport
playback, motion capture, integration, export, and reimport execute in the
deployed `lakshya/dev` Modal app on T4 workers. The workflow requires an exact
source-SHA deployment receipt before dispatch. It creates the canonical rig
first, runs at most four of the five isolated Modal clip lanes concurrently,
and serializes final Action integration/export/reimport in a separate Modal job.

Every Modal worker hashes its immutable inputs and all native, preview, and
Blender-window evidence into a provider receipt and private Volume paths. The
controller downloads that exact job directory and verifies those hashes before
GitHub stores a reviewer artifact. A read-only Blender inspection on the cloud
CI runner checks the mesh/rig/Action contract; it is validation, not authoring.
Clip jobs additionally capture 40 frames at 8 fps inside Modal while the Action
is playing; at least half of adjacent pairs must show material pixel change in
the central viewport before the cloud CI runner encodes a five-second GIF. This
path performs no Blender, rendering, or benchmark work on the dispatching Mac.

## Runtime representation

`src/parted-model-swarm-runtime.js` treats clip tracks as shared GPU data. An
agent is a 32-byte state record (position, yaw, state, phase, deterministic
seed, LOD); it is not a GameObject with a heavyweight Animator/rig update.
After host frustum/occlusion culling, the runtime uploads only visible instance
records and issues batches keyed by `model + LOD + part + material`.

LOD 0 (<20m) samples at 30 Hz with shadows, LOD 1 (<55m) at 10 Hz without
shadows, and LOD 2 uses a far impostor/static pose policy at 0 Hz. Phase and
speed variation come from a stable hash of the instance seed, so a replay is
deterministic without allocating per-agent animation state. The host remains
responsible for actual GPU, frame-time, memory, and draw-call measurements.

## Proof boundary

The representative Unity standalone Metal benchmark renders 400 visible Reef
Skitters using one shared matrix buffer and 15 indirect instanced submissions
(one per preserved source part/material), with zero per-agent `Animator`
components. The in-player receipt records CPU, memory, submitted draw groups,
and visible count. Because Unity's standalone GPU counter is unavailable on this
target, the companion Xcode Metal System Trace receipt records process-scoped
GPU frame spans.

The source GLB still has no authored animations. The runtime state tests and
Unity benchmark exercise the compact state and instancing path only; neither is
visual proof of the five requested clips. Those clips, their Blender
save/reopen verification, and real-model motion captures remain a separate GUI
authoring gate.
