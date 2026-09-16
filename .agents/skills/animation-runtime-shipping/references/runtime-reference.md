# Strokah runtime map

Use this to locate reusable machinery, then verify the live version. Myth Maker contains the preview; the Unity implementation is in the separate `luckybucky9/mech-game` repository. Resolve its current checkout instead of assuming the old integration worktree still exists.

## Myth Maker preview

Base: `output/blender/strokah-rig-v1/runtime/`.

| File | Responsibility |
| --- | --- |
| `foot-placement.mjs` | World-space contacts, support and swing scheduling, touchdown prediction |
| `mechanical-legs.mjs` | Original-length multi-link solve, joint plane/continuity, sole correction |
| `upper-body.mjs` | Upper-body pose and weapon/hand relationships |
| `torso-response.mjs` | Contact response, lean and secondary motion |
| `dash-motion.mjs`, `dash-profile.mjs` | Burst envelope and return behavior |
| `weapon-actions.mjs` | Preview scope/recoil/reload signals; verify API in current checkout |
| `preview.mjs`, `preview.html`, `serve.mjs` | Real exported-rig preview, controls, deterministic review views |

From the Myth Maker root, start only if no reusable owned server is already running:

```sh
node output/blender/strokah-rig-v1/runtime/serve.mjs
```

Use the address actually printed. Review `/runtime/preview.html`. Native baked export review pages exercise a different implementation; do not mix their evidence.

Focused checks can use the existing `*.test.mjs` files. Inspect their names/assertions first and choose the relevant subset; the broader milestone command is:

```sh
node --test output/blender/strokah-rig-v1/runtime/*.test.mjs
```

Examples: `arm-bindings`, `shoulder-fit`, `weapon-actions`, `stable-gait`, `sprint-stride`, `motion-reset`, `dash-directions`, `mechanical-transitions`. Existing `audit-*.mjs` scripts inspect the real exported geometry; read their arguments and expected source before running. Do not carry numeric thresholds into a different-scale mesh unexamined.

## Unity destination at the merged Strokah implementation

| Component | Responsibility / failure seam |
| --- | --- |
| `StrokahPlayerMotion` | Actor adapter; locomotion/grounding/aim state; explicit reset after teleport |
| `StrokahFootPlanner`, `StrokahStableGait`, `StrokahLegSolver` | Contact scheduling, coordinated pelvis and mechanical leg solve |
| `StrokahWeaponGripSolver`, `StrokahWeaponMotion` | Weapon-owned targets, arm reach, scope/carry/recoil/reload layers |
| `StrokahSkeletonPresentation` | Imported rigid meshes, attachments, visibility and part identity |
| `RaptorPilotController` in `RaptorGrayboxRangeBootstrap.cs` | Normal controls and shared dispatch; test key mapping as well as helper behavior |
| `RaptorLoadoutActionInput` in `RaptorLoadoutMenu.cs` | Mounted input/profile, actual emission and successful reload callbacks |
| `VehicleActionRuntime` | Gameplay action occurrence and mounted telemetry; locate with file search, not an assumed filename |
| `RaptorPilotMode` | Eject/remount and ownership transfer |
| `MechMotor` | Grounded dash, crouch capsule/clearance, actual movement |
| `FirstPersonCameraRig` | Authoritative camera/scope owner; do not add a second camera controller |

Read `Tools/StrokahMotionReference` for source hashes and binding conversion, `config/unity-worktree-assets.json` for hydration, and `art-library/releases/strokah-motion-rig-v1.json` for the pinned registry release. The accepted GLB SHA-256 was `fae1894b712c42a80385a586802b0931c51ef372348aec450caec33bbfcc23fb`; this is a provenance anchor, not a requirement that future models share that hash.

## Proof and resource discipline

Use destination `Tools/showme-agent-wrapper before-run` / `after-run` when present. Consult its current interface; keep the GIF inside the returned session and record runtime identity. `SHOWME_VERIFIED` certifies that scoped receipt, not all game behavior. Inspect the artifact and match its assertions to the request. Only claim publication after upload and read-back actually succeed.

Keep an owned-resource ledger from launch. One built player can exercise multiple unchanged-code cases; avoid a new build for each camera or direction. An opt-in recorder should not become normal gameplay overhead. For expensive tests/builds, poll the same live handle; after a terminal failure inspect the error before retrying. Another task's Unity process is not yours to kill.

Fresh asset hydration, code parity, input behavior and visual acceptance are different evidence. Reuse existing evidence when source identity is demonstrated, and state any remaining mismatch. A post-merge smoke test of an identical runtime build can be labeled as such; do not call it a new main build.
