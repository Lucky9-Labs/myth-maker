import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { BuildRoom, CoordinatorEventAdapter } from "./build-room.js";
import { planEncounterWork } from "./workgraph-planner.js";
import { EncounterDispatcher } from "./encounter-dispatcher.js";
import { LocalWorkerBackend } from "./local-worker-backend.js";
import { LocalBlenderSliceBackend } from "./local-blender-slice-backend.js";
import { assembleEncounterPackage } from "./encounter-package-assembler.js";
import { createSqliteCatalog } from "./catalog-sqlite.js";
import { ingestGlbRuntimeCandidate } from "./glb-runtime-candidate-ingress.js";

export function createBuildRoomServer({ room = new BuildRoom(), persist = () => {}, catalog = createSqliteCatalog(), artifactRoot = ".local-blender-artifacts", blenderBackend = new LocalBlenderSliceBackend({ outputDir: artifactRoot }) } = {}) {
  if (!catalog || typeof catalog.projectionSummary !== "function") throw new TypeError("catalog must expose projectionSummary()");
  room.setCatalogProjection(() => catalog.projectionSummary());
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: (_input, request) => trustedObserver(request) });
  const absoluteArtifactRoot = existsSync(artifactRoot) ? realpathSync(artifactRoot) : resolve(artifactRoot);
  const streams = new Map();
  const buildStreams = new Set();
  room.subscribe((encounterId, snapshot) => {
    for (const response of streams.get(encounterId) || []) stream(response, snapshot);
    for (const response of buildStreams) stream(response, room.buildIndex());
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") return html(response);
      if (request.method === "GET" && url.pathname.startsWith("/generated/")) return generatedArtifact(response, absoluteArtifactRoot, url.pathname.slice("/generated/".length));
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { status: "ok", encounters: room.list().length });
      if (request.method === "GET" && url.pathname === "/api/builds") return json(response, 200, room.buildIndex());
      if (request.method === "GET" && url.pathname === "/api/builds/stream") {
        const projection = room.buildIndex();
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        buildStreams.add(response);
        stream(response, projection);
        request.on("close", () => buildStreams.delete(response));
        return;
      }
      const steerMatch = url.pathname.match(/^\/api\/builds\/([^/]+)\/steer$/);
      if (request.method === "POST" && steerMatch) {
        const receipt = room.steer(steerMatch[1], await body(request));
        persist(room);
        return json(response, 202, receipt);
      }
      const buildMatch = url.pathname.match(/^\/api\/builds\/([^/]+)$/);
      if (request.method === "GET" && buildMatch) return json(response, 200, room.buildDetail(buildMatch[1]));
      if (request.method === "POST" && url.pathname === "/api/ingest/steering") {
        const receipt = room.recordSteering(await body(request), { trusted: trustedObserver(request) });
        persist(room);
        return json(response, 201, receipt);
      }
      if (request.method === "POST" && url.pathname === "/api/encounters") {
        const run = room.submit(await body(request));
        persist(room);
        if (!run.deduplicated) launchLocalBuild(room, run, persist, catalog, blenderBackend, absoluteArtifactRoot).catch((error) => recordLocalFailure(room, run, error, persist));
        return json(response, run.deduplicated ? 200 : 201, run);
      }
      const streamMatch = url.pathname.match(/^\/api\/encounters\/([^/]+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        const encounterId = streamMatch[1];
        room.requireRun(encounterId);
        const projection = room.snapshot(encounterId);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const group = streams.get(encounterId) || new Set();
        group.add(response);
        streams.set(encounterId, group);
        stream(response, projection);
        request.on("close", () => { group.delete(response); if (group.size === 0) streams.delete(encounterId); });
        return;
      }
      const match = url.pathname.match(/^\/api\/encounters\/([^/]+)$/);
      if (request.method === "GET" && match) {
        const snapshot = room.snapshot(match[1]);
        const after = url.searchParams.get("after");
        return json(response, 200, { ...snapshot, events: room.replay(match[1], after || undefined) });
      }
      if (request.method === "POST" && ["/api/ingest/coordinator", "/api/ingest/dispatcher"].includes(url.pathname)) {
        const event = adapter.ingest(await body(request), request);
        persist(room);
        return json(response, 201, event);
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) return response.destroy();
      return json(response, error instanceof RangeError ? 404 : 400, { error: error.message });
    }
  });
  return server;
}

