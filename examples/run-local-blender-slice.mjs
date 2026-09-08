import { once } from "node:events";
import { createBuildRoomServer } from "../src/build-room-server.js";

const port = Number(process.env.MYTH_MAKER_PORT || 4182);
const server = createBuildRoomServer();
server.listen(port, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${port}`;
try {
  const response = await fetch(`${base}/api/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "Build one inspectable generic body candidate.",
      generate_asset: true,
      idempotency_key: "local-blender-demo-v1",
    }),
  });
  if (!response.ok) throw new Error(`Build Room intake failed: ${await response.text()}`);
  const submitted = await response.json();
  const finished = await waitForPackage(`${base}/api/encounters/${submitted.ids.encounterId}`);
  const artifact = finished.artifacts.at(0);
  const blenderEvent = finished.events.find((event) => event.kind === "candidate_produced" && event.evidence.kind === "local_blender_cli");
  console.log(JSON.stringify({
    evidence_scope: "local_blender_cli_only",
    build_room_url: `${base}/?build=${encodeURIComponent(submitted.ids.requestId)}`,
    request_id: submitted.ids.requestId,
    encounter_id: submitted.ids.encounterId,
    deterministic_seed: submitted.seed,
    catalog_asset_id: artifact?.artifact_id,
    source_sha256: artifact?.source_sha256,
    runtime_sha256: artifact?.runtime_sha256,
    thumbnail_url: artifact?.thumbnail_url ? `${base}${artifact.thumbnail_url}` : undefined,
    package: finished.packages.at(0),
    worker_receipt: blenderEvent?.evidence.receipt,
  }, null, 2));
} finally {
  server.close();
}

async function waitForPackage(url) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await fetch(url);
    const detail = await response.json();
    if (detail.packages.length) return detail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local Blender slice timed out before assembly.");
}
