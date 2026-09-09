# Railway immutable runtime-artifact publication

The Railway dispatcher hosts the public byte plane. Its mounted volume is the
only artifact store: the catalog remains metadata and receipt storage.

`POST /v1/artifact-publications` remains the closed GLB compatibility lane. It
requires `Authorization: Bearer
<ARTIFACT_PUBLICATION_TOKEN>` and an accepted generic `glb.v1` candidate. The
request carries its stable publication ID, idempotency key, checked runtime
module and loader profile, and the exact accepted GLB bytes as base64.

The service verifies the existing `glb.v1` acceptance, SHA-256, and byte length
before it writes `sha256/<digest>.glb` with a no-overwrite flag. It derives the
returned URL only from `PUBLIC_ARTIFACT_ORIGIN`; neither a fixture URL nor the
local Blender/bootstrap candidate is represented as cloud-created. A repeated
publication ID must carry an identical request hash or receives `409`.

`GET /v1/artifacts/<sha256>` is intentionally unauthenticated and returns only
the content-addressed file with `model/gltf-binary`, `Content-Length`, a digest
header, and immutable cache policy. It returns 404 for absent, corrupt, or
non-GLB addresses.

## V2 generic runtime artifacts

`POST /v2/artifact-publications` is additive. It never calls the GLB ingress,
converts an upload, infers a MIME type, or changes its bytes. The publication
request must contain:

- a stable `publication_id` and idempotency key;
- `runtime_artifact`, including its module/revision, `sha256`, exact
  `byte_length`, hash-addressed source URI, caller-declared allowlisted media
  type, and v2 `platforms`/`builds`/`loaders` compatibility;
- a concrete `host_compatibility` tuple: `platform`, `engine_build`,
  `scripting_backend`, and `loader`;
- an opaque lowercase alphanumeric `extension` (one to sixteen characters);
  and
- the exact base64 byte sequence.

The target’s platform, engine build, and loader must occur in the artifact
compatibility declaration. This binds the returned v2 receipt to the same
selection tuple used by the v2 catalog/discovery lane; the scripting backend is
preserved explicitly so Unity hosts can reject an incompatible bundle before
load. The receipt’s `artifact` has the exact v2 discovery-artifact shape,
including module and revision, so it can be compared directly to catalog and
assembly evidence without format substitution.

Railway stores bytes at `runtime/sha256/<sha256>.<extension>` and serves them
only at `GET /v2/artifacts/<sha256>.<extension>`. The content type is the
receipt’s declared allowlisted type, while `Content-Length` and `Digest` are
derived from the stored bytes. Extensions are opaque routing tokens, never
filesystem paths. A digest, media-type, metadata, path, or publication-ID
collision fails closed; an existing publication is replayed only if its full
canonical request hash matches.

The default allowlist is `model/gltf-binary` and
`application/vnd.unity.assetbundle`. A deployment may set
`RUNTIME_ARTIFACT_MEDIA_TYPES` to a non-empty comma-separated allowlist. This
is a deployment policy, not a promise that every configured type can be loaded
by every host; a host still needs a matching v2 catalog representation and
declared loader tuple.

`POST /v2/encounter-artifact-publications` is the catalog-admission path. It
accepts the v2 publication plus an accepted v2 catalog revision, frozen package,
v2 assembly receipt, host capabilities, and discovery request. It rejects the
bundle unless `compatibleFrozenPackage` accepts the complete host tuple and the
exact published module/revision/artifact is selected in both catalog and
assembly evidence; only then does it persist receipts and ask the coordinator
to freeze and discover. A standalone v2 publication is therefore stored bytes,
not a claim of catalog admission.

The protected service stores source-of-truth evidence at:

- `POST /v1/artifact-receipts/catalog`
- `POST /v1/artifact-receipts/package`
- `POST /v1/artifact-receipts/assembly`

Catalog and assembly payloads use their existing v1 acceptance validators;
package receipts need a canonical matching `manifest_sha256`. All are
append-only JSON records on the mounted volume.

`POST /v1/encounter-artifact-publications` is the required assembled path. It
accepts the publication request plus the accepted catalog revision, selected
package, assembly receipt, host capabilities, and discovery request as one
bundle. It refuses a bundle unless the same published artifact is selected by
both the catalog and assembly receipt and the package is compatible. It stores
all three receipts before forwarding catalog admission, package freeze, and
discovery to the coordinator. The coordinator—not Railway—owns the existing
fixed-key canonical Ed25519 discovery signature.

## Railway configuration

Mount a persistent volume and configure paths within it, such as
`/data/receipts.json` and `/data/artifacts`. Set these deployment-scoped
variables before restarting Railway:

- `RECEIPT_STORE_PATH` — existing dispatcher receipt file.
- `ARTIFACT_STORE_PATH` — artifact and immutable receipt directory.
- `PUBLIC_ARTIFACT_ORIGIN` — Railway's actual HTTPS origin, without a path.
- `ARTIFACT_PUBLICATION_TOKEN` — write-side secret, distinct from public GET.
- `RUNTIME_ARTIFACT_MEDIA_TYPES` — optional non-empty comma-separated v2 media
  type allowlist; omission uses the safe default described above.

No provider URL is committed as a claim. An absent mounted volume, token, or
actual HTTPS origin is a deployment blocker, not a reason to substitute local
evidence.

## Independent public verification

After deployment and publication, verify the returned receipt through a new
HTTPS request—not the upload body:

```sh
node scripts/verify-published-artifact.mjs \
  --url=https://actual-railway-origin/v1/artifacts/<sha256> \
  --sha256=<sha256> \
  --byte-length=<bytes> \
  --media-type=model/gltf-binary
```

For v2, use the receipt values unchanged (including the caller-declared media
type) and capture the returned JSON with the Railway deployment receipt:

```sh
node scripts/verify-published-artifact.mjs \
  --url=https://actual-railway-origin/v2/artifacts/<sha256>.<extension> \
  --sha256=<sha256> \
  --byte-length=<bytes> \
  --media-type=application/vnd.unity.assetbundle
```

The JSON output proves that download's hash, byte length, media type, and
status. It does not claim that a bundle was built, loaded, or rendered in
Railway; retain the Unity build/load receipt separately. A deployed publication
is not proven until this independent HTTPS re-fetch receipt and the Railway
deployment receipt identify the deployed source revision.

Verify the coordinator response separately with its public signing key:

```sh
node scripts/verify-signed-discovery-manifest.mjs --manifest-file=selected-manifest.json
```

The verifier fixes the known public key ID to `package-discovery-ed25519-v1`.
