# Railway immutable artifact publication v1

The Railway dispatcher hosts the public byte plane. Its mounted volume is the
only artifact store: the catalog remains metadata and receipt storage.

`POST /v1/artifact-publications` requires `Authorization: Bearer
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

The protected service stores source-of-truth evidence at:

- `POST /v1/artifact-receipts/catalog`
- `POST /v1/artifact-receipts/package`
- `POST /v1/artifact-receipts/assembly`

Catalog and assembly payloads use their existing v1 acceptance validators;
package receipts need a canonical matching `manifest_sha256`. All are
append-only JSON records on the mounted volume.

## Railway configuration

Mount a persistent volume and configure paths within it, such as
`/data/receipts.json` and `/data/artifacts`. Set these deployment-scoped
variables before restarting Railway:

- `RECEIPT_STORE_PATH` — existing dispatcher receipt file.
- `ARTIFACT_STORE_PATH` — artifact and immutable receipt directory.
- `PUBLIC_ARTIFACT_ORIGIN` — Railway's actual HTTPS origin, without a path.
- `ARTIFACT_PUBLICATION_TOKEN` — write-side secret, distinct from public GET.

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

The JSON output proves that download's hash, byte length, media type, and
status. It does not claim that Blender ran in Railway or Unity loaded the asset.