async function launchLocalBuild(room, run, persist, catalog, blenderBackend, artifactRoot) {
  const spec = localSpec(run.ids.encounterId, run.seed);
  const graph = planEncounterWork(spec);
  const localBackend = new LocalWorkerBackend({ workDurationMs: 5 });
  const backend = {
    launch(order, options) {
      return run.generate_asset && order.lane === "body-source" ? blenderBackend.launch(order, options) : localBackend.launch(order, options);
    },
  };
  const dispatcher = new EncounterDispatcher({ backend });
  let result;
  try {
    result = await dispatcher.dispatch(graph);
  } catch (error) {
    const rootOrders = graph.work_orders.filter((order) => !(order.depends_on_work_ids || []).length);
    const rootReceipts = await Promise.all(rootOrders.map((order) => dispatcher.lookup(order.work_id)));
    if (rootReceipts.some((receipt) => !receipt)) throw error;
    result = {
      encounter_id: graph.encounter_id,
      receipts: rootReceipts,
      events: rootReceipts.flatMap((receipt) => receipt.events),
      deduplicated_work_ids: [],
      recovered_with_baseline_fallback: true,
    };
  }
  const bodyOrder = graph.work_orders.find((order) => order.lane === "body-source");
  const manifest = run.generate_asset ? blenderBackend.resultFor(bodyOrder.work_id) : undefined;
  const candidate = manifest ? ingestGlbRuntimeCandidate({ module: manifest.module, loaderProfile: manifest.loader_profile }) : undefined;
  if (manifest) catalog.createAsset(catalogAsset(manifest));
  for (const order of graph.work_orders) {
    for (const event of result.events.filter((candidate) => candidate.work_id === order.work_id)) {
      const isBlender = order.lane === "body-source" && event.worker_id.startsWith("blender-cli-");
      const projected = room.record(run.ids.encounterId, {
        eventId: event.event_id, workerId: event.worker_id, sequence: event.sequence, occurredAt: event.occurred_at,
        kind: event.kind, message: event.message,
        ...(isBlender && manifest && event.kind === "candidate_produced" ? { artifact: artifactRevision(manifest, artifactUrl(artifactRoot, manifest.visual.path)) } : {}),
        evidence: isBlender
          ? manifest
            ? { kind: "local_blender_cli", receipt: { ...manifest.worker_receipt, work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at, source: manifest.source, runtime: manifest.runtime, visual: manifest.visual, manifest_path: manifest.manifest_path } }
            : { kind: "local_blender_cli_failed", receipt: { work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at, failure: event.message, note: "Local Blender CLI failed; assembler retained the baseline fallback." } }
          : { kind: "local_process", receipt: { work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at } },
      });
      room.upsertWork(run.ids.encounterId, order, projected);
    }
  }
  if (result.recovered_with_baseline_fallback) {
    const skipped = graph.work_orders.find((order) => order.lane === "validation");
    const projected = room.record(run.ids.encounterId, {
      workerId: "local-dispatcher", sequence: 0, kind: "cancelled", occurredAt: new Date().toISOString(),
      message: "Validation lane skipped because a prerequisite failed; assembler retained the declared baseline fallback.",
      evidence: { kind: "local_process", receipt: { process: "encounter-dispatcher", observed_at: new Date().toISOString() } },
    });
    room.upsertWork(run.ids.encounterId, skipped, projected);
  }
  const packageResult = assembleEncounterPackage({
    host: spec.host_capabilities,
    encounterId: run.ids.encounterId,
    packageId: `package-${run.ids.encounterId.slice(-24)}`,
    baselineModules: [baselineModule(run.ids.encounterId)],
    candidateModules: candidate ? [candidate.module] : [],
    assembledAt: new Date().toISOString(),
  });
  room.record(run.ids.encounterId, {
    workerId: "local-assembler", sequence: 0, kind: "completed", occurredAt: new Date().toISOString(),
    message: candidate ? "Local assembler produced a package selecting the checked local Blender runtime candidate; host-game acceptance remains absent." : "Local assembler preserved the compatible baseline fallback after terminal worker receipts.",
    package: {
      package_id: packageResult.package.package_id,
      revision: packageResult.package.revision,
      state: packageResult.package.state,
      selection: packageResult.package.module_ids,
      fallback: packageResult.package.fallback_provenance,
      rejections: packageResult.rejections,
      manifest_sha256: packageResult.package.manifest_sha256,
      assembly_receipt: assemblyReceipt(packageResult.package, manifest),
    },
    evidence: { kind: "local_process", receipt: { process: "encounter-package-assembler", observed_at: new Date().toISOString() } },
  });
  persist(room);
}

