# Build Room high-fanout stress receipt

Run the reproducible local stress compile with:

```sh
npm run demo:build-room-stress -- --output evidence/build-room-kraken-high-fanout-stress.json
```

The script starts the real local Build Room HTTP server, submits a generic
high-fanout compile whose brief happens to be the kraken demo, waits for the
planner/dispatcher receipts, and saves the returned projection. It does not
insert a fixture or translate a remote receipt. The saved bundle is an observed
local Node-process/Blender CLI/HTTP receipt only; its adjacent `.artifacts`
directory retains the source, render, runtime, and manifest outputs named by
the receipt. Its explicit `unverified` array excludes
remote coordination, remote workers, host-game acceptance, and player-facing
runtime.

## Acceptance mapping

### D0 step 9

The exact D0 step is: Build Room visibly reports material and arena work orders,
their worker IDs, dependencies, receipts, artifacts, and revision counts; and
shows compatible selection, fallback, or rejection outcome with honest evidence
tiering.

This slice uses the generic immutable component graph with sixteen component
roots, assembly, and validation. It includes `material-binding` and
`arena-envelope` alongside independently revisioned body segments, critical
spots, and motion clips for each requested role.
The live Build Room surface reports each lane's component tag, worker ID,
dependency list, elapsed time, deadline timer, status, evidence kind, catalog counters, package revisions,
and explicit selected/rejected/fallback outcome. `freeze_current_package` makes
the selected package an immutable local frozen snapshot. A local process receipt
does not claim an artifact or catalog revision for a lane that did not produce
one. The stress command requests the existing local Blender body path, so its
body/animation catalog revisions and render are observed locally; material and
arena lanes remain receipt-only until real workers publish candidates.

### C3 — deadline job and worker observability

Observed locally: the request has stable encounter/request/correlation IDs,
ordered worker-event receipts, current package state, catalog counters, package
freeze receipt, SSE projection, and a steering queue receipt. The server still
uses a local process deadline placeholder, and queued steering is not yet proven
to alter a worker's next priority. There is no external coordinator observation.

### C4 — horizontal draft lanes

Observed locally: the generic planner emits independent body, body-segment,
critical-spot, motion, material, arena, and combat lanes; the dispatcher launches
component roots in parallel, then assembly and validation. The stress receipt preserves
their individual completion records and the baseline selection remains valid
when no candidate modules arrive. Material, arena, and non-body component workers do
not yet produce immutable candidate artifacts, so this is worker-observability
and fallback proof, not production asset-worker or host-runtime proof.
