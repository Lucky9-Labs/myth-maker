# Strokah mechanical cockpit — lean crown sweep

Saved review candidate on `codex/strokah-cockpit-mechanical`, based on current `main` (`be4cb5ad`) plus only the requested animation skills commit. No merge, publication, Unity integration, damage, limb-loss, melee, shield or ejection work.

Both user corrections are applied: the chin has a short outward/downward stroke, and the canopy sweeps backward over the crown instead of lifting vertically into a tall open position. The canopy is treated as a thin pane. Its retained internal solid mass is excluded from the clearance envelope. Diagnostic colors identify the panels.

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
| Canopy | `tripo_part_61.001` | forward release, lift/tilt, then back over crown; 90° cam rotation; thin-pane clearance |
| Left cheek | `tripo_part_57.004` | +0.045 sideways, +0.050 forward, −0.021 down |
| Right cheek | `tripo_part_57.005` | −0.045 sideways, +0.050 forward, −0.021 down |
| Chin | `tripo_part_new_0.001` | +0.026 forward, −0.021 down |

These are already separate rigid meshes; **no destructive source cuts were needed**. Following the thin-glass direction, `build_glass_preview.py` selects 3,358 frontmost exterior triangles from the 7,666-triangle exported canopy into a separate preview copy. In Blender, `Cockpit_Glass_Preview` displays this thin skin, while the complete original canopy remains present but hidden. Its underside bulk can be deleted/cleaned later. This temporary skin has an unpolished boundary; it is not final glass topology. The source has concealed overlapping seat surfaces between canopy, cheeks, chin and the fixed collar/carrier. All original mesh surfaces were preserved. A manufacturing-clean assembly would require trimming those internal mating surfaces; this candidate does not claim zero triangle overlap while the source seams disengage. No pilot interior or visible actuator hardware was invented.

The pose uses the accepted `UpperBody` / `WeaponGripRig` solver with the common weapon control lowered 0.10 and tucked back 0.12. Original trigger/foregrip anchors and upper-arm shoulder binding are reused. Both grip errors are below 1e-6. This is a static review service pose, not a new gameplay action or a weapon-stowing transition. Native source actions remain as datablocks; their playback is disabled in this derivative so the cockpit demonstration does not also play locomotion.

## Controls and integration

`createCockpitRig(root, config)` in `cockpit-binding.mjs` binds the accepted neutral actor once. It returns `motion` with `amount` in [0,1], `state`, `open()`, `hold()`, `close()`, `seek(amount)` and `update(dt)` (seconds). Default opening time is 1.65 seconds. Parent waist motion remains inherited; positions and rotations are always derived from immutable neutral matrices. Do not also run a second animation track on the same four panel transforms.

`mechanism.json` owns panel identity, clearance/travel intervals, cam pivot, and travel values. Quintic phase curves stop smoothly at clearance and travel endpoints. Reversal follows the same path without a pose jump or accumulated transform error; velocity changes sign immediately when commanded.

Native equivalent: select `CTRL_Cockpit_Open`, custom property `open_amount`. Its dedicated action includes open, hold, partial close, reversal, and reseating through frames 1–144. Clear/mute that control's demo action when driving the property manually. Native drivers use only built-in expressions; no auto-run Python handler is required.

## Validation and limits

- Four focused Node tests pass, including the actual accepted GLB, 200 bound-model reversal cycles, 1,000 scalar cycles, held pose, ancestor rotation, rigid unit scales, and exact reseating without limb/weapon transform drift.
- Actual browser buttons were exercised: open, hold, close mid-cycle, reopen, fully close.
- Reopened native-file parity: maximum matrix error 1.4901162e-7 across sampled forward and reverse states.
- Native mesh/rest-bone preservation: all 196 original mesh geometries and all 62 rest bones match the accepted source. No ankle proportions, rest lengths, or mesh vertex coordinates changed.
- Exact exported triangles sampled at 41 amounts. No new collision pairs relative to the inherited closed seams. Canopy clears all meshes throughout the main travel (amount >= 0.30). All four panels have zero surface intersections from 0.85 through full opening. The earlier inherited seam overlaps are recorded honestly in `export-clearance.json`.
- The sweep is valid for the requested thin outer canopy and this service pose. The hidden solid canopy volume is intentionally excluded, as directed; it would intersect the torso on this tighter path. It is not an all-possible-weapon-pose clearance guarantee, a physics collision implementation, or player runtime proof.

Run `npm test`. Rebuild the temporary glass export first with `scripts/cockpit/build_glass_preview.py`. From repository root, Blender can rerun `scripts/cockpit/build_native.py` against the read-only source, and `verify_native.py`, `verify_preservation.py`, `verify_service_pose.py`, and `audit_export.py` produce the included receipts. The service-pose matrices and reused runtime files are preserved for reproducibility.
