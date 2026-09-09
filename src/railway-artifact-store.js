import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { artifactRelativePath, prepareAcceptedArtifactPublication, validPublicationReceipt } from "./artifact-publication.js";
import { acceptedAssemblyReceipt, acceptedCatalogRevision, canonicalSha256, compatibleFrozenPackage } from "./package-discovery.js";

const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_KINDS = new Set(["catalog", "package", "assembly"]);

/** A mounted-volume adapter: immutable bytes and their receipts survive restarts. */
export function createRailwayArtifactStore({ rootPath, publicOrigin, clock = () => new Date().toISOString() } = {}) {
  const root = resolveRequiredPath(rootPath, "rootPath");
  const origin = requireHttpsOrigin(publicOrigin);
  return {
    async publish(value) {
      const prepared = await prepareAcceptedArtifactPublication({ value, publicOrigin: origin, publishedAt: clock() });
      if (!prepared) return { status: 400, value: { error: "invalid_accepted_artifact_publication" } };
      const receiptPath = within(root, `receipts/publications/${prepared.receipt.publication_id}.json`);
      const prior = await readJson(receiptPath);
      if (prior) {
        const receipt = await validPublicationReceipt(prior);
        if (!receipt) return { status: 500, value: { error: "corrupt_artifact_publication_receipt" } };
        return receipt.publication_request_sha256 === prepared.receipt.publication_request_sha256
          ? { status: 200, value: receipt }
          : { status: 409, value: { error: "publication_id_reused_with_different_request" } };
      }
      const artifactPath = within(root, artifactRelativePath(prepared.receipt.artifact.sha256));
      const write = await writeImmutable(artifactPath, prepared.bytes, prepared.receipt.artifact.sha256);
      if (!write) return { status: 409, value: { error: "artifact_digest_collision" } };
      const stored = await writeJsonImmutable(receiptPath, prepared.receipt);
      if (!stored) {
        const replay = await readJson(receiptPath);
        const receipt = await validPublicationReceipt(replay);
        return receipt?.publication_request_sha256 === prepared.receipt.publication_request_sha256
          ? { status: 200, value: receipt }
          : { status: 409, value: { error: "publication_id_reused_with_different_request" } };
      }
      return { status: 201, value: prepared.receipt };
    },

    async readArtifact(digest) {
      if (!SHA256.test(digest || "")) return null;
      try {
        const bytes = await readFile(within(root, artifactRelativePath(digest)));
        return bytes.byteLength && sha256(bytes) === digest ? bytes : null;
      } catch { return null; }
    },

    async recordReceipt(kind, payload) {
      if (!RECEIPT_KINDS.has(kind)) return { status: 404, value: { error: "receipt_kind_not_found" } };
      const accepted = await validateReceipt(kind, payload);
      if (!accepted) return { status: 400, value: { error: "invalid_immutable_receipt" } };
      const id = receiptId(kind, accepted);
      const path = within(root, `receipts/${kind}/${id}.json`);
      const stored = await writeJsonImmutable(path, accepted);
      if (stored) return { status: 201, value: accepted };
      const prior = await readJson(path);
      return canonicalReceiptEquals(prior, accepted)
        ? { status: 200, value: prior }
        : { status: 409, value: { error: "receipt_id_reused_with_different_payload" } };
    },

    async publishBundle(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "assembly_receipt,catalog_revision,discovery_request,host_capabilities,package,publication,schema_version"
        || value.schema_version !== "1") return { status: 400, value: { error: "invalid_artifact_publication_bundle" } };
      const published = await this.publish(value.publication);
      if (published.status >= 400) return published;
      const catalog = await acceptedCatalogRevision(value.catalog_revision);
      const assembly = await acceptedAssemblyReceipt(value.assembly_receipt);
      const packageReceipt = await validateReceipt("package", value.package);
      if (!catalog || !assembly || !packageReceipt
        || !(await compatibleFrozenPackage({ packageRecord: value.package, catalogRevision: catalog, assemblyReceipt: assembly, hostCapabilities: value.host_capabilities }))) {
        return { status: 400, value: { error: "publication_bundle_receipt_mismatch" } };
      }
      const artifact = published.value.artifact;
      if (!catalog.modules.some((module) => sameArtifact(module.artifact, artifact))
        || !assembly.selected_modules.some((module) => sameArtifact(module.artifact, artifact))) {
        return { status: 409, value: { error: "publication_artifact_not_selected" } };
      }
      for (const [kind, payload] of [["catalog", catalog], ["package", packageReceipt], ["assembly", assembly]]) {
        const recorded = await this.recordReceipt(kind, payload);
        if (recorded.status >= 400) return recorded;
      }
      return { status: published.status, value: { schema_version: "1", publication: published.value, catalog_revision: catalog, package: packageReceipt, assembly_receipt: assembly, discovery_request: structuredClone(value.discovery_request) } };
    },
  };
}

