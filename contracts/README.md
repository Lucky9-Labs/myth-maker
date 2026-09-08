# Encounter contract boundary

`v1/` is the first stable interchange boundary between the coordinator,
generation workers, artifact builders, and the Unity host. The schemas describe
encounters generically; no actor shape, scale, genre, or objective is privileged.

The firm contracts are:

| Contract | Owner | Purpose |
| --- | --- | --- |
| `HostCapabilityManifest` | Unity host | Declares executable modes, loaders, supported contracts, and budgets before planning starts. |
| `EncounterSpec` | Host/coordinator boundary | Captures the seed, cutoff, objective, world envelope, and desired roles. |
| `EncounterWorkOrder` | Coordinator | Assigns one parallel, idempotent unit of work with explicit dependencies and leases. |
| `WorkerEvent` | Worker/coordinator boundary | Appends observable lifecycle events and candidate receipts. |
| `EncounterModule` | Worker/assembler boundary | Describes one composable behavior, asset, or remote-logic contribution. |
| `PlayableEncounterPackage` | Assembler/host boundary | Names one immutable, compatible module selection that can be preloaded and frozen. |

## Stability rules

- `schema_version` is required and is the string `"1"` for this directory.
- Producers may not add undeclared fields. A new field requires a new published
  schema revision; breaking semantic changes require a new version directory.
- IDs are stable lowercase identifiers. Artifact content is immutable and
  addressed with a SHA-256 digest.
- Encounter modules declare what they provide, require, and conflict with. The
  assembler—not an individual worker—owns compatibility and package selection.
- Every non-recipe module references an external artifact. A recipe is the only
  execution kind permitted to carry its implementation inline.
- `managed_plugin` is a capability, not a baseline assumption. A host advertises
  it only after the target player has passed a dynamic assembly-loading spike.
- Unknown or unsupported execution kinds fail compatibility checks; they never
  prevent selection of a declared fallback module.

These schemas intentionally do not standardize the internal Unity command API,
artifact file formats, scoring algorithm, or coordinator persistence layout.
Those interfaces remain ambiguous until their implementation spikes establish
what the target player and generation services can actually support.

## Composition v2

`v2/` adds the closed, generic composition coordination contract while keeping
the stable v1 dispatcher and package interfaces intact. It names immutable
module content hashes and exact revision references; capability/ownership-aware
work items with ordered resource claims; and a receipt/projection for the
current coherent whole. See
[`docs/composition-swarm-coordinator.md`](../docs/composition-swarm-coordinator.md)
for the explicit implementation boundary, including the machine-visible
unimplemented geometric-stitching limitation.
