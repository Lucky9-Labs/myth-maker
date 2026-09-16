# Strokah mechanical cockpit — sliding canopy and hinged cheeks

Saved review candidate on `codex/strokah-cockpit-mechanical`, based on current `main` (`be4cb5ad`) plus only the requested animation skills commit. No merge, publication, Unity integration, damage, limb-loss, melee, shield or ejection work.

The latest direction is applied: the cheeks make a short seam release, then angle outward about lower attachment pivots with no further outward translation. The central chin has a smaller slide. The canopy uses a continuous 0.155-unit backward guide stroke over the crown and stops at a low baseball-cap brim angle. Guide translation and tilt begin together immediately after release and share one progression through full opening; there is no hinge-first phase. The canopy release is now 0.012 upward and 0.030 forward (40% and 25% smaller), with a revised guide pivot that brings the final brim 0.024 units lower and keeps it closer to the crown. The canopy remains a thin outer-surface preview; its original internal solid mass is retained hidden for later cleanup. Diagnostic colors identify the panels.

## Review

- Native: `working/strokah-cockpit-mechanical-v1.blend` (saved local artifact; large source/model files are intentionally not committed).
- Proof: `cockpit-glass-four-views.gif`, 90 actual browser-rendered frames at 20 fps, 4.5 seconds. Front, side, three-quarter close-up and full mech views. The encoded GIF was decoded and its keyframes inspected.
- `decoded-side-keyframes.png` is the decoded side-view contact sheet.
- Run `npm ci && npm start` from this directory, then open `http://127.0.0.1:4179`. Open / Hold / Close and the normalized slider all operate the same controller. Camera buttons retain the complete rig and rifle.

## Source and geometry

Accepted source, read-only throughout:
`/Users/lucky/.codex/worktrees/ce61/myth-maker/output/blender/strokah-rig-v1/working/strokah-stable-gait-v10.blend` and matching `.glb`.
`manifest.json` records SHA-256 identities. The accepted export is copied locally as `working/accepted.glb`; restore that copy from the recorded source before running in another checkout.

The original closed transforms are retained exactly. The glass preview uses the authored outer surface, with no replacement helmet or deformed shell:

| Role | Authored mesh | Motion at full opening, export units |
|---|---|---|
| Canopy | `tripo_part_61.001` | short release, then 0.155 backward guide travel with 65° rotation; stops at a low brim |
| Left cheek | `tripo_part_57.004` | +0.012 sideways/+0.026 forward release, then 20° outward about its lower attachment |
| Right cheek | `tripo_part_57.005` | −0.012 sideways/+0.026 forward release, then mirrored 20° outward about its lower attachment |
| Chin | `tripo_part_new_0.001` | +0.021 forward, −0.012 down |

These are already separate rigid meshes; **no destructive source cuts were needed**. Following the thin-glass direction, `build_glass_preview.py` selects 3,358 frontmost exterior triangles from the 7,666-triangle exported canopy into a separate preview copy. In Blender, `Cockpit_Glass_Preview` displays this thin skin, while the complete original canopy remains present but hidden. Its underside bulk can be deleted/cleaned later. This temporary skin has an unpolished boundary; it is not final glass topology. The source has concealed overlapping seat surfaces between canopy, cheeks, chin and the fixed collar/carrier. All original mesh surfaces were preserved. A manufacturing-clean assembly would require trimming those internal mating surfaces; this candidate does not claim zero triangle overlap while the source seams disengage. No pilot interior or visible actuator hardware was invented.

The pose uses the accepted `UpperBody` / `WeaponGripRig` solver with the common weapon control lowered 0.10 and tucked back 0.12. Original trigger/foregrip anchors and upper-arm shoulder binding are reused. Both grip errors are below 1e-6. This is a static review service pose, not a new gameplay action or a weapon-stowing transition. Native source actions remain as datablocks; their playback is disabled in this derivative so the cockpit demonstration does not also play locomotion.

## Controls and integration

`createCockpitRig(root, config)` in `cockpit-binding.mjs` binds the accepted neutral actor once. It returns `motion` with `amount` in [0,1], `state`, `open()`, `hold()`, `close()`, `seek(amount)` and `update(dt)` (seconds). Default opening time is 1.65 seconds. Parent waist motion remains inherited; positions and rotations are always derived from immutable neutral matrices. Do not also run a second animation track on the same four panel transforms.

`mechanism.json` owns panel identity, clearance/travel intervals, cam pivot, and travel values. Quintic phase curves stop smoothly at clearance and travel endpoints. Reversal follows the same path without a pose jump or accumulated transform error; velocity changes sign immediately when commanded.

Native equivalent: select `CTRL_Cockpit_Open`, custom property `open_amount`. Its dedicated action includes open, hold, partial close, reversal, and reseating through frames 1–144. Clear/mute that control's demo action when driving the property manually. Native drivers use only built-in expressions; no auto-run Python handler is required.

## Validation and limits

- Five focused Node tests pass, including the actual accepted GLB, 200 bound-model reversal cycles, 1,000 scalar cycles, held pose, ancestor rotation, rigid unit scales, exact reseating without limb/weapon transform drift, and continuous slide-driven canopy tilt.
- Actual browser buttons were exercised: open, hold, close mid-cycle, reopen, fully close.
- Reopened native-file parity: maximum matrix error 1.8328429e-6 across sampled forward and reverse states.
- Native mesh/rest-bone preservation: all 196 original mesh geometries and all 62 rest bones match the accepted source. No ankle proportions, rest lengths, or mesh vertex coordinates changed.
- Exact exported triangles sampled at 41 amounts. No new collision pairs relative to the inherited closed seams. Canopy clears all meshes throughout the main travel (amount >= 0.30). The cheek bases retain their inherited contact/overlap with the fixed collar/chin mating surfaces at full opening, rather than translating away from it. These existing carrier contacts are recorded in `export-clearance.json`; this is not a claim of a manufacturing-clean assembly.
- The sweep is valid for the requested thin outer canopy and this service pose. The hidden solid canopy volume is intentionally excluded, as directed; it would intersect the torso on this tighter path. It is not an all-possible-weapon-pose clearance guarantee, a physics collision implementation, or player runtime proof.

Run `npm test`. Rebuild the temporary glass export first with `scripts/cockpit/build_glass_preview.py`. From repository root, Blender can rerun `scripts/cockpit/build_native.py` against the read-only source, and `verify_native.py`, `verify_preservation.py`, `verify_service_pose.py`, and `audit_export.py` produce the included receipts. The service-pose matrices and reused runtime files are preserved for reproducibility.
