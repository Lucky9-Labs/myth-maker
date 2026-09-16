---
name: mechanical-rig-motion
description: Rig and refine articulated mech motion, including mechanical hinge anatomy, mirrored parts, weapon grips, planted feet, stride, sprint, and dash transitions. Use for joint or movement fidelity problems rather than generic humanoid retargeting.
---

# Mechanical rig and motion

Begin with the user's intended anatomy, not a generic two-bone humanoid assumption. For planning and review use [mythmaker-animation](../mythmaker-animation/SKILL.md); for engine integration use [animation-runtime-shipping](../animation-runtime-shipping/SKILL.md).

## Bind once in a known neutral pose

- Save the accepted scene and pose before edits. Temporarily straighten/symmetrize the model or restore its T-pose to establish pivot centers and mesh attachments, then restore the working weapon posture.
- Identify joints from the actual mating surfaces. On the Strokah example, hips are ball joints; knee, lower-shin/ankle, heel and toe components are mechanical hinges. A hose-like double knee needs its own lower-shin link, not a twisted ordinary shin.
- Locate the true ankle and branch heel and ball/toe articulation from the intended support structure. Match the bone to the part's organic extension axis. Do not lengthen a cylindrical joint cap or stretch along an arbitrary world axis.
- For a proportion experiment, make a reversible variant. If accepted anatomy returns to original proportions, restore both mesh and skeleton; do not leave stretched bones underneath the original mesh.
- Mirror an approved component from a neutral symmetric pose when appropriate. Validate rest transforms, handedness, negative scales, pivot centers and local axes separately on both sides. Mirrored names alone do not prove equivalent behavior.
- Bind shoulder shells to the upper-arm relationship in neutral pose; constrain elbows and knuckles to plausible local axes/ranges. Recheck attachment through multiple poses, not only the rifle pose.

Do native scene/mesh edits using the tool path authorized by the current repository. Discover the live source and ownership contract; old absolute worktree paths are historical evidence, not permission to edit that scene.

## Weapon owns the common grip frame

First shape a plausible right-hand grip with the wrist aligned to the forearm, fingers wrapped around the handle, and index at the trigger. Fit the rifle into that hand; then seat the left hand at the foregrip. Keep non-index fingers clear of the grip; grouping fingers is an optional control simplification, not a reason to discard useful articulation.

Create a weapon control with fixed trigger and foregrip anchors in weapon-local coordinates. Solve arms to those anchors with ball shoulders, hinge elbows, stable elbow poles and wrist orientation. Moving the weapon for carry, sway, scope or recoil then carries both targets together. For reload, temporarily blend the support hand to an explicit override and back to its original anchor.

If a grip is unreachable, inspect weapon placement and arm reach before twisting wrists or stretching bones. Translation of the whole weapon can solve reach while preserving its orientation and grip spacing. Keep one transform owner for each layer to avoid double application. Test both grips during locomotion, near-target aim, scope and recoil—not only at rest.

## Ground and joint constraints

Keep planted contacts in world space. Establish the leg plane through the hip; do not put turn yaw into a knee or ankle hinge. Solve all leg segments, including the extra lower-shin link, with stable branch selection across frames. Check local hinge axes and 3D angular continuity; a projected bone line or offset bone origin can falsely look like twist.

Sample toe and heel support independently against the same surface that is rendered. Check foot geometry/sole clearance, not just ankle height. Restrict ground corrections to plausible articulation; a “clearance fix” can otherwise produce upward toes or backwards folds. Preserve the last valid complete contact plan if one new sample fails—do not half-reset one foot.

Read [motion recipes](references/motion-recipes.md) when tuning gait or transitions. Values must come from the current mesh, scale and requested style; Strokah's old constants are not universal presets.
