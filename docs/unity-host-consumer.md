# Unity host consumer handoff

Build Room emits `unity-host-handoff.json` beside each observed local Blender
generated-artifact manifest. It is a host-consumer input, not a Unity runtime
result. The document has a fixed `8000` ms load budget and contains a closed
`AssemblyReceipt` with the frozen selected package, exact selected GLB
asset/revision, `file:` URI, canonical local path, byte length, SHA-256, and the
original Build Room assembly receipt including its selected runtime hash.

The consumer re-reads the resolved GLB path and rejects a URI/path mismatch,
missing bytes, a byte-length mismatch, changed digest, changed package hash, or
a mismatched source Build Room receipt. `selected_animations` may be empty
until the animation workstream publishes a selected animation revision.

Evidence is deliberately one-way. A handoff can be emitted only from observed
`local_blender_cli_only` source evidence; a fixture cannot be relabeled
observed. Its `host_load` and `player_facing` fields are both `not_observed`.
Loading this manifest in a Unity adapter is the next task; this repository does
not claim that the host imported, rendered, or played it.

`concept_lineage` is explicit: current D0 output carries the source
`reuse_maintenance_waiver`, including its bounded reason, approver,
approval/expiry timestamps, and asset scope. `not_recorded/pre_gate_bootstrap`
remains available only for older bootstrap material. Exact concept revision
references are also supported, so the concept-first enforcement task can reject
absent or expired lineage without changing the consumer shape.
