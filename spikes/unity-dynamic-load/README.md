# Mono dynamic-assembly spike

This is an isolated Unity 6000.6.0f1 experiment. It proves that a macOS
**Mono** development player can load byte-backed assembly data at runtime and
invoke one reflection-only entry point. It does not change the dirty Mech
checkout or claim IL2CPP support.

## Interface

Open `Assets/DynamicAssemblySpike.unity`, select **Dynamic Assembly Drop
Host**, and drag a DLL imported as a `.bytes` `TextAsset` into **Plugin
Assembly**. The Inspector derives the SHA-256 when the payload changes; runtime
loading rejects a missing or mismatched digest, then finds one public
static parameterless method returning `string`, and records the result.

The auto-derived Inspector hash is a local development convenience that proves
only byte consistency. It is not artifact provenance or authenticity: a real
host must obtain the expected digest from an immutable, trusted artifact
receipt before permitting a download to execute.

The `.bytes` convention is deliberate: importing a raw `.dll` makes Unity
treat it as a regular build-time plugin rather than an external payload.

## Reproduce

1. Open `../unity-dynamic-plugin-fixture` with Unity 6000.6.0f1; its
   `fixture.DynamicProbe.Describe()` source compiles to
   `Fixture.DynamicProbe.dll`.
2. Copy that output to
   `Assets/Runtime/Resources/DynamicPluginFixture.bytes`.
3. In this project, run the `Myth Maker/Create Dynamic Assembly Spike Scene`
   menu item, then call
   `MythMaker.DynamicAssemblySpike.Editor.DynamicAssemblySpikeBuild.BuildStandaloneMono`.
4. Run the generated macOS app in batch mode. The build helper pins the
   standalone player to Mono and disables managed stripping for this spike.

The verified run loaded SHA-256
`6aec3d084cbd8cc26714a5c94487906fce43a11f76e0d1938ab6ab7c787e894a` and
logged `External assembly executed: DynamicProbe.Describe` from the separate
fixture assembly.

Run `./run-mono-player-spike.sh` to rebuild the Mono player, execute it, and
fail unless the player log contains that external-assembly receipt. EditMode
tests cover null bytes plus missing and mismatched SHA-256 rejection.

## Reef Skitter swarm benchmark

`run-reef-skitter-swarm-benchmark.sh` builds a separate macOS development
player and loads the hash-pinned, integrated Reef Skitter GLB directly at
runtime. It samples the five clips into one immutable GPU bone-matrix library,
then skins the 15 retained provider meshes from their `JOINTS_0`/`WEIGHTS_0`
attributes and draws 400 candidates with shared meshes/materials and indirect
instancing. Each agent carries only compact deterministic state; 30 Hz/10 Hz/
static-pose LOD cadence and frustum/distance culling avoid a per-creature
`Animator`, rig graph, or GameObject.

The standalone player records average and p95 frame time, main-thread and GPU
timing counters when supported by the graphics backend, allocated memory,
draw-call/batch counters, submitted instanced draw calls, and visible creature
count, shared animation-buffer size, LOD/state populations, pose-update count,
and GC allocation. It writes a receipt and player screenshot under
`output/reef-skitter/unity-swarm/`. A source-only zero-clip GLB is rejected.

On macOS, Unity's in-player GPU frame counter may be unavailable even in a
development build. `run-reef-skitter-metal-trace.sh` launches the already-built
player under Xcode's Metal System Trace and exports process-scoped GPU
intervals. `scripts/summarize-metal-trace.mjs` discards one second of process
startup and reports per-frame GPU spans without double-counting overlapping
Metal channels. The trace, TOC, interval export, player log/output, and compact
GPU receipt all inherit the requested trace basename. Give the trace script a
new destination when preserving an earlier capture; it intentionally refuses
to overwrite any member of that evidence set.

```sh
spikes/unity-dynamic-load/run-reef-skitter-swarm-benchmark.sh \
  output/reef-skitter/unity-swarm/runs/<new-run-id> \
  /path/to/reef-skitter-animation-integrated.glb
REEF_SKITTER_GLB_PATH=/path/to/reef-skitter-animation-integrated.glb \
  spikes/unity-dynamic-load/run-reef-skitter-metal-trace.sh \
  output/reef-skitter/unity-swarm/reef-skitter-metal-rerun.trace
```

## Scope and non-goals

This is a feasibility probe, not a production plugin runtime. `Assembly.Load`
is process-local, has no safe unload/sandbox boundary, accepts only the narrow
fixture entry point, and does not establish dependency, signature, cancellation,
or scene-lifecycle behavior. Unity's analyzer also warns that this non-Unity
assembly-load context is unsupported. IL2CPP remains unsupported for this
execution mode and the Mech player backend has not been proven.
