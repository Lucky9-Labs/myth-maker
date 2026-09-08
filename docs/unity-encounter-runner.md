# Unity encounter-runner evidence boundary

The encounter runner is generic: it is not the host game and does not import, mutate, or claim a runtime from any other Unity checkout. Its input boundary is an immutable `PlayableEncounterPackage` together with an `AssemblyReceipt` that pins each selected asset and animation to an exact stable ID, revision, URI, and SHA-256. The runner rejects ready/candidate packages, missing selections, changed receipt hashes, and non-local profiles.

## Closed profile for this local proof

`unity-neutral-headless@1` means Unity **6000.6.0f1**, macOS, Mono, `editor-macos-mono-batch`, and `-nographics`. This is an installed-editor fixture, not a shipping player, license grant, or host-game compatibility approval. Its use is subject to the editor installation's existing Unity license; no Unity Cloud, streaming provider, credentials, resources, or provider mutations are included.

Evidence is intentionally tiered:

| Tier | Meaning | Status here |
| --- | --- | --- |
| Local Unity runner | An installed local editor or player ran the neutral chamber and emitted a receipt. | Implemented by the batch fixture. |
| Cloud headless validation | A provisioned cloud runner observed a headless validation receipt. | Contract only; provisioning is out of scope. |
| Cloud rendered/streamed preview | A provisioned renderer/stream produced an observed frame or clip with hash. | Contract only; no visual is fabricated. |

A `SimulationReceipt` names the package/assembly hashes, runner/runtime/build profile, source/runtime/player evidence tiers, deterministic seed and script hash, pass/fail telemetry, bidirectional damage exchange, timing, logs, failure codes, and selected-input provenance. `frame_or_clip_artifact` is forbidden while player evidence is `not_observed`.

## Build Room projection rule

Build Room consumers may show a simulation state, package identity, and a recorded frame/clip only from an observed `SimulationReceipt`. A local orchestration receipt is not a player visual. Cloud tiers remain unavailable until the corresponding provisioned runner provides an observed receipt.
