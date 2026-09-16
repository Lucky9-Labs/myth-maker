# Strokah: effort-driven damaged locomotion

The actual accepted Strokah rig hauls its grounded chassis through short, weak efforts. Body translation comes from available contact force overcoming friction. Surviving limbs drag between attempts. Severed limbs tumble as independent articulated physics bodies.

This is the local Three.js/Cannon preview in this worktree. It does not modify the Unity game or the read-only accepted Blender/source checkout. `provenance.json` records the source hashes; the original proportions, bone lengths, shoulder shells and weapon grip anchors are retained.

## Run and interact

From the repository root:

```sh
npm ci --prefix experiments/strokah-structural-loss
node experiments/strokah-structural-loss/hydrate.mjs /absolute/path/to/strokah-stable-gait-v10.glb
node --test experiments/strokah-structural-loss/*.test.mjs
node experiments/strokah-structural-loss/serve.mjs
```

Open the printed URL. The combination selector applies real repeated structural hits to the selected limbs. Individual heavy/weak hit buttons and Shift-click mesh hits also work. Fire, aim, external shove, pause, orbit, deterministic reset and movement intent are available.

Two default 30-point hits consume armor. Three subsequent sufficiently powerful hits sever a limb once. Weak exposed hits do not build structural stress. Armor breach does not spill into structure on the same hit. `StructuralState` owns these thresholds independently of movement and health/stagger.

## Mechanics

`EffortMotion` chooses an available actuator and sequences **reach → plant → pull/push → recover**. Passive limbs drag. It prefers the free hand and surviving legs; the weapon arm becomes a brace when it is the only remaining actuator. Each third attempt loses more purchase and can stall. Recovery lasts 1.5–1.96 seconds, giving intermittent progress and long rests.

The planar body model integrates mass, applied contact force, static/sliding friction, velocity drag, external impulses and the tangential component of gravity. It has no prescribed crawl speed. Force is gated by the previous actual rig solve: reach error and surface clearance must establish purchase. The rendered chassis settles against its actual lower hull bounds. The remaining foot is solved in its original local hinge plane, rate-limited, and allowed to scrape rather than alternate a proper walking gait.

Defaults in `EFFORT_DEFAULTS`: 70 kg effective mass, 82 N pull, 70 N push, 45 N static friction, 30 N sliding friction, 90 N·s/m velocity drag. Pass `{effort: {...}, ...structuralThresholds}` to `StructuralController` to tune them. Terrain examples are flat-floor proofs. The slope force input is unit-tested; there is no claim of arbitrary terrain traversal or balance recovery.

The rifle keeps its common trigger/foregrip frame. During a sole weapon-arm effort it lowers gradually to brace; firing is rejected until it recovers. Otherwise it remains available and dips slightly with exertion. The unarmed hand uses its own captured start pose and a palm support frame, never the dropped gun's moving anchors.

`LimbOwnership` moves the original hierarchy into three physical links per severed limb. The rifle stays with the severed right hand. Cannon hinge constraints retain the separation pivots and bound relative ragdoll articulation to ±0.45 radians from that pose. A mass-weighted physical impulse and angular velocity initiate tumbling. Convex boxes represent rigid visual clusters; original mesh triangles remain precise hit targets. Links within one limb ignore self-collision to prevent overlapping joint shells from fighting the constraints; floor and other-limb collisions remain active. Detached geometry is removed from actor hit queries and animation solving. This preview does not simulate collisions between debris and its former owner's animated hull.

Reset restores exact original transforms/parents, all meshes, weapon ownership, force/contact history and physics bodies/constraints. Original source files are never edited.

## Available-limb policy

| Remaining capability | Motion |
|---|---|
| Free arm | Reach, plant, pull the grounded chassis, scrape back, recover |
| Leg(s) | Brief heel/foot purchase and shallow extension; otherwise trail and scrape |
| Weapon arm only | Lower the still-gripped rifle to brace, pull, then recover aiming |
| No limbs | No self-propulsion; inertia, external shove or slope force can move the chassis |

Mask bits identify **lost** limbs: 1 = left arm, 2 = right arm, 4 = left leg, 8 = right leg. The 15 non-empty combinations are all reviewed, with an intact baseline as a control.

## Verification and reproduction

`effort-motion.test.mjs` covers every availability combination, rests, force pulses, loss of purchase, momentum, external impulses and slope force. `actual-rig.test.mjs` covers articulated ownership, colliders, independent tumbling, exact reset, local hinge motion, actual contact-gated propulsion for each single-limb survivor, weapon bracing, and zero-limb immobility. `matrix-audit.mjs` exercises all 15 combinations for eleven simulated seconds and records travel, contact, joint continuity and physical separation tolerances.

ShowMe evidence lives in `output/structural-loss/weak-final/`: fifteen 5-second GIFs, intact baseline, side/opposite keyframes, decoded GIF contact sheets, per-case telemetry, numeric audit, review judgments and receipts. `capture-matrix.playwright.js` operates the real combination selector and samples the same live controller at 60 Hz, capturing every three steps. Run it through Playwright CLI with `?begin=1`, `4`, `7`, `10`, `13` to capture three cases at a time. `encode-matrix.py` encodes, decodes and counts distinct rendered frames.

The review records candidate quality, not user artistic acceptance. No merge or gameplay release is requested. ShowMe publication, if verified, is only the skill's short-lived visual-proof copy; durable graduation is separate.

Run `python3 experiments/strokah-structural-loss/build-review.py` after encoding to validate captured identity/contact/ownership signals and regenerate the offline gallery and per-case judgments. `slip.gif` shows a late failed attempt; `shove.gif` shows external-only movement without limbs. `checkpoint.mjs` reads back the saved effort GLB.

Desperate reach tuning: free/weapon hand plant is 0.55 m ahead of the body versus a 0.17 m resting position (0.38 m stroke); reach arc rises 0.10 m. Leg draw-in runs from -0.50 m to -0.32 m (0.18 m stroke), keeping the foot flat instead of using a walking toe pitch. Force, friction and long recovery are unchanged: wider intent still earns little travel. Follow-up captures are in `output/structural-loss/desperate/`.
