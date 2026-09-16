# Strokah structural-loss candidate

Local, actual-model prototype on `codex/strokah-structural-loss`. No Unity edits, merge, release, or publication. The accepted source checkout is read-only. `provenance.json` identifies the original GLB, native Blender file and vendored procedural rig code.

## Run

From the repository root:

```sh
npm ci --prefix experiments/strokah-structural-loss
node experiments/strokah-structural-loss/hydrate.mjs /absolute/path/to/strokah-stable-gait-v10.glb
node --test experiments/strokah-structural-loss/*.test.mjs
node experiments/strokah-structural-loss/serve.mjs
```

Open the printed localhost URL. Choose a limb and use Heavy hit; alternatively Shift-click its actual mesh. Two 30-point hits consume the default armor; three subsequent exposed hits sever. Weak hits do not accumulate structural stress. Aim, fire, pause, orbit and reset are available. The crawl-forward checkbox stops travel and allows active swings to land.

## Behavior and boundaries

- `StructuralState` is separate from health/stagger. `armor`, `minimumImpact`, `structuralCapacity`, `minimumHits`, `transitionSeconds` and `crawlSpeed` are parameters. A single oversized impact cannot bypass the minimum repeated-hit count. The armor-breaching hit does not spill into structure.
- `LimbOwnership` transfers the original distal `upper_arm` or `thigh` hierarchy. Fingers, heel/toe assemblies and the corrected shoulder shell stay with their limb. Chassis-side mounting sockets stay on the actor. The independently parented rifle control belongs to the right arm and moves with its debris. Lost limbs are removed from motion solving and mesh-hit queries; no hidden duplicate limb remains.
- The preview uses mesh-triangle raycast hit colliders and a bounding-box ground collision for each coherent debris group. Debris receives initial linear/angular velocity and settles on the flat floor. This is **not a Unity Rigidbody/collider implementation**; game collision layers, inventory/action ownership and terrain integration need a separate port.
- One-leg loss blends into a low posture over 1.2 seconds. The surviving foot and free left hand alternate world-space plants. The existing weapon control and trigger anchor continue to drive the right arm; its arm never becomes a support hand while holding the rifle. Original segment lengths and scale are unchanged. Accepted local-X leg/elbow hinge solvers and shoulder-shell binding are retained. A separate support-hand orientation is derived from the real finger/palm frame.
- Losing the weapon arm drops the rifle and rejects firing; the surviving hand remains usable for support. Losing the free hand while crawling stops travel and preserves the gun arm for aiming. Both legs lost or no free support hand selects a stationary degraded posture; no invented weapon transfer or one-handed locomotion is attempted.
- Reset restores original ownership, exact initial transforms, weapon availability, contacts, transition history, stress, shot count and debris state.

The existing Unity `MechPartDamageState` was inspected read-only: armor first, then exposed bone, without same-hit spillover. `MechPart` currently hides destroyed bone renderers and retains repair colliders. That path has **not** been changed or represented as gameplay delivery. Armor/exposure in this preview is authoritative numeric state with UI feedback; the supplied accepted rig has no separate game armor-panel lifecycle. This candidate covers flat-floor forward crawl; terrain-adaptive turning, weapon switching and player integration are outside its evidence.

## Review artifacts

Local files under `output/structural-loss/`:

- `crawl-left.gif`: 100 sampled renders, 20 fps, five seconds. Repeated hits, loss, transition, crawl and surviving-weapon fire.
- `crawl-right.gif`: same sequence from the rear quarter for the other leg.
- `arm-loss-reset.gif`: 80 renders, 20 fps, four seconds. Left arm loss, redundant hits, firing, reset, then right arm and owned rifle loss with firing rejected.
- `crawl-left-checkpoint.glb`: saved static candidate including detached debris. Reopen independently of the controller to inspect mesh ownership and the pose.
- `side-final.png`, `quarter-final.png`, `rear-final.png`, `opposite-final.png`: actual-model review angles. `crawl-decoded.png` and `arms-decoded.png` are decoded GIF contact sheets.
- `tests.txt` and `receipt.json`: focused results and artifact hashes.

The rendered GIFs were decoded and inspected. Review confirms readable separation, low posture, planted support hand, surviving gun aim and coherent dropped rifle. Artistic acceptance remains with the user; this is not an assertion of shipped gameplay or dynamic stability on arbitrary ground.

To repeat capture, create `frames-left`, `frames-right`, `frames-arms` under the output directory, load the preview in Playwright CLI, and pass the contents of `capture.playwright.js` to its `run-code` command. It advances the same live controller at 60 Hz and captures every three steps. Encode each sequence with ffmpeg at 20 fps using palettegen/paletteuse. The hook does not substitute a separately authored animation for the actual controller.
