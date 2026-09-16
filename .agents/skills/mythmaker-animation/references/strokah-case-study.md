# Strokah: decisions worth reusing

This is a synthesis of the user's animation conversation (September 14–16, 2026), checked against the local preview records and subsequent Unity shipping evidence. It is a worked example, not a current-state manifest. Later user corrections supersede earlier requests. Read current code/artifacts before acting on a version or path below.

## What made the result work

| User feedback / turning point | Effective response | Reusable lesson |
| --- | --- | --- |
| Foot structure and pelvis mounts wrong; hose-like double knee | Identify actual joint centers and retain a separate lower-shin link; split heel/toe at the intended ankle | Establish mechanical anatomy from mesh/reference before animation tuning |
| Lengthening happened along the wrong axis | Use the part's natural non-round extension axis; return to symmetry before mirroring | Mesh proportions and bone proportions are one reversible experiment |
| Restore original ankles | Return both mesh and chain lengths; adapt the existing controller | Do not solve every style problem by permanently changing anatomy |
| Shoulder shells do not meet upper arms | Rebind the attachment in neutral/T-pose, then restore rifle posture | Fix bind relationships rather than patching one pose |
| Trigger hand is wrong; wrist/fingers keep changing | Shape the hand first, align wrist to forearm, fit the gun to it, limit knuckles | Stable grip anatomy precedes IK and weapon motion |
| Left hand floats; rifle should sway with arms | Introduce weapon-owned trigger/foregrip anchors, solve both arms, move the common control | Aim/carry/recoil/sway must preserve a common grip frame |
| Walk looks like a baby or crouch walk | Weight shift, early foot initiation, planted push, longer stride, steadier pelvis | Stable gait is contact timing and world travel, not just faster clip playback |
| Add upper-body heft | Touchdown-triggered compression/rebound with independent supported joints | Mass comes from timed secondary response without disrupting foot plants |
| Sprint looks marchy or like Scooby-Doo | Compare contact phases against real reference; coordinate whole-body lean, toe peel, pointed carry, farther strike and longer travel | Inspect the whole cycle and its silhouette; isolated knee height is insufficient |
| Almost right; reduce lean, elongate the pedal oval | Make a small phase-matched refinement instead of rebuilding the gait | Preserve directionally accepted work |
| Dash should not step during the burst | Drag/skim feet while torso accelerates, then preserve velocity and foot state into recovery | Record supersession: earlier catch-step experiments are no longer the target |
| Left dash toes end oddly | Bound ground correction using each side's real local axes; inspect both sides | Mirroring is a geometric invariant to verify, not a naming assumption |
| Everything should work in Grayzone | Port procedural behavior and source identity into the actual actor; wire mounted emissions/scope/reload and possession | Preview acceptance and game acceptance are separate milestones |
| No Left Alt; mech dash belongs on Space; Ctrl-W did not crouch | Correct the real keyboard dispatch, retain Ctrl and add C; inspect delivered events and motor state | Confirm controls early, and distinguish missing input from failed pose logic |
| Recording instance is laggy | Diagnose synchronous screenshots plus competing Unity compilers; verify a normal launch | A proof harness can create the performance problem it appears to reveal |

## Evidence landmarks, not files to blindly edit

Paths below are relative to the Myth Maker root unless marked otherwise:

- `output/blender/strokah-rig-v1/runtime/RESUME.md`: concise later sprint, weapon, and dash milestones; useful phase/camera evidence names.
- `output/blender/strokah-rig-v1/runtime/CURRENT-STATUS.md`: long chronological history. Search specific defect/version rather than reading all of it into context.
- `output/blender/strokah-rig-v1/runtime/README.md` and `WEAPON-CONTROLS.md`: implementation notes with historical “current” sections. Several older sections are superseded; source code and latest accepted evidence decide.
- `output/blender/strokah-rig-v1/checkpoints/best-walk-v14/`: protected accepted walk; source commit `a6b9642` was preserved during sprint experiments.
- `output/blender/strokah-rig-v1/working/strokah-stable-gait-v10.blend` and matching `.glb`: native source/export used by the accepted procedural preview. Verify existence and identity in the current checkout.
- `output/blender/strokah-rig-v1/evidence/procedural-runtime-v1/`: actual review artifacts, including `v39-contact.gif`, `v40-multi-angle.jpg`, `v41-rifle.gif`, `v45-exit.gif`, and `v47-toe-fix.gif`.
- Preview source commit `3e90f80`: bounded lateral toe correction. This is not a Unity release by itself.
- Destination `luckybucky9/mech-game`, PR #173, merged as `5af39be8276ea289a9add4915274e1eb56384693`: accepted player integration. Its `docs/strokah-motion-shipping.md` records tests/captures and later user acceptance; earlier pending sections are historical.

Do not copy original-machine absolute paths or temporary PIDs into future runs. Do not needlessly retrieve private conversation logs: this case and linked project artifacts provide the reusable decisions. If the user asks about an exact historical decision, consult the specific conversation rather than generalizing this summary.

## Shorter route next time

Build a neutral rig and one valid grip; establish a stable walk; prove one normal-control engine slice early; refine sprint/dash in the cheap preview; promote checkpoints; transfer the remaining motion layers; verify actual controls and normal camera once against the accepted version; ship when the current checks and user's acceptance support it.

Avoid repeated whole-scene exports for controller-only changes, arbitrary pose fixes over bad bind relationships, helper-only input testing, low-frame-count GIFs, competing builds, and repeated status-only goal continuations. These added time without improving the accepted motion.
