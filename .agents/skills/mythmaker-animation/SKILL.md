---
name: mythmaker-animation
description: Plan and iterate on character or mech animations in Myth Maker, using explicit motion intent, protected checkpoints, keyframe review, and a fast path from preview to accepted runtime behavior.
---

# Animation direction and iteration

Use this for a new animation set, a motion-quality complaint, or resuming an animation effort. Start at the unfinished stage; do not restart an accepted rig. For joint anatomy and mechanical motion use [mechanical-rig-motion](../mechanical-rig-motion/SKILL.md). For engine delivery use [animation-runtime-shipping](../animation-runtime-shipping/SKILL.md). Read the [Strokah case study](references/strokah-case-study.md) when the task resembles that effort; its proportions, timings and controls are examples, not universal defaults.

## Establish the smallest useful brief

Inspect the current scene/export/controller and the user's latest feedback. Record:

- Source model, native file, export, controller revision, scale and forward/up axes.
- Requested motion states and actual input bindings; separate authored clips, procedural motion and gameplay behavior.
- Silhouette and timing intent: height, stride, weight, contact style, aim/carry, and transition behavior.
- Accepted checkpoint, current candidate, one observed defect and the next comparison that can resolve it.

Use the [run record](references/run-record.md) for a sustained effort. Keep one current status block; historical notes must not masquerade as current instructions. Ask only for a missing decision that changes the work. Do not infer that a preview assignment also includes Unity integration, new weapons, VFX, or publication.

## Fast review loop

1. **Inspect before tuning.** Reproduce the complaint at a known phase and camera. Convert “baby steps,” “marchy,” “flat-footed,” or “floating grip” into an observable difference. A user's annotated image outranks a plausible-looking generic rig.
2. **Make one coherent change.** Choose the relevant layer: anatomy/binding, contact planner, trajectory/timing, body response, weapon anchors, or gameplay input. Do not compensate for bad anatomy with arbitrary wrist or knee rotations.
3. **Use the cheapest real preview.** Reuse a running local preview and a deterministic reset. Prefer a lightweight exported-rig controller for trajectory iteration when procedural animation fits the task. Use native Blender for actual mesh/bone/bind edits, following the repository's current GUI/ownership contract. Do not bring up Docker workers merely to tune one animation.
4. **Self-review matching poses.** Compare launch, contact, compression, push-off, passing/knee drive and next contact at matched phase. Use side view for stride/lean, front for splay, and opposite/rear quarter for attachments and occluded joints. Keep scale, camera, playback cadence and reset state consistent.
5. **Measure physical invariants.** Check reach, local hinge axes, sole clearance, grip error and continuity where applicable. Use metrics to diagnose, not to overrule a visibly wrong motion. Do not lower physical tolerances merely to turn a failing artistic candidate green.
6. **Show a short actual-render GIF.** Prefer 2–5 seconds with enough distinct frames to read the motion, plus a contact sheet for ambiguous poses. Decode and inspect the final GIF. A nominal 30 fps file with repeated screenshots is not a 30 fps capture.
7. **Promote or refine.** When accepted, save a named immutable checkpoint with source/export/controller identity and a representative GIF. Keep later sprint/dash work separate from the accepted walk. One defect does not justify rebuilding the whole set.

For video reference, inspect actual phase-matched frames from a named source; distinguish observed movement from guesses hidden by cuts or camera angles. Do not claim a Titanfall comparison from a wiki image alone.

## Convergence and stopping

After each meaningful iteration state: what changed, what the evidence shows, and the one remaining issue. Re-run focused checks first; run the broader suite at a meaningful milestone or when changes cross layers. Do not repeatedly rebuild unchanged Unity code, reproduce the same capture, or request user approval for reversible tuning.

User acceptance closes artistic review for that version. Agent self-ratings and green tests do not. Reopen an accepted decision only for new evidence or a user correction. If a control/tool blocks proof, identify it early, request the smallest necessary user action, and finish independent work. Preserve a resumable record rather than looping through status updates.
