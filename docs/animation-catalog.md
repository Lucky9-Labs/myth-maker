# Animation catalog and worker proof

`AnimationCatalog` selects one accepted immutable manifest revision for a rig,
model binding, scale profile, and optional locomotion/attack/reaction tags. It
uses the shared catalog's published
`findCompatibleParts({ host, functionalTags, aestheticTags, rigBindingId })`
planner port when supplied; otherwise `InMemoryAnimationCatalogAdapter` is the
isolated initial store. Shared queries include `scale.<profile>` as a
functional tag, then locally verify the exact model binding.

An animation manifest has a stable `animation_id`, positive immutable
`revision`, `preloaded_clip` or `procedural_recipe` kind, rig/model binding,
duration, tag groups, scale profiles, provenance, and acceptance state. Queries
consider the newest accepted revision of each ID, so a later candidate or
rejected revision cannot displace a working baseline. Selection is
deterministic: compatible entries sort by quality score, revision, then ID. If
none match, the caller can request a known compatible fallback ID.

A `preloaded_clip` manifest's `clip.clip_id` is its required host clip name
(and stable clip identifier); `clip.preload_key` identifies the preloaded
runtime resource. Procedural manifests carry their executable recipe instead.

`emitAnimationCandidate` accepts a v1 work order plus query, binding, provides,
and fallback inputs, emitting ordered v1 `WorkerEvent` receipts and an
`EncounterModule` recipe for arbitrary encounter content. Its module bindings
are checked by the existing assembler against host loaders. The
`emitSmallOceanFixture` wrapper is only synthetic bootstrap data—not an asset
import, retargeting pipeline, or proof of an external export or host acceptance.
