# Encounter contract boundary

`v1/` is the first stable interchange boundary between the coordinator,
generation workers, artifact builders, and the Unity host. The schemas describe
encounters generically; no actor shape, scale, genre, or objective is privileged.
`v2/` publishes the planner/work-order evolution and an additive runtime
artifact negotiation boundary, while leaving every v1 schema unchanged for
its existing producers.

The firm contracts are:

| Contract | Owner | Purpose |
| --- | --- | --- |
| `HostCapabilityManifest` | Unity host | Declares executable modes, loaders, supported contracts, and budgets before planning starts. |
| `EncounterSpec` | Host/coordinator boundary | Captures the seed, cutoff, objective, world envelope, and desired roles. |
| `EncounterWorkOrder` | Coordinator | Assigns one parallel, idempotent unit of work with explicit dependencies and leases. |
| `WorkerEvent` | Worker/coordinator boundary | Appends observable lifecycle events and candidate receipts. |
| `EncounterModule` | Worker/assembler boundary | Describes one composable behavior, asset, or remote-logic contribution. |
| `PlayableEncounterPackage` | Assembler/host boundary | Names one immutable, compatible module selection that can be preloaded and frozen. |
| `PackageDiscoveryManifest` | Cloudflare/host boundary | Pins a selected frozen package, accepted catalog/assembly evidence, remote GLB artifacts, and an Ed25519 signature. |
| `PackageDiscoveryManifestV2` | Cloudflare/host boundary | Negotiates one immutable artifact representation per module against the host's declared media type, loader, platform, and build, then signs the selected set with Ed25519. |
| `RuntimeArtifactPublicationV2` | Railway publisher/host boundary | Binds exact immutable runtime bytes to an allowlisted media type, safe content-addressed location, and concrete host selection tuple before public retrieval. |
| `GlbAssemblyManifest` | GLB assembler/host boundary | Defines one hash-addressed, deterministic composite runtime asset assembled from independently accepted GLB fragments. |
| `ConceptFirstAssetProductionGate` | Concept/worker/assembler boundary | Pins the immutable intent, art direction, concept reference, worker brief, asset revision, and assembly decision for one type-neutral production candidate. |

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
- Every published v2 work order carries a dispatch gate: full immutable
  `EncounterIntent`, `ArtDirectionRevision`, and `ConceptReferenceRevision`
  lineage, or a scoped, time-bounded reuse/maintenance waiver. The dispatcher
  validates it before launch and preserves it in its worker receipt.
- The D0 local path uses a distinct explicit bootstrap waiver marked
  `not_concept_compliant`; it preserves compatibility without claiming that
  bootstrap artifacts satisfy concept-first production.
- `ConceptFirstAssetProductionGate` records source and runtime acceptance
  separately, and it makes selection, rejection, deviation, and fallback
  decisions inspectable before a package is chosen. Catalog/assembler selection
  enforcement remains a later slice.

These schemas intentionally do not standardize the internal Unity command API,
artifact file formats, scoring algorithm, or coordinator persistence layout.
Those interfaces remain ambiguous until their implementation spikes establish
what the target player and generation services can actually support.

The v2 artifact lane standardizes only the safe discovery seam. A host declares
`artifact_formats`; each accepted runtime artifact pins its HTTPS URI, SHA-256,
byte length, media type, and allowed platform/build/loader tuples. Selection
requires an exact tuple match and a signed manifest. `model/gltf-binary`
continues to use the unchanged v1 lane; Unity AssetBundles use
`application/vnd.unity.assetbundle` only when explicitly declared by a v2 host.
