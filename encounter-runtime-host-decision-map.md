# EncounterRuntimeHost decision map

Planning artifact for the host integration; it does not modify the published v1 schemas.

## #1: What is the executable floor?

Blocked by: none
Type: Research

### Question

Which module type can the first standalone Mech player safely advertise?

### Answer

`recipe` only. The host has a main-thread `EffectWorldRuntime` and composable combat/effect definitions, but no external recipe parser, AssetBundle loader, remote transport, or dynamic-assembly loader. The frozen package must therefore resolve to a bounded, validated recipe plus preloaded catalog keys and a local fallback.

## #2: Can a downloaded runtime asset be accepted?

Blocked by: #1
Type: Prototype

### Question

Can one hash-verified, host-versioned AssetBundle load a whitelisted prefab and release cleanly in a standalone player?

### Answer

Unresolved. The checkout uses `Resources.Load` and has no AssetBundle/Addressables runtime loader. Start with `splat.visual`; it still needs explicit shader, GPU/memory, and unload evidence. `splat.interactive` is a separate capability gate: prove deterministic collision/navigation proxies, EffectWorld/hit routing, scene-lifecycle ownership, and measured GPU/memory behavior. Raw splat data alone proves neither mode.

## #3: Can a downloaded managed assembly execute?

Blocked by: #1
Type: Prototype

### Question

Can an isolated Mono standalone player load a signed/hashed test assembly and invoke only a narrow host adapter without leaking subscriptions or Unity objects?

### Answer

Mechanically passed in an isolated Unity 6000.6.0f1 macOS Mono development player: SHA-256-verified bytes from a separately compiled assembly loaded and invoked a reflection-only entry point. This does not make it portable or production-ready: IL2CPP remains AOT-incompatible, Unity warns that this non-Unity assembly-load context is unsupported, and the Mech player does not pin its backend. Do not advertise it until the exact host player proves containment, dependency, lifecycle, and teardown behavior.

## #4: What does remote logic control?

Blocked by: #1
Type: Prototype

### Question

Can an off-process controller return a bounded, validated command schedule while the Unity host remains authoritative and responsive through timeout, disconnect, and reload?

### Answer

Unresolved. It must not receive scene ownership or direct Unity references. Its output must be translated on the main thread into the same bounded recipe/command adapter and fall back locally.

## #5: What becomes immutable at the door?

Blocked by: #2, #3, #4
Type: Research

### Question

Which artifacts and runtime handles must be held from preload through encounter teardown?

### Answer

Define an internal LoaderProfile and ArtifactReceipt before exposing non-recipe modes: build/platform/backend, loader and artifact identities, SHA-256 verification, requested asset keys, load/unload ownership, declared resource limits, and fallback reason. Promote those fields into a future contract only after the spikes prove the minimal shape.
