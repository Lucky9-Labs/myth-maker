---
name: animation-runtime-shipping
description: Transfer accepted authored or procedural animation into the actual controllable game actor, verify input and action ownership with real player captures, and package reproducible assets. Use when animation preview work must become playable or ship.
---

# From accepted motion to the playable actor

Use [mythmaker-animation](../mythmaker-animation/SKILL.md) for the brief/checkpoints and [runtime reference](references/runtime-reference.md) for the Strokah implementation map. Confirm the destination repository/worktree before editing: Myth Maker's preview and the Unity game are separate delivery surfaces.

## Integrate a small vertical slice early

Before tuning an entire set, load the real rig on the real controllable actor and verify one locomotion state plus one weapon action through normal input. This catches binding, scale, handedness, ownership and camera errors before expensive polish.

Capture the source/export/controller identities. Determine which behavior is baked and which is procedural; a GLB walk clip is not a terrain-adaptive controller. Port or reuse the accepted planner/solver intentionally. Preserve bone names, mesh associations, original segment lengths, neutral offsets and side mapping. Convert handedness exactly once. Use a few source-versus-port fixtures for numerical parity, then verify a real player.

Let gameplay own position, collision, grounded state, inventory, ammo, possession and action timing. Let animation consume those signals. Hook recoil to a confirmed emission and reload gesture to a successful reload, including the mounted-weapon path. Do not animate a raw click that the weapon rejected. Bind camera scope to the authoritative active profile. Keep weapon control, arm targets, muzzle direction and projectile origin consistent.

On equipment change/eject, cancel held actions and transfer control ownership; park the inactive mech rather than following the pilot camera. Preserve selected loadout for remount. Check exterior/first-person visibility, extra source meshes, canopy attachments and part customization identity when those are in scope.

## Test actual controls before asking for acceptance

Read the real input code and confirm the user's intended bindings. Do not substitute conventional defaults. For Strokah the accepted controls became Space dash, Ctrl/C crouch and Shift+W sprint; Space must not also mantle/jump the mech.

Shared-handler automated captures are useful for deterministic state/pose checks, but also exercise normal keyboard/mouse input early. A helper that calls the motor directly cannot prove the key binding. If the available UI tool only taps keys, disclose that before repeated failed held-input trials and request a brief held action once needed. Capture whether the key arrived, whether gameplay accepted it, and whether the pose changed. Distinguish these three failures.

Use actual actor state plus persistent events: emission count, ammo before/after, reload completion, grounded/dash/crouch state, scope/FOV and relevant ownership. A low-cadence screenshot can miss a short recoil even when a shot fired. Conversely, a key event alone does not prove movement.

## Keep proof from distorting the product

Use the repository's ShowMe adapter when available; otherwise use its real runtime capture path. Record build/commit, runtime identity, camera, scenario, distinct frame count and cleanup. Inspect the final GIF, not merely raw frames or a receipt. Keep observer views separate from normal gameplay-camera proof; hiding an occluder is diagnostic, not proof that normal gameplay visibility is fixed.

Do not synchronously encode/write a PNG every gameplay frame during a performance judgment. Separate lightweight per-frame telemetry from bounded visual capture; use a supported low-overhead recorder when available. Launch once without instrumentation before attributing lag to animation. Check current CPU/memory/disk and owned processes before another build. Reuse identical builds, serialize this task's Unity work, and leave other tasks' processes alone.

## Finish proportionately

Run focused tests after a change, then the relevant integration suite. Verify stride/contact/hinges/grips and requested transitions in the player. Preserve acceptance across unchanged layers; repeat proof only for changed behavior, uncertain evidence or a new failure. Keep optional enhancements out of the completion gate.

Registry-bound models need immutable ID/revision/key/hash, read-back and normal fresh-checkout hydration; do not silently commit large model binaries or depend on a local ignored file. Use the destination's validator/bootstrap.

When the user requests shipping, follow the available sendit workflow or repository equivalent: scope, current base, checks, review threads, merge, base ancestry and post-merge verification. No automatic release/tag/publication beyond that authorization. Preserve user-accepted limitations explicitly. Cleanup only ledger-owned disposables; retain source/checkpoints and proof artifacts. A recoverable quarantine does not free disk space. Report delivery status without reopening already accepted artistic decisions.
