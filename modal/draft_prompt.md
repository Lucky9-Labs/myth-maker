# Encounter component: {{COMPONENT_ID}}

Create or refine only the encounter component named `{{COMPONENT_ID}}` for an
FPS boss encounter. Treat `/inputs/source_scene.blend` and the four named
reference images as immutable context. Work only through Blender's visible GUI:
do not open the Python Console, run scripts, use a terminal, paste code, or
directly modify a `.blend` file.

The component contract supplied with the job is the authority for gameplay
role, scale, attachment interfaces, collision intent, animation constraints,
and visual language. Do not invent neighboring encounter systems, overwrite
other components, or claim that a gameplay-ready enemy, loot item, or level has
been integrated. Make a meaningful visible edit, inspect it from useful angles,
and save the native file through Blender's GUI as `/output/{{NATIVE}}`.

Use deliberate, small batches. Preserve a clear screenshot after each material
change. Before the interaction budget is exhausted, save a resumable checkpoint
and report exactly one marker on its own line:

- `DRAFT_STATUS: PARTIAL` for a valid continuation point.
- `DRAFT_STATUS: BLOCKED` with the concrete blocker.
- `DRAFT_STATUS: READY_FOR_REVIEW` only when requesting external review.

`READY_FOR_REVIEW` is never acceptance. A saved file, a screenshot, or a model
report does not prove engine import, player-facing gameplay, rigging, collision,
or encounter balance.