export function createRailwayArtifactHandler({ store, publicationToken, coordinator } = {}) {
  if (!store || typeof store.publish !== "function" || typeof store.publishBundle !== "function" || typeof store.readArtifact !== "function" || typeof store.recordReceipt !== "function") throw new TypeError("artifact handler needs an artifact store");
  if (!publicationToken || typeof publicationToken !== "string") throw new TypeError("artifact handler needs a publication token");
  return async function handle(request) {
    const url = new URL(request.url);
    const artifact = url.pathname.match(/^\/v1\/artifacts\/([a-f0-9]{64})$/);
    if (artifact && request.method === "GET") {
      const bytes = await store.readArtifact(artifact[1]);
      return bytes ? binaryResponse(bytes, artifact[1]) : jsonResponse({ error: "artifact_not_found" }, 404);
    }
    if (request.headers.get("authorization") !== `Bearer ${publicationToken}`) return jsonResponse({ error: "unauthorized" }, 401);
    if (request.method === "POST" && url.pathname === "/v1/artifact-publications") {
      return resultResponse(await store.publish(await jsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/encounter-artifact-publications") {
      if (!coordinator || typeof coordinator.freezeAndDiscover !== "function") return jsonResponse({ error: "coordinator_publication_unavailable" }, 503);
      const bundle = await store.publishBundle(await jsonBody(request));
      if (bundle.status >= 400) return resultResponse(bundle);
      try {
        const discovery = await coordinator.freezeAndDiscover(bundle.value);
        return jsonResponse({ ...bundle.value, discovery }, bundle.status);
      } catch { return jsonResponse({ error: "coordinator_package_discovery_failed" }, 502); }
    }
    const receipt = url.pathname.match(/^\/v1\/artifact-receipts\/(catalog|package|assembly)$/);
    if (receipt && request.method === "POST") return resultResponse(await store.recordReceipt(receipt[1], await jsonBody(request)));
    return jsonResponse({ error: "not_found" }, 404);
  };
}

export function createCoordinatorArtifactPublicationClient({ coordinatorUrl, ingressToken, catalogAcceptanceToken, fetcher = fetch } = {}) {
  if (!coordinatorUrl || !ingressToken || !catalogAcceptanceToken) throw new TypeError("coordinatorUrl, ingressToken, and catalogAcceptanceToken are required");
  const base = coordinatorUrl.replace(/\/$/, "");
  return {
    async freezeAndDiscover(bundle) {
      const encounterId = bundle.catalog_revision.encounter_id;
      const headers = { authorization: `Bearer ${ingressToken}`, "content-type": "application/json" };
      await expectOk(await fetcher(`${base}/v1/encounters/${encounterId}/catalog-revisions`, {
        method: "POST", headers: { ...headers, "x-catalog-acceptance-token": catalogAcceptanceToken }, body: JSON.stringify({ catalog_revision: bundle.catalog_revision }),
      }));
      await expectOk(await fetcher(`${base}/v1/encounters/${encounterId}/freeze`, {
        method: "POST", headers, body: JSON.stringify({ package: bundle.package, catalog_revision_id: bundle.catalog_revision.catalog_revision_id, assembly_receipt: bundle.assembly_receipt, host_capabilities: bundle.discovery_request.host_capabilities }),
      }));
      return expectOk(await fetcher(`${base}/v1/encounters/${encounterId}/package-discoveries`, { method: "POST", headers, body: JSON.stringify(bundle.discovery_request) }));
    },
  };
}

async function validateReceipt(kind, payload) {
  if (kind === "catalog") return acceptedCatalogRevision(payload);
  if (kind === "assembly") return acceptedAssemblyReceipt(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !SHA256.test(payload.manifest_sha256 || "")
    || typeof payload.package_id !== "string" || typeof payload.encounter_id !== "string" || !Number.isInteger(payload.revision)) return null;
  const unsigned = structuredClone(payload);
  delete unsigned.manifest_sha256;
  return payload.manifest_sha256 === await canonicalSha256(unsigned) ? structuredClone(payload) : null;
}

function receiptId(kind, value) {
  if (kind === "catalog") return value.catalog_revision_id;
  if (kind === "assembly") return value.receipt_id;
  return `${value.package_id}-${value.revision}-${value.manifest_sha256}`;
}

async function writeImmutable(path, bytes, expectedDigest) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: "wx" }); return true; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try { const existing = await readFile(path); return existing.byteLength === bytes.byteLength && sha256(existing) === expectedDigest; } catch { return false; }
  }
}

async function writeJsonImmutable(path, value) {
  if (await readJson(path)) return false;
  const bytes = Buffer.from(JSON.stringify(value));
  return writeImmutable(path, bytes, sha256(bytes));
}
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
function canonicalReceiptEquals(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sameArtifact(left, right) { return left?.uri === right?.uri && left?.sha256 === right?.sha256 && left?.media_type === right?.media_type && left?.byte_length === right?.byte_length; }
async function expectOk(response) { if (!response?.ok) throw new Error("coordinator request failed"); return response.json(); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function resolveRequiredPath(value, name) { if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`); return resolve(value); }
function requireHttpsOrigin(value) { const url = new URL(value); if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new TypeError("publicOrigin must be an HTTPS origin"); return url.href; }
function within(root, relative) { const path = resolve(root, relative); if (!path.startsWith(`${root}/`)) throw new TypeError("artifact path escapes mounted volume"); return path; }
async function jsonBody(request) { try { return await request.json(); } catch { return null; } }
function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function resultResponse(result) { return jsonResponse(result.value, result.status); }
function binaryResponse(bytes, digest) { return new Response(bytes, { headers: { "content-type": "model/gltf-binary", "content-length": String(bytes.byteLength), "digest": `sha-256=${digest}`, "cache-control": "public, immutable, max-age=31536000", "x-content-type-options": "nosniff" } }); }
