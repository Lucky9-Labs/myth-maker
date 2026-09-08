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
      if (request.method === "GET" && url.pathname === "/favicon.ico") { response.writeHead(204); return response.end(); }
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
  :root { color-scheme: dark; font-family: Inter, Avenir Next, Avenir, ui-sans-serif, system-ui, sans-serif; background: #07101f; color: #e4f3f4; }
  * { box-sizing: border-box; } body { max-width: 1440px; min-height: 100vh; margin: 0 auto; padding: clamp(18px, 4vw, 54px); background: radial-gradient(circle at 52% 7%, #123d56 0, transparent 30rem), #07101f; }
  h1, h2, h3, p { margin-top: 0; } h1 { font-size: clamp(1.4rem, 3vw, 2.3rem); letter-spacing: -.04em; } h2 { font-size: 1.05rem; letter-spacing: -.02em; } .muted { color: #91a9b8; }
  .masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; margin-bottom: 28px; } .quiet { font-size: .82rem; color: #91a9b8; }
  .composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; padding: 16px; margin-bottom: 26px; border: 1px solid #22516b; background: rgba(7, 22, 39, .88); box-shadow: 0 18px 50px rgba(0, 0, 0, .22); }
  .composer label { display: block; font-size: .84rem; color: #b7d7df; } textarea { width: 100%; min-height: 56px; margin-top: 8px; resize: vertical; background: #07111d; color: inherit; border: 1px solid #35657a; padding: 11px; font: inherit; } textarea:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible { outline: 3px solid #8effec; outline-offset: 3px; }
  .form-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .form-actions label { color: #91a9b8; white-space: nowrap; } button { padding: 11px 16px; border: 1px solid #83e7dc; background: #a0fff2; color: #06202a; font: 700 .9rem/1 inherit; cursor: pointer; } button:hover { background: #cbfff8; }
  .assembly { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: clamp(10px, 2vw, 24px); align-items: stretch; padding: clamp(14px, 3vw, 34px); overflow: hidden; border: 1px solid #214e68; background: linear-gradient(120deg, rgba(12, 42, 62, .9), rgba(4, 15, 29, .95)); }
  .assembly::before { content: ""; position: absolute; inset: 50% 6% auto; border-top: 1px solid #3d7787; opacity: .6; } .slot { position: relative; min-height: 330px; display: flex; flex-direction: column; border: 1px solid #315e73; background: rgba(4, 17, 31, .78); } .slot + .slot::before { content: "→"; position: absolute; z-index: 1; left: -23px; top: 48%; color: #8cf7ed; font-size: 1.5rem; text-shadow: 0 0 14px #59e4dc; }
  .slot-head { display: flex; justify-content: space-between; gap: 10px; padding: 11px 12px; border-bottom: 1px solid #234d63; } .slot-head h2 { margin: 0; } .glyph { color: #9affef; } .state { font-size: .75rem; color: #a5ced2; } .frame { flex: 1; display: grid; place-items: center; overflow: hidden; min-height: 230px; background: radial-gradient(circle at 50% 43%, #0c5d78, #071321 68%); }
  .observed { border-color: #78e8e1; } .observed .slot-head { border-color: #53bfbf; } .active-frame { box-shadow: 0 0 0 1px #4cc8c6, 0 0 28px rgba(74, 221, 214, .42), inset 0 0 36px rgba(56, 202, 205, .12); } .active-frame .frame::after { content: ""; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 60px rgba(99, 255, 239, .17); } .observed img { width: 100%; height: 100%; min-height: 230px; object-fit: cover; display: block; }
  .ghost { border-style: dashed; border-color: #355265; background: rgba(7, 18, 31, .4); } .ghost .frame { color: #58717f; background: linear-gradient(135deg, rgba(19, 47, 64, .35), rgba(4, 13, 25, .5)); } .ghost-mark { font-size: 2rem; opacity: .5; } .slot-foot { min-height: 51px; padding: 10px 12px; color: #9fc7ce; font-size: .82rem; border-top: 1px solid #234d63; } .ghost .slot-foot { color: #647b88; }
  .assembly-caption { display: flex; justify-content: space-between; gap: 18px; padding: 13px 2px 0; color: #9bb8c4; font-size: .88rem; } .assembly-caption strong { color: #bdfcf3; }
  details.drawer { margin-top: 22px; border-top: 1px solid #31586c; border-bottom: 1px solid #31586c; background: rgba(3, 14, 27, .66); } summary { padding: 14px 4px; cursor: pointer; color: #c8f5f0; font-weight: 650; } .drawer-body { padding: 4px 4px 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 22px; } .drawer-body h3 { margin-bottom: 8px; color: #a1e9e3; } .drawer-body ul { margin: 0; padding-left: 18px; } .drawer-body li { margin: 6px 0; color: #acc2cc; } code { color: #a8fcf0; overflow-wrap: anywhere; font-size: .8rem; }
  .build-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; } .build-link { display: block; padding: 14px; border: 1px solid #315e73; color: inherit; text-decoration: none; background: rgba(4, 18, 32, .65); } .build-link:hover { border-color: #82eade; } .empty-note { padding: 30px 4px; color: #819aa7; }
  @media (max-width: 800px) { .composer { grid-template-columns: 1fr; } .assembly { grid-template-columns: 1fr; } .assembly::before, .slot + .slot::before { display: none; } .slot { min-height: 180px; } .frame, .observed img { min-height: 135px; } .assembly-caption, .masthead { align-items: flex-start; flex-direction: column; gap: 8px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
</style>
<body>
  <header class="masthead"><div><h1>Myth Maker / Build Room</h1><p class="muted">Compose a playable encounter from observed pieces.</p></div><span class="quiet">D0 assembly surface</span></header>
  <form id="submit" class="composer"><label for="prompt">What should this encounter do?<textarea id="prompt" required placeholder="Describe the encounter to assemble…"></textarea></label><div class="form-actions"><label><input id="generate-asset" type="checkbox" checked> Include local render</label><button>Assemble encounter</button></div></form>
  <main id="empty">Preparing assembly table…</main>
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
  function json(value) { return esc(JSON.stringify(value, null, 2)); }
  function statusGlyph(observed) { return observed ? "●" : "○"; }
  function observedBody(run) { return run.artifacts.find((artifact) => artifact.thumbnail_url); }
  function slot(title, observed, content, foot, active) {
    return "<article class=\"slot " + (observed ? "observed" : "ghost") + (active ? " active-frame" : "") + "\"><header class=\"slot-head\"><h2>" + esc(title) + "</h2><span class=\"glyph\" aria-label=\"" + (observed ? "observed" : "absent") + "\">" + statusGlyph(observed) + "</span></header><div class=\"frame\">" + content + "</div><footer class=\"slot-foot\">" + foot + "</footer></article>";
  }
  function ghostSlot(title, role) { return slot(title, false, "<span class=\"ghost-mark\" aria-hidden=\"true\">○</span>", "absent", false); }
  function assembly(run) {
    const body = run && observedBody(run);
    const packageRevision = run && run.packages.at(-1);
    const bodySlot = body ? slot("Body", true, "<img data-role=\"observed-thumbnail\" src=\"" + esc(body.thumbnail_url) + "\" alt=\"Observed local render for " + esc(body.artifact_id) + "\">", "local render · candidate", true) : ghostSlot("Body");
    const materialSlot = ghostSlot("Material");
    const arenaSlot = ghostSlot("Arena");
    const packageSlot = packageRevision ? slot("Encounter package", true, "<span class=\"glyph\" aria-hidden=\"true\">✦</span>", "assembled · revision " + esc(packageRevision.revision), !body) : ghostSlot("Encounter package");
    const caption = run ? "Observed pieces glow. Absent lanes stay quiet until evidence arrives." : "Start with a body, then add material, arena, and a package when each is observed.";
    return "<section aria-label=\"Encounter assembly table\"><div class=\"assembly\">" + bodySlot + materialSlot + arenaSlot + packageSlot + "</div><div class=\"assembly-caption\"><span><strong>Body → Material → Arena → Encounter package</strong></span><span>" + caption + "</span></div></section>";
  }
  function eventRows(events) { return events.map((entry) => "<li><strong>" + esc(entry.kind) + "</strong> · " + esc(labels[entry.evidence.kind] || "Unknown evidence source") + "<br>" + esc(entry.message) + "</li>").join(""); }
  function workRows(work) { return work.length ? "<ul>" + work.map((item) => "<li><code>" + esc(item.work_id) + "</code> · " + esc(item.lane) + " · " + esc(item.status) + "<br>worker <code>" + esc(item.worker_id) + "</code>; depends on " + (item.depends_on_work_ids.length ? item.depends_on_work_ids.map(esc).join(", ") : "request") + "</li>").join("") + "</ul>" : "<p class=\"muted\">No worker receipts yet.</p>"; }
  function artifactRows(rows, key) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row[key]) + "</code> · rev " + esc(row.revision) + "<br>" + json(row) + "</li>").join("") + "</ul>" : "<p class=\"muted\">None observed.</p>"; }
  function steerRows(rows) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row.steer_id) + "</code> · " + esc(row.status) + "</li>").join("") + "</ul>" : "<p class=\"muted\">No steering receipts.</p>"; }
  function catalogRows(catalog) { return "<ul>" + Object.entries(catalog).map(([name, row]) => "<li>" + esc(name.replaceAll("_", " ")) + ": " + esc(row.count) + " · " + esc(row.evidence) + "</li>").join("") + "</ul>"; }
  function details(run) {
    return "<details class=\"drawer\"><summary>Build details and evidence</summary><div class=\"drawer-body\"><section><h3>Identity</h3><ul><li>encounter <code>" + esc(run.ids.encounterId) + "</code></li><li>request <code>" + esc(run.ids.requestId) + "</code></li><li>correlation <code>" + esc(run.ids.workerId) + "</code></li></ul><h3>Workers and dependencies</h3>" + workRows(run.topology.work_graph) + "</section><section><h3>Artifacts, receipts, and hashes</h3>" + artifactRows(run.artifacts, "artifact_id") + "<h3>Package, fallback, and rejections</h3>" + artifactRows(run.packages, "package_id") + "</section><section><h3>Event log</h3><ul>" + eventRows(run.events) + "</ul><h3>Catalog counters</h3>" + catalogRows(run.topology.catalog) + "</section><section><h3>Steer this build</h3><form id=\"steer\"><label for=\"steer-instruction\">Instruction<textarea id=\"steer-instruction\" required placeholder=\"Optional steering instruction…\"></textarea></label><button>Queue steer</button></form>" + steerRows(run.steering) + "</section></div></details>";
  }
  function buildCard(build) { return "<a class=\"build-link\" href=\"" + esc(build.navigation_url) + "\"><strong>" + esc(build.terminal ? "Completed assembly" : "Active assembly") + "</strong><br><span class=\"quiet\">" + esc(build.encounter_id) + "</span></a>"; }
  function renderDashboard(index) {
    const builds = index.active.concat(index.recent_terminal);
    main.innerHTML = assembly() + (builds.length ? "<details class=\"drawer\"><summary>Open a recent assembly</summary><div class=\"build-list\">" + builds.map(buildCard).join("") + "</div></details>" : "<p class=\"empty-note\">No assemblies yet. A local render is optional and remains local evidence only.</p>");
  }
  async function submitSteer(event) { event.preventDefault(); const instruction = document.querySelector("#steer-instruction").value; const response = await fetch("/api/builds/" + encodeURIComponent(activeRequest) + "/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) }); if (!response.ok) alert((await response.json()).error); }
  function render(run) {
    main.innerHTML = assembly(run) + details(run);
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
