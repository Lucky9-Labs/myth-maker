import { createHash } from "node:crypto";

/** Download through the public URL; never trust a publisher's local bytes. */
export async function verifyPublishedArtifact({ url, sha256, byteLength, mediaType = "model/gltf-binary", fetcher = fetch } = {}) {
  if (!/^https:\/\//.test(url || "") || !/^[a-f0-9]{64}$/.test(sha256 || "") || !Number.isInteger(byteLength) || byteLength < 0 || typeof mediaType !== "string" || !mediaType) {
    throw new TypeError("url, sha256, byteLength, and mediaType must identify one public artifact");
  }
  const response = await fetcher(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const observed = { url, status: response.status, media_type: response.headers.get("content-type"), byte_length: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (!response.ok || observed.media_type !== mediaType || observed.byte_length !== byteLength || observed.sha256 !== sha256) {
    throw new Error(`public artifact verification failed: ${JSON.stringify(observed)}`);
  }
  return Object.freeze({ schema_version: "1", verification: "independent_https_download", verified_at: new Date().toISOString(), ...observed });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const values = new Map(process.argv.slice(2).map((entry) => entry.split("=", 2)));
  try {
    const receipt = await verifyPublishedArtifact({ url: values.get("--url"), sha256: values.get("--sha256"), byteLength: Number(values.get("--byte-length")), mediaType: values.get("--media-type") || "model/gltf-binary" });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`verify-published-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