function assemblyReceipt(packageRecord, manifest) {
  const withoutHash = {
    schema_version: "1",
    receipt_id: `assembly-${packageRecord.package_id.slice(-40)}`,
    package_id: packageRecord.package_id,
    package_revision: packageRecord.revision,
    package_manifest_sha256: packageRecord.manifest_sha256,
    assembled_at: packageRecord.assembled_at,
    selected_modules: manifest ? [{
      module_id: manifest.module.module_id,
      revision: manifest.module.revision,
      artifact_sha256: manifest.runtime.sha256,
    }] : packageRecord.module_ids.map((module_id) => ({ module_id, revision: 1, artifact_sha256: null })),
    fallback_provenance: packageRecord.fallback_provenance,
    validation: manifest ? [{
      kind: "glb.v1-checked",
      status: "passed",
      artifact_sha256: manifest.runtime.sha256,
      evidence_scope: "local_blender_cli_only",
    }] : [{ kind: "baseline-contract", status: "passed", artifact_sha256: null, evidence_scope: "local_process_only" }],
    host_acceptance: "not_observed",
  };
  return { ...withoutHash, receipt_sha256: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
}

function catalogAsset(manifest) {
  return {
    assetId: manifest.asset_id, revision: 1, createdAt: manifest.created_at,
    functionalTags: ["body.generated"], aestheticTags: ["aesthetic.ocean.demo"],
    compatibility: { platforms: ["local"], loaders: ["gltf", "urp"], contracts: ["encounter-module.v1"], bindingIds: [] },
    sourceReceipt: { receiptId: `${manifest.work_id}-source-${manifest.source.artifact.sha256.slice(0, 16)}`, uri: manifest.source.artifact.uri, sha256: manifest.source.artifact.sha256, receivedAt: manifest.created_at },
    runtimeArtifact: { uri: manifest.runtime.uri, sha256: manifest.runtime.sha256, mediaType: manifest.runtime.media_type, byteLength: manifest.runtime.byte_length },
    sourceAcceptanceState: "accepted", runtimeAcceptanceState: "candidate",
    provenance: { producer: "local-blender-cli", createdAt: manifest.created_at, label: "newly-produced-local-blender" },
  };
}

function artifactRevision(manifest, thumbnailUrl) {
  return { artifact_id: manifest.asset_id, revision: 1, source_sha256: manifest.source.artifact.sha256,
    runtime_sha256: manifest.runtime.sha256, profile: manifest.loader_profile.profile, thumbnail_url: thumbnailUrl,
    origin: "newly-produced-local-blender", acceptance: "host-unaccepted-candidate" };
}

function artifactUrl(root, path) { return `/generated/${encodeURIComponent(relative(root, path).split(sep).join("/"))}`; }

function recordLocalFailure(room, run, error, persist) {
  room.record(run.ids.encounterId, { workerId: "local-dispatcher", sequence: 0, kind: "failed", occurredAt: new Date().toISOString(), message: `Local dispatcher failed: ${error.message}`, evidence: { kind: "local_process", receipt: { process: "encounter-dispatcher", observed_at: new Date().toISOString() } } });
  persist(room);
}

function localSpec(encounterId, seed = 1) {
  return { schema_version: "1", encounter_id: encounterId, seed, deadline_at: "2026-12-31T00:00:00Z", host_capabilities: { schema_version: "1", host_id: "local-build-room", host_build: "local-blender-v1", platform: "local", scripting_backend: "il2cpp", execution_kinds: ["recipe", "runtime_asset"], loaders: ["gltf", "urp"], contracts: ["encounter-module.v1"], limits: { memory_mb: 1024, preload_seconds: 30, artifact_bytes: 50000000 } }, objective: { kind: "survive", parameters: {} }, arena_envelope: { bounds: { width: 1, height: 1, depth: 1 }, navigation_profiles: ["ground"] }, desired_roles: ["pressure"] };
}

function baselineModule(encounterId) {
  return { schema_version: "1", module_id: `baseline-${encounterId.slice(-24)}`, revision: 1, execution_kind: "recipe", provides: ["encounter.body"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "known-playable-baseline" }, fallback_module_ids: [] };
}

function generatedArtifact(response, root, encodedRelativePath) {
  const relativePath = decodeURIComponent(encodedRelativePath);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path)) return json(response, 404, { error: "generated_artifact_not_found" });
  const type = path.endsWith(".png") ? "image/png" : path.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": "immutable" });
  response.end(readFileSync(path));
}

