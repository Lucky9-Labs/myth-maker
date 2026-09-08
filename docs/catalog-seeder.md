# Catalog seeder and importer

`CatalogSeedManifest` is the narrow bootstrap boundary for a host game's
already-selected assets. It is intentionally generic: it names no creature,
game, renderer, or behavior. The manifest declares a deterministic stable key,
revision, source locator and hash, ownership/license notes, source and runtime
format state, host/rig/skeleton/animation compatibility, and an evidence tier.

The importer derives an opaque stable catalog ID from `domain + stable_key`.
That ID is deterministic but does not expose the source path. The first import
creates revision 1; each later manifest must name the next `catalog_revision`.
The SQLite port preserves every earlier revision and requires an exact parent
hash before appending. Re-importing the exact same manifest is idempotent.

The evidence tiers are deliberately ordered:

- `source_declared`: metadata and a source hash were declared; no bytes were
  supplied to the importer.
- `source_observed`: bytes were supplied explicitly and matched the source hash.
- `accepted_runtime`: matched runtime bytes and a host acceptance receipt were
  supplied.
- `player_proven`: the accepted-runtime inputs plus an explicit player evidence
  receipt were supplied. The importer records a supplied receipt; it never
  creates one.

`candidate`, `rejected`, and `not_started` runtime states are not host-accepted
and are never player proof. The build room exposes a metadata-only inventory
row with `thumbnail_state: not_provided`; it never invents a thumbnail.

## Explicit-input CLI

The importer never walks a source checkout. It reads only the manifest path and
each `--file locator=path` argument supplied on the command line.

```sh
npm run catalog:import -- \
  --manifest tests/fixtures/catalog-seed-candidate.json \
  --file fixture://host/scout.mesh=/absolute/path/to/scout.mesh \
  --check
```

Remove `--check` and add an explicit local SQLite path to persist:

```sh
npm run catalog:import -- \
  --manifest /absolute/path/to/selected-manifest.json \
  --file host://selected/scout.glb=/absolute/path/to/scout.glb \
  --database /absolute/path/to/catalog.sqlite
```

No file is copied, exported, uploaded, converted, or accepted by this command.
Cloud provisioning is outside this seam.

## Human Chat gate before real ingestion

Ask these exact questions, then record the answers in the explicit manifest:

1. Which exact candidate assets/clips are selected, and which source paths or
   exports are authorized for this one import?
2. Is the selected source checkout clean, on the intended base/ref, and owned
   for this read? If not, where is the clean authoritative export?
3. For each candidate, what ownership/license/redistribution note applies?
4. What are the source format, intended runtime format, target host build,
   loaders/contracts, skeleton hash, bindings, and animation compatibility?
5. Which evidence exists now: declaration only, matched source bytes, host
   acceptance receipt, or an independently observed player receipt?
6. Should this run remain local-only, or has a specific cloud destination and
   provisioning owner been confirmed? (There is no upload path until then.)

Until those answers exist, use `--check` only or do not run the importer.
