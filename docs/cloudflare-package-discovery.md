# Cloudflare package discovery v1

`POST /v1/encounters/{encounter_id}/package-discoveries` is an authenticated,
per-encounter query for the newest compatible immutable package. The existing
`EncounterCoordinator` Durable Object serves it.

## Request and results

Send `Authorization: Bearer <AGENT_INGRESS_TOKEN>` and JSON:

```json
{
  "schema_version": "1",
  "request_id": "host-request-0001",
  "idempotency_key": "host-request-0001",
  "host_capabilities": {
    "schema_version": "1",
    "host_id": "unity-host",
    "host_build": "1.0.0",
    "platform": "windows",
    "scripting_backend": "il2cpp",
    "execution_kinds": ["runtime_asset"],
    "loaders": ["gltf", "urp"],
    "contracts": ["encounter.module.v1"],
    "limits": { "memory_mb": 1024, "preload_seconds": 30, "artifact_bytes": 52428800, "actors": 8 }
  }
}
```

`host_capabilities` is the complete existing v1 contract: platform, scripting
backend, execution kinds, loaders, contracts, and resource limits are all
required. The idempotency key is bound to a canonical SHA-256 of the whole
request. An identical retry returns its prior result; changed content returns
`409`.

The selected response is `{schema_version:"1",status:"selected",manifest}`.
Its versioned manifest contains `encounter_id`, `request_id`, `package_id`,
`package_revision`, `package_manifest_sha256`, `assembly_receipt_id`,
`assembly_receipt_sha256`, `catalog_revision_id`, `catalog_revision_sha256`,
`issued_at`, and sorted remote artifacts. Every artifact has `module_id`,
`revision`, HTTPS `uri`, lowercase `sha256`, `media_type`, and optional
`byte_length`. `signature` is `{algorithm:"Ed25519",
key_id:"package-discovery-ed25519-v1",value:<base64url>}`. The full closed
response shape is [`PackageDiscoveryManifest`](../contracts/v1/package-discovery-manifest.schema.json).

The signature input is canonical JSON for the manifest before `signature`:
object keys are lexicographically sorted and array order is retained. Cloudflare
holds only the base64 PKCS#8 `PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY`; the Unity
host must pin the matching base64 SPKI public key for
`package-discovery-ed25519-v1`. The public key is an explicit deployment
configuration handoff, not an endpoint response or repository secret.

No package is an explicit successful response, never a fallback:

```json
{
  "schema_version": "1",
  "status": "no_package",
  "encounter_id": "encounter-001",
  "request_id": "host-request-0001",
  "reason": "no_accepted_compatible_package"
}
```

Missing/invalid auth returns `401`; invalid request or immutable evidence
returns `400`; path/idempotency collisions return `409`; unavailable signing
key configuration returns `503`.

## Admission, compatibility, and freeze

`POST /v1/encounters/{encounter_id}/catalog-revisions` records only immutable
`state: "accepted"` catalog revisions. Each has a canonical `catalog_sha256`,
acceptance decision, explicit host requirements, and per-module remote artifact.
Reusing a revision ID with a different hash is rejected. This write route also
requires `x-catalog-acceptance-token: <CATALOG_ACCEPTANCE_TOKEN>` in addition
to ingress authentication; Unity discovery clients never receive that authority.

Freeze requires that catalog revision ID, a hash-valid accepted assembly receipt,
and complete host capabilities. The receipt pins package/catalog revisions,
each selected module revision and artifact, and a generic `glb.assembly.v1`
manifest. Every selected module must agree exactly across frozen package,
accepted catalog, receipt, and GLB manifest. Report-shaped objects, source-only
receipts, local Build Room evidence, fixtures, `sha256:` URIs, and SPRINTER
files cannot meet the contract.

A frozen snapshot cannot be replaced. The current Durable Object preserves one
frozen snapshot per encounter; its deterministic ordering rule for a future
append-only snapshot history is catalog revision descending, package revision
descending, then package ID ascending. Declared platform/backend/execution/
loader/contract requirements plus artifact-byte and actor scale limits must be
present and fit the supplied host.

## V2 runtime artifact negotiation

The same endpoint accepts `schema_version: "2"` requests from a v2 host. Its
closed host manifest adds `artifact_formats`, where each entry names the exact
`media_type`, `loader`, `platform`, and `build` the player can load. The v2
catalog and receipt publish one or more immutable runtime artifacts per module.
Every candidate carries an HTTPS URI, lowercase SHA-256, byte length, media
type, and its supported platform/build/loader tuples.

The coordinator selects a candidate only when all of the following match: the
module requirements, an advertised host format, the host's platform and build,
and the host byte limit. The selected v2 manifest preserves the candidate's
compatibility tuple and signs canonical JSON before `signature` with the same
Ed25519 key ID, `package-discovery-ed25519-v1`. A target/build or digest mismatch
produces `no_accepted_compatible_package`; it never substitutes another format.
`application/vnd.unity.assetbundle` is the Unity AssetBundle media type. GLB
hosts continue using the unchanged v1 `model/gltf-binary` request and manifest
contracts.
