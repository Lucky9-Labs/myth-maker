import { readFile } from "node:fs/promises";

import { canonicalJson } from "../src/package-discovery.js";

export const PACKAGE_DISCOVERY_KEY_ID = "package-discovery-ed25519-v1";
export const PACKAGE_DISCOVERY_PUBLIC_KEY_SPKI_BASE64 = "MCowBQYDK2VwAyEAt1H5uJR0eCDxb2C4uHf+vRovjT9UJtCr5VBVYit1rgM=";

/** Verify the coordinator-owned canonical Ed25519 package discovery signature. */
export async function verifySignedDiscoveryManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.signature?.algorithm !== "Ed25519" || manifest.signature?.key_id !== PACKAGE_DISCOVERY_KEY_ID || typeof manifest.signature.value !== "string") {
    throw new TypeError("manifest does not carry the package-discovery Ed25519 signature");
  }
  const unsigned = structuredClone(manifest);
  delete unsigned.signature;
  const key = await crypto.subtle.importKey("spki", Buffer.from(PACKAGE_DISCOVERY_PUBLIC_KEY_SPKI_BASE64, "base64"), { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(manifest.signature.value, "base64url"), new TextEncoder().encode(canonicalJson(unsigned)));
  if (!valid) throw new Error("package discovery signature verification failed");
  return Object.freeze({ schema_version: "1", verification: "ed25519_package_discovery_manifest", key_id: PACKAGE_DISCOVERY_KEY_ID, manifest_id: manifest.manifest_id, valid: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv.find((argument) => argument.startsWith("--manifest-file="))?.slice("--manifest-file=".length);
  try {
    if (!file) throw new TypeError("--manifest-file=<path> is required");
    process.stdout.write(`${JSON.stringify(await verifySignedDiscoveryManifest(JSON.parse(await readFile(file, "utf8"))))}\n`);
  } catch (error) {
    process.stderr.write(`verify-signed-discovery-manifest: ${error.message}\n`);
    process.exitCode = 1;
  }
}
