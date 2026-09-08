# Resume protocol: {{COMPONENT_ID}}

This is a continuation of the saved encounter component, not a fresh modeling
task. Open `/output/{{NATIVE}}` through Blender's GUI, keep the restored
`/inputs` paths stable, and preserve existing geometry unless the current job
contract explicitly directs a correction.

Read the parent handoff and inspect the visible scene, saved file, references,
active mode, and selection before editing. Work only in Blender's GUI; no
Python Console, shell, headless geometry, or direct native-file changes.

Do not perform unbounded cloud polishing. Save a changed native file through
the GUI before a checkpoint, leave current visual evidence, and finish with a
`DRAFT_STATUS` marker. This checkpoint is evidence for later review and engine
integration; it is not acceptance.
