# V0 generic catalog persistence

`Catalog` is one persistence boundary with three **logical** domains, not three
databases: semantic entities, source/runtime assets, and animations. The local
adapter in `src/catalog-sqlite.js` applies `db/migrations/001_catalog_v0.sql` to
SQLite and exposes planner-oriented reads such as `findCompatibleParts()` rather
than raw SQL. A Railway/Postgres adapter can apply the same portable `TEXT` /
`INTEGER` schema and implement that port without changing callers.

Each domain is append-only by stable ID and revision. `contentSha256` is computed
from canonical record content, while `provenance` carries a producer, creation
time, and optional cross-domain parent refs (stable ID, revision, and hash).
Entity revisions carry affordances and
relationship edges. Asset revisions keep a `sourceReceipt` distinct from the
host-loadable `runtimeArtifact`, plus independent `sourceAcceptanceState` and
`runtimeAcceptanceState`. Animation revisions add `kind` (`clip` or `recipe`),
duration, rig/model binding, tags, compatibility, and the same acceptance split.
Every append must name the exact immediately prior revision in `parentRefs`.

An asset with `runtimeAcceptanceState: "candidate"` or `"rejected"` may have
only a source receipt; `"accepted"` requires a host-loadable runtime artifact.
The planner returns the newest compatible accepted revision per stable ID, so a
candidate or rejected conversion cannot hide the last usable revision. It never
selects source-only assets. Animation clips follow the same accepted-artifact
rule. A procedural animation recipe may omit both source receipt and runtime
artifact: its accepted executable form is the recipe itself, not a fabricated
file.

`encounter_evidence_projection` is deliberately **not** a fourth catalog. It is
an operational append-only projection for observed encounter state/evidence;
its rows are linked to an encounter and preserve a canonical payload hash.

## Runnable proof

```sh
npm test
npm run example:catalog
```

The ocean encounter fixture is entirely synthetic. Its `synthetic://` receipts
and artifacts demonstrate metadata, revision, query, and evidence behavior;
they are not Mech-project exports and do not prove a Unity import or host load.
The fixture's `runtimeAcceptanceState: "accepted"` means accepted by this V0
catalog fixture only, not player-facing host validation.
