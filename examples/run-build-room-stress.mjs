import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBuildRoomServer } from "../src/build-room-server.js";

const outputPath = argument("--output");
const artifactRoot = await mkdtemp(path.join(tmpdir(), "myth-maker-build-room-stress-"));
const server = createBuildRoomServer({ artifactRoot });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const response = await fetch(`${base}/api/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "Kraken demo brief: sustain multi-directional pressure while keeping a tidal escape route readable.",
      generate_asset: true,
      compile_profile: "high_fanout",
      freeze_current_package: true,
      idempotency_key: "kraken-high-fanout-stress-v1",
    }),
  });
  if (!response.ok) throw new Error(`Build Room submission failed: ${response.status} ${(await response.text())}`);
  const submitted = await response.json();
  const snapshot = await waitFor(async () => {
    const result = await fetch(`${base}/api/encounters/${submitted.ids.encounterId}`);
    if (!result.ok) throw new Error(`Build Room projection failed: ${result.status}`);
    return result.json();
  }, (value) => value.work_graph.length === 13 && value.packages.at(-1)?.state === "frozen");
  const bundle = {
    schema_version: "1",
    receipt_kind: "build-room-high-fanout-local-stress",
    observed_at: new Date().toISOString(),
    evidence_scope: "local Node processes and local Build Room HTTP projection only",
    unverified: ["remote coordinator", "remote worker", "host-game acceptance", "player-facing runtime"],
    request: {
      prompt: snapshot.prompt,
      compile_profile: snapshot.compile_profile,
      freeze_current_package: snapshot.freeze_current_package,
    },
    summary: {
      worker_count: snapshot.work_graph.length,
      completed_worker_count: snapshot.work_graph.filter((work) => work.status === "completed").length,
      worker_ids: snapshot.work_graph.map((work) => work.worker_id).sort(),
      lanes: snapshot.work_graph.map((work) => ({ lane: work.lane, component: work.component, status: work.status })),
      catalog_counters: snapshot.topology.catalog,
      package: snapshot.packages.at(-1),
    },
    projection: snapshot,
  };
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
} finally {
  server.close();
  await once(server, "close");
  await rm(artifactRoot, { recursive: true, force: true });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return path.resolve(value);
}

async function waitFor(read, predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for high-fanout Build Room compile");
}