export function loadBuildRoom(statePath) {
  const room = new BuildRoom();
  if (!existsSync(statePath)) return room;
  return room.restore(JSON.parse(readFileSync(statePath, "utf8")));
}

export function persistBuildRoom(statePath, room) {
  const absolutePath = resolve(statePath);
  const temporaryPath = `${absolutePath}.next`;
  const state = JSON.stringify(room.exportState());
  writeFileSync(temporaryPath, state, "utf8");
  renameSync(temporaryPath, absolutePath);
}

function trustedObserver(request) {
  const token = process.env.BUILD_ROOM_OBSERVER_TOKEN;
  return Boolean(token) && request.headers.get("x-build-room-observer-token") === token;
}

function stream(response, snapshot) {
  if (response.destroyed || response.writableEnded) return;
  try {
    response.write(`event: projection\ndata: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    // A disconnected EventSource is not an API failure and must not take down the viewer.
  }
}

function body(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let received = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > 100_000) {
        if (!rejected) reject(new TypeError("request body too large"));
        rejected = true;
        request.resume();
        return;
      }
      if (!rejected) raw += chunk;
    });
    request.on("end", () => {
      if (rejected) return;
      try { resolve(JSON.parse(raw || "{}")); } catch { reject(new TypeError("invalid JSON")); }
    });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function html(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(PAGE.replace("<!-- client -->", CLIENT_SCRIPT));
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Myth Maker Build Room</title>
<style>
  :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #101318; color: #e9eef4; }
  body { max-width: 1160px; margin: 0 auto; padding: 28px; }
  h1 { margin: 0; } .muted { color: #a9b5c3; }
  .notice { border: 1px solid #e2ae54; background: #372815; padding: 12px; margin: 20px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
  .card { border: 1px solid #334050; background: #171d25; padding: 14px; border-radius: 6px; }
  .stage { border-left: 4px solid #52677d; padding: 9px; margin: 8px 0; } .stage.live, .observed-local { border-color: #4bd8a7; } .stage.fixture { border-color: #e2ae54; } .observed-modal { border-color: #ae7df4; } .observed-blender { border-color: #75bfff; } .absent { border-color: #52677d; }
  .topology { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 8px; align-items: stretch; } .node { border: 1px solid #52677d; padding: 8px; min-height: 80px; } .arrow { color: #91c8ff; text-align: center; font-size: 20px; } .lane { margin-top: 8px; border: 1px dashed #52677d; padding: 8px; }
  textarea { width: 100%; min-height: 80px; background: #0d1117; color: inherit; border: 1px solid #52677d; padding: 8px; box-sizing: border-box; }
  button { margin-top: 8px; padding: 9px 13px; background: #4bd8a7; border: 0; color: #07130f; font-weight: bold; cursor: pointer; }
  .thumbnail { display: block; width: min(100%, 320px); margin-top: 8px; border: 1px solid #52677d; background: #0d1117; }
  code { color: #91c8ff; word-break: break-word; } table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { border-top: 1px solid #334050; padding: 8px; text-align: left; vertical-align: top; } .pill { display: inline-block; border: 1px solid #52677d; border-radius: 12px; padding: 2px 7px; font-size: 11px; }
  #empty { padding: 30px; text-align: center; border: 1px dashed #52677d; }
</style>
<body>
  <h1>Myth Maker <span class="muted">/ encounter build room</span></h1>
  <p class="muted">Local inspection surface. Submission runs the local planner and dispatcher. The optional demo bootstrap runs installed local Blender CLI; Cloudflare, Modal, Unity-load, and player proof remain absent.</p>
  <div class="notice"><strong>Evidence boundary:</strong> local HTTP and worker receipts are observed locally; catalog counters are direct local SQLite reads. Local Blender CLI visual receipts are not Modal, Unity-load, or player proof.</div>
  <form id="submit"><label for="prompt">Encounter request</label><textarea id="prompt" required placeholder="Describe the encounter to inspect…"></textarea><label><input id="generate-asset" type="checkbox" checked> Generate one local Blender demo asset (ocean-inspired bootstrap only)</label><br><button>Create local build-room request</button></form>
  <main id="empty">Submit an encounter request to generate its encounter, request, and worker IDs.</main>
  <script><!-- client --></script>
</body>
</html>`;

const CLIENT_SCRIPT = String.raw`
  const main = document.querySelector("main");
  let active;
  let activeRequest;
  const labels = {
    fixture: "Simulated fixture (not live)",
    local_process: "Local process receipt (observed)",
    local_blender_cli: "Local Blender CLI evidence (observed)",
    local_blender_cli_failed: "Local Blender CLI failure (observed local process)",
    adapter_reported: "Coordinator/dispatcher report (unverified)",
    modal_remote: "Modal remote receipt (observed)",
    blender_window: "Blender window/screenshot/stream (observed)",
  };

  document.querySelector("#submit").addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = document.querySelector("#prompt").value;
    const response = await fetch("/api/encounters", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, generate_asset: document.querySelector("#generate-asset").checked }),
    });
    const run = await response.json();
    if (!response.ok) return alert(run.error);
    active = run.ids.encounterId;
    activeRequest = run.ids.requestId;
    history.pushState({}, "", "/?build=" + encodeURIComponent(run.ids.requestId));
    render(run);
    watch(active);
    document.querySelector("#prompt").value = "";
  });

  function esc(value) { const node = document.createElement("div"); node.textContent = String(value ?? ""); return node.innerHTML; }
  function revisionList(rows, key) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row[key]) + "</code> rev " + row.revision + (row.thumbnail_url ? "<br><img class=\"thumbnail\" src=\"" + esc(row.thumbnail_url) + "\" alt=\"Observed local Blender thumbnail for " + esc(row[key]) + "\"><br><span class=\"muted\">" + esc(row.origin || "") + " · source " + esc(row.source_sha256 || "") + " · runtime " + esc(row.runtime_sha256 || "") + "</span>" : "") + "</li>").join("") + "</ul>" : "<p class=\"muted\">No observed revisions.</p>"; }
  function eventRows(events) { return events.map((entry) => "<tr><td>" + entry.sequence + "</td><td>" + esc(entry.kind) + "</td><td><span class=\"pill\">" + esc(labels[entry.evidence.kind] || "Unknown evidence source") + "</span></td><td>" + esc(entry.message) + "</td></tr>").join(""); }
  function workerLanes(run, elapsed) {
    const workItems = run.topology.work_graph;
    if (!workItems.length) return "<div class=\"lane absent\"><strong>No observed work items</strong><br>The local planner has not projected work yet.</div>";
    return workItems.map((work) => { const edges = work.depends_on_work_ids.length ? work.depends_on_work_ids.map((dependency) => dependency + " → " + work.work_id).join("; ") : "request → " + work.work_id; return "<div class=\"lane " + evidenceClass(work.evidence_kind) + "\"><strong>Planner → local dispatcher → " + esc(work.lane) + "</strong><br>work: <code>" + esc(work.work_id) + "</code><br>worker: <code>" + esc(work.worker_id) + "</code><br>status: " + esc(work.status) + " · " + work.elapsed_seconds + "s<br>dependency edges: " + esc(edges) + "<br>evidence: " + esc(labels[work.evidence_kind]) + "</div>"; }).join("");
  }
  function evidenceClass(kind) { return ({ local_process: "observed-local", local_blender_cli: "observed-blender", local_blender_cli_failed: "observed-local", fixture: "fixture", modal_remote: "observed-modal", blender_window: "observed-blender" })[kind] || "absent"; }
  function buildCard(build) { return "<li><a href=\"" + esc(build.navigation_url) + "\"><code>" + esc(build.request_id) + "</code></a><br>encounter: <code>" + esc(build.encounter_id) + "</code><br>" + esc(build.terminal ? "terminal" : "active") + " · workers: " + build.work_graph.workers.length + " · revisions: " + build.revisions.artifacts + "/" + build.revisions.packages + "</li>"; }
  function renderDashboard(index) { main.innerHTML = "<section class=\"card\"><h2>Live builds</h2><p class=\"muted\">Active builds are projected from current local state; terminal history is bounded to " + index.terminal_limit + ".</p><h3>Active</h3>" + (index.active.length ? "<ul>" + index.active.map(buildCard).join("") + "</ul>" : "<p class=\"muted\">No active builds.</p>") + "<h3>Recent terminal</h3>" + (index.recent_terminal.length ? "<ul>" + index.recent_terminal.map(buildCard).join("") + "</ul>" : "<p class=\"muted\">No terminal builds.</p>") + "</section>"; }
  function steerRows(rows) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row.steer_id) + "</code> — " + esc(row.status) + (row.status === "accepted" ? " (not applied)" : "") + (row.status === "committed" ? " (successor response committed)" : "") + "</li>").join("") + "</ul>" : "<p class=\"muted\">No steering receipts.</p>"; }
  function catalogEvidence(value) { return ({ local_sqlite_query: "local SQLite query", local_projection: "local build-room projection", not_connected: "integration absent" })[value] || value; }
  async function submitSteer(event) { event.preventDefault(); const instruction = document.querySelector("#steer-instruction").value; const response = await fetch("/api/builds/" + encodeURIComponent(activeRequest) + "/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) }); if (!response.ok) alert((await response.json()).error); }
  function render(run) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(run.submittedAt)) / 1000));
    const modal = run.evidence.modal.length ? "observed receipt" : "no observed remote receipt";
    const blender = run.events.some((event) => event.evidence.kind === "local_blender_cli") ? "local CLI visual receipt observed" : run.evidence.blender.length ? "observed visual evidence" : "no observed window, screenshot, or stream";
    const packageRevision = run.packages.length ? "revision observed" : "no observed package revision";
    const catalog = run.topology.catalog;
    main.innerHTML = "<p><a href=\"/\">← All builds</a></p><section class=\"grid\"><div class=\"card\"><h2>Identity</h2><p>Encounter<br><code>" + esc(run.ids.encounterId) + "</code></p><p>Request<br><code>" + esc(run.ids.requestId) + "</code></p><p>Worker correlation<br><code>" + esc(run.ids.workerId) + "</code></p><p>Timer <strong>" + elapsed + "s</strong></p></div><div class=\"card\"><h2>Evidence legend</h2><p class=\"observed-local\">Local — observed process receipt</p><p class=\"observed-modal\">Modal — only observed with trusted receipt</p><p class=\"observed-blender\">Blender — only observed with trusted visual receipt</p><p class=\"absent\">Gray — absent / unobserved</p></div></section><section class=\"card\"><h2>Observed work graph</h2><div class=\"topology\"><div class=\"node observed-local\">Request<br>↓<br>Local planner + dispatcher</div><div class=\"arrow\">→</div><div class=\"node absent\">Cloudflare EncounterCoordinator<br>absent / not contacted</div></div><div class=\"topology\">" + workerLanes(run, elapsed) + "</div></section><section class=\"grid\"><div class=\"card\"><h2>Catalog counters</h2><p>Semantic entities: " + catalog.semantic_entities.count + " (" + catalogEvidence(catalog.semantic_entities.evidence) + ")</p><p>Semantic revisions: " + catalog.semantic_entity_revisions.count + " (" + catalogEvidence(catalog.semantic_entity_revisions.evidence) + ")</p><p>Assets: " + catalog.assets.count + " (" + catalogEvidence(catalog.assets.evidence) + ")</p><p>Asset revisions: " + catalog.asset_revisions.count + " (" + catalogEvidence(catalog.asset_revisions.evidence) + ")</p><p>Animations: " + catalog.animations.count + " (" + catalogEvidence(catalog.animations.evidence) + ")</p><p>Animation revisions: " + catalog.animation_revisions.count + " (" + catalogEvidence(catalog.animation_revisions.evidence) + ")</p><p>Package revisions: " + catalog.package_revisions.count + " (" + catalogEvidence(catalog.package_revisions.evidence) + ")</p></div><div class=\"card\"><h2>Steer active build</h2><form id=\"steer\"><textarea id=\"steer-instruction\" required placeholder=\"Optional steering instruction…\"></textarea><button>Queue steer</button></form>" + steerRows(run.steering) + "</div><div class=\"card\"><h2>Pipeline / work graph</h2><div class=\"stage live\">Local intake — observed receipt</div><div class=\"stage live\">Local planner + dispatcher + worker backend — observed local worker receipts</div><div class=\"stage absent\">Cloudflare EncounterCoordinator — absent / not contacted</div><div class=\"stage absent\">Modal — " + modal + "</div><div class=\"stage absent\">Blender — " + blender + "</div><div class=\"stage absent\">Package — " + packageRevision + "</div></div></section><section class=\"card\"><h2>Ordered worker events</h2><table><thead><tr><th>Sequence (per worker)</th><th>Event</th><th>Evidence source</th><th>Message</th></tr></thead><tbody>" + eventRows(run.events) + "</tbody></table></section><section class=\"grid\"><div class=\"card\"><h2>Artifact revisions</h2>" + revisionList(run.artifacts, "artifact_id") + "</div><div class=\"card\"><h2>Package revisions</h2>" + revisionList(run.packages, "package_id") + "</div></section>";
    const localBlenderStage = [...main.querySelectorAll(".stage")].find((node) => node.textContent.startsWith("Blender —"));
    if (localBlenderStage && run.generate_asset) {
      localBlenderStage.className = "stage observed-blender";
      localBlenderStage.textContent = "Local Blender CLI — " + blender + "; not Modal, Unity-load, or player proof";
    }
    const packageStage = [...main.querySelectorAll(".stage")].find((node) => node.textContent.startsWith("Package —"));
    if (packageStage && run.packages.length) packageStage.className = "stage observed-local";
    document.querySelector("#steer").addEventListener("submit", submitSteer);
  }

  function watch(encounterId) { const source = new EventSource("/api/encounters/" + encodeURIComponent(encounterId) + "/stream"); source.addEventListener("projection", (event) => render(JSON.parse(event.data))); }
  function watchDashboard() { const source = new EventSource("/api/builds/stream"); source.addEventListener("projection", (event) => renderDashboard(JSON.parse(event.data))); }
  async function start() {
    const requestId = new URLSearchParams(location.search).get("build");
    if (requestId) { const response = await fetch("/api/builds/" + encodeURIComponent(requestId)); if (response.ok) { const run = await response.json(); active = run.ids.encounterId; activeRequest = run.ids.requestId; render(run); watch(active); return; } }
    const response = await fetch("/api/builds");
    renderDashboard(await response.json());
    watchDashboard();
  }
  start();
`;

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const port = Number(process.env.BUILD_ROOM_PORT || 4173);
  const statePath = process.env.BUILD_ROOM_STATE_PATH || ".build-room-state.json";
  const room = loadBuildRoom(statePath);
  createBuildRoomServer({ room, persist: (nextRoom) => persistBuildRoom(statePath, nextRoom) })
    .listen(port, "127.0.0.1", () => console.log(`Myth Maker build room: http://127.0.0.1:${port}`));
}
