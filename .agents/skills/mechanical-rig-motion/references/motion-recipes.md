# Motion recipes and diagnosis

## Stable powerful walk

Shift weight slightly toward the support leg, initiate the opposite step, then push from the planted foot as the pelvis advances. Place the next foot ahead of the body and transfer weight smoothly. Coordinate knee/ankle bending to keep pelvis height relatively steady. Preserve enough trailing support for the thigh to swing behind the hip when the desired anatomy permits it.

If the walk reads as tip taps, inspect world travel per step, swing duration, touchdown prediction and the trailing-step trigger together. Increasing knee lift alone makes a march. If it looks crouched, inspect reach fitting and anticipatory pelvis lowering before shortening the stride. Do not make the torso launch first during ordinary walking merely because that works for dash.

Tie upper-body weight response to actual touchdown events: small compression then damped rebound. Give supported upper-body joints independent lag/rebound where the rig has those joints. Do not invent a chest or neck joint absent from the source. Keep gun and grips coordinated through the response.

## Committed sprint

For the Strokah brief, sprint was forward-only and aggressive: forward whole-body commitment, strong thigh drive, long travel, a pointed recovery foot, trailing heel lift, and toe-first landing. This is a style example; confirm a different character's brief.

Review the full cycle: toe peel/push-off → trailing fold → knee drive and forward carry → pointed strike ahead → compression → next push. Couple foot pitch to its trajectory and actual toe pivot. Delay heel loading after toe strike. Raising the foot while still targeting an immediate flat landing produces sneaking or marching rather than a sprint.

Measure distance per stride alongside time and apparent lift. Let the recovery path stretch in the travel direction instead of merely making a taller circular pedal. Drive body-height response from contact/push-off timing, not primarily from the height of the swinging foot. Preserve branch and angular-velocity continuity in every leg segment.

Carry the rifle across/toward the chest using a shared control; rotating only its barrel away from the torso is not a tuck. Add arm/rifle sway together. A slight muzzle-down carry can blend out for scope. Compare the actual silhouette at contact with the reference, not just maximum lean numbers.

## Dash and return

Use the latest brief. Strokah ultimately required a torso-led velocity burst with feet skimming/dragging during the burst, not alternating steps; normal stepping recovers afterward. Earlier “catch steps throughout dash” experiments were superseded.

Add the burst to current locomotion intent. Preserve foot positions, outgoing velocities, pitch, pelvis height and reach allowances into the exit. A Hermite residual or equivalent continuity-preserving blend can return to idle/walk/sprint without resetting gait or creating synthetic touchdown events. Inspect both entry and exit, all requested directions, and missing-ground/airborne behavior. Do not invent air dash when gameplay rejects it.

## Reset is different from transition

Explicit teleport/reset may rebuild contacts and clear temporal solver history. Ordinary state changes should preserve it. A deterministic reset must clear torso springs, segment-angle history, foot phases and relevant aim state, so repeated comparisons show the same motion. Failed support acquisition should preserve a complete valid state or enter a defined fallback.

## Symptom → next inspection

| Symptom | Inspect first |
| --- | --- |
| Baby steps / march | Stride distance, swing duration, trailing support and pelvis reach fitting |
| Scooby-Doo / sneaking sprint | Whole-body lean, early foot drop, foot pitch, forward carry and toe strike |
| Toes up at lateral exit | Ground-correction range, mirrored local axes and rest pose |
| Joint snaps / illegal twist | Hip plane, branch continuity, local-axis constraints and angular velocity |
| Floating support hand | Weapon-local anchor, target reach and duplicate transform owners |
| Finger explosion | Rest/bind mismatch, accumulated pose deltas, export state and competing controls |
| Torso flips near terrain | Camera hit target changes, near-muzzle aim range and iterative convergence |
| Shoulder disconnect | Neutral attachment and parent/bind relationship before pose compensation |
