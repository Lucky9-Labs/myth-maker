import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BuildRoom, CoordinatorEventAdapter } from "./build-room.js";
import { planEncounterWork } from "./workgraph-planner.js";
import { EncounterDispatcher } from "./encounter-dispatcher.js";
import { LocalWorkerBackend } from "./local-worker-backend.js";
import { assembleEncounterPackage } from "./encounter-package-assembler.js";
import { createSqliteCatalog } from "./catalog-sqlite.js";

export function createBuildRoomServer({ room = new BuildRoom(), persist = () => {}, catalog = createSqliteCatalog() } = {}) {
  if (!catalog || typeof catalog.projectionSummary !== "function") throw new TypeError("catalog must expose projectionSummary()");
  room.setCatalogProjection(() => catalog.projectionSummary());
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: (_input, request) => trustedObserver(request) });
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
        launchLocalBuild(room, run, persist).catch((error) => recordLocalFailure(room, run, error, persist));
        return json(response, 201, run);
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

async function launchLocalBuild(room, run, persist) {
  const graph = planEncounterWork(localSpec(run.ids.encounterId));
  const dispatcher = new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 5 }) });
  const result = await dispatcher.dispatch(graph);
  for (const order of graph.work_orders) {
    for (const event of result.events.filter((candidate) => candidate.work_id === order.work_id)) {
      const projected = room.record(run.ids.encounterId, {
        eventId: event.event_id, workerId: event.worker_id, sequence: event.sequence, occurredAt: event.occurred_at,
        kind: event.kind, message: event.message, evidence: { kind: "local_process", receipt: { work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at } },
      });
      room.upsertWork(run.ids.encounterId, order, projected);
    }
  }
  const packageResult = assembleEncounterPackage({
    host: localSpec(run.ids.encounterId).host_capabilities,
    encounterId: run.ids.encounterId,
    packageId: `package-${run.ids.encounterId.slice(-24)}`,
    baselineModules: [baselineModule(run.ids.encounterId)],
    assembledAt: new Date().toISOString(),
  });
  room.record(run.ids.encounterId, {
    workerId: "local-assembler", sequence: 0, kind: "completed", occurredAt: new Date().toISOString(),
    message: "Local assembler produced a compatible baseline package after terminal worker receipts.",
    package: { package_id: packageResult.package.package_id, revision: packageResult.package.revision, state: packageResult.package.state, selection: packageResult.package.module_ids, fallback: packageResult.package.fallback_provenance, rejections: packageResult.rejections },
    evidence: { kind: "local_process", receipt: { process: "encounter-package-assembler", observed_at: new Date().toISOString() } },
  });
  persist(room);
}

function recordLocalFailure(room, run, error, persist) {
  room.record(run.ids.encounterId, { workerId: "local-dispatcher", sequence: 0, kind: "failed", occurredAt: new Date().toISOString(), message: `Local dispatcher failed: ${error.message}`, evidence: { kind: "local_process", receipt: { process: "encounter-dispatcher", observed_at: new Date().toISOString() } } });
  persist(room);
}

function localSpec(encounterId) {
  return { schema_version: "1", encounter_id: encounterId, seed: 1, deadline_at: "2026-12-31T00:00:00Z", host_capabilities: { schema_version: "1", host_id: "local-build-room", host_build: "1", platform: "local", scripting_backend: "il2cpp", execution_kinds: ["recipe"], loaders: [], contracts: [], limits: { memory_mb: 128, preload_seconds: 1 } }, objective: { kind: "survive", parameters: {} }, arena_envelope: { bounds: { width: 1, height: 1, depth: 1 }, navigation_profiles: ["ground"] }, desired_roles: ["pressure"] };
}

function baselineModule(encounterId) {
  return { schema_version: "1", module_id: `baseline-${encounterId.slice(-24)}`, revision: 1, execution_kind: "recipe", provides: ["encounter.baseline"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "known-playable-baseline" }, fallback_module_ids: [] };
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
    request.on("data", (chunk) => { raw += chunk; if (raw.length > 100_000) reject(new TypeError("request body too large")); });
    request.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new TypeError("invalid JSON")); } });
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
<link rel="icon" href="data:,">
<title>Myth Maker Build Room</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #071621; color: #e7f1f4; }
  * { box-sizing: border-box; } body { margin: 0; min-width: 320px; background: #071621; }
  button, textarea, a { font: inherit; } a { color: #78d1e6; } button:focus-visible, textarea:focus-visible, a:focus-visible, [role=button]:focus-visible { outline: 3px solid #f0b55d; outline-offset: 3px; }
  .shell { max-width: 1680px; margin: auto; padding: 18px 20px 24px; } .masthead { display: flex; gap: 18px; align-items: baseline; border-bottom: 1px solid #1c4557; padding-bottom: 14px; }
  h1, h2, h3, p { margin: 0; } h1 { font-size: 18px; letter-spacing: -.02em; } h2 { font-size: 13px; font-weight: 650; } h3 { font-size: 12px; font-weight: 650; } .muted { color: #9eb3bd; }
  .subtitle { font-size: 13px; color: #9eb3bd; max-width: 850px; } .evidence-boundary { margin: 14px 0; padding: 9px 11px; border-left: 3px solid #f0b55d; color: #c8d8dd; background: #0b202b; font-size: 12px; }
  .submit-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 9px; align-items: end; margin-bottom: 14px; } label { display: grid; gap: 5px; font-size: 12px; color: #9eb3bd; } textarea { width: 100%; min-height: 42px; padding: 10px; resize: vertical; color: inherit; background: #081b27; border: 1px solid #255267; border-radius: 3px; }
  button { border: 1px solid #49b5d0; border-radius: 3px; padding: 10px 13px; color: #04131c; background: #5fc9a5; font-weight: 700; cursor: pointer; } button:hover { background: #76d8b6; }
  .dashboard, .room { display: grid; gap: 12px; } .room { grid-template-columns: 230px minmax(520px, 1fr) 280px; align-items: start; } .panel { border: 1px solid #1d485a; background: #0d2634; border-radius: 4px; } .panel-title { padding: 10px 11px; border-bottom: 1px solid #1d485a; } .panel-body { padding: 10px 11px; }
  .build-list { position: sticky; top: 12px; max-height: calc(100vh - 42px); overflow: auto; } .build-list ul, .inspector-list, .event-list { list-style: none; margin: 0; padding: 0; } .build-item { display: block; padding: 10px 11px; border-bottom: 1px solid #173e4f; text-decoration: none; color: inherit; } .build-item:hover, .build-item[aria-current=true] { background: #103345; } .build-item strong { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .build-item small { color: #9eb3bd; }
  .topology-panel { min-height: 600px; overflow: hidden; } .topology-toolbar { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 9px 11px; border-bottom: 1px solid #1d485a; font-size: 12px; } .badge-row { display: flex; flex-wrap: wrap; gap: 5px; } .badge { display: inline-flex; align-items: center; border: 1px solid #32677b; border-radius: 999px; padding: 2px 7px; color: #bdd3da; font-size: 11px; white-space: nowrap; } .badge.local { border-color: #5fc9a5; color: #8ae2c4; } .badge.fixture { border-color: #f0b55d; color: #f6cc87; } .badge.remote { border-color: #2b9bbb; color: #78d1e6; } .badge.absent { border-color: #506b78; color: #9eb3bd; } .badge.fault { border-color: #e26963; color: #ef938d; }
  .map-wrap { position: relative; min-height: 560px; padding: 20px; overflow: auto; background-color: #0a202c; background-image: linear-gradient(#12384a 1px, transparent 1px), linear-gradient(90deg, #12384a 1px, transparent 1px); background-size: 32px 32px; } .topology-map { position: relative; min-width: 780px; min-height: 510px; display: grid; grid-template-columns: .85fr 1fr 1.3fr 1fr; gap: 15px; align-items: center; } .map-column { position: relative; z-index: 1; display: grid; gap: 10px; align-content: center; min-height: 100%; } .column-heading, .family-heading { color: #7da2ae; font-size: 10px; letter-spacing: .05em; } .worker-family { display: grid; gap: 6px; padding: 6px 0; border-top: 1px solid #1c4557; }
  .routes { position: absolute; inset: 30px 12px 18px; width: calc(100% - 24px); height: calc(100% - 48px); z-index: 0; overflow: visible; pointer-events: none; } .routes path { fill: none; stroke: #39778d; stroke-width: 1; marker-end: url(#arrow); opacity: .22; } .routes path.dependency, .routes path.absence { stroke: #f0b55d; stroke-dasharray: 5 5; } .routes path.spawn { stroke: #2b9bbb; } .routes path.package { stroke: #5fc9a5; } .routes path.selected { opacity: 1; stroke-width:3; filter: drop-shadow(0 0 4px #2b9bbb); }
  .map-node { width: 100%; min-height: 66px; padding: 9px; text-align: left; color: #e7f1f4; background: #0d2634; border: 1px solid #39778d; border-left: 3px solid #506b78; border-radius: 3px; cursor: pointer; } .map-node:hover, .map-node[aria-pressed=true] { background: #11364a; border-color: #78d1e6; } .map-node.status-completed, .map-node.status-accepted { border-left-color: #5fc9a5; } .map-node.status-running, .map-node.status-pending { border-left-color: #f0b55d; } .map-node.status-failed { border-left-color: #e26963; } .map-node.status-absent { opacity: .75; border-left-color: #506b78; border-style: dashed; } .node-name { display: block; font-size: 12px; font-weight: 700; } .node-meta { display: block; margin-top: 5px; color: #9eb3bd; font-size: 10px; line-height: 1.35; }
  .inspector { position: sticky; top: 12px; display: grid; gap: 12px; } .inspector p { font-size: 12px; line-height: 1.45; } .inspector-list li { padding: 6px 0; border-bottom: 1px solid #1b4253; font-size: 12px; } code { color: #8ed9e9; font-size: 11px; overflow-wrap: anywhere; } .asset-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; } .asset-tile { min-height: 96px; padding: 8px; border: 1px solid #28576b; background: #0a202c; border-radius: 3px; font-size: 11px; cursor: pointer; text-align: left; color: inherit; } .asset-tile:hover, .asset-tile[aria-pressed=true] { border-color: #78d1e6; background: #103345; } .asset-tile .tile-icon { display: block; width: 24px; height: 18px; margin-bottom: 7px; border: 1px solid #5fc9a5; background: linear-gradient(135deg, transparent 49%, #5fc9a5 50% 52%, transparent 53%); } .empty-preview { padding: 10px; border: 1px dashed #506b78; color: #9eb3bd; font-size: 12px; line-height: 1.4; } model-viewer { width: 100%; height: 190px; background: #071621; border: 1px solid #39778d; }
  .event-strip { grid-column: 1 / -1; overflow: auto; } .event-strip summary { cursor: pointer; padding: 9px 11px; color: #bdd3da; font-size: 12px; } .event-list { border-top: 1px solid #1d485a; } .event-list li { padding: 8px 11px; border-bottom: 1px solid #1d485a; font-size: 12px; } .event-list small { display: block; color: #9eb3bd; margin-top: 3px; }
  .empty { padding: 52px 18px; text-align: center; color: #9eb3bd; border: 1px dashed #39778d; } .dashboard { max-width: 700px; } .dashboard ul { margin: 0; padding-left: 17px; } .dashboard li { padding: 6px 0; }
  @media (max-width: 1050px) { .room { grid-template-columns: 210px minmax(480px, 1fr); } .inspector { grid-column: 1 / -1; position: static; grid-template-columns: 1fr 1fr; } .event-strip { grid-column: 1 / -1; } } @media (max-width: 720px) { .shell { padding: 13px; } .masthead { display: grid; gap: 6px; } .submit-row, .room { grid-template-columns: 1fr; } .build-list, .inspector { position: static; } .inspector { grid-template-columns: 1fr; } .topology-map { min-width: 700px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
</style>
<body>
  <div class="shell"><header class="masthead"><h1>Myth Maker build room</h1><p class="subtitle">Live local encounter assembly control room. Routes express submitted, spawned, dependency, validation, and package provenance.</p></header>
  <div class="evidence-boundary">Evidence boundary: local HTTP and worker receipts are observed locally; catalog counters are direct local SQLite reads. Cloudflare, Modal, Blender, and Unity remain absent until receipt-bearing adapter input arrives.</div>
  <form id="submit" class="submit-row"><label for="prompt">Encounter request<textarea id="prompt" required placeholder="Describe the encounter to inspect…"></textarea></label><button>Create build request</button></form>
  <main id="empty" class="empty">Select a build or submit an encounter request to inspect its assembly path.</main></div>
  <script><!-- client --></script>
</body>
</html>`;

const CLIENT_SCRIPT = String.raw`
  const main = document.querySelector("main");
  let active;
  let activeRequest;
  let selected = null;
  const labels = {
    fixture: "Simulated fixture (not live)",
    local_process: "Local process receipt (observed)",
    adapter_reported: "Coordinator/dispatcher report (unverified)",
    modal_remote: "Modal remote receipt (observed)",
    blender_window: "Blender window/screenshot/stream (observed)",
  };

  document.querySelector("#submit").addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = document.querySelector("#prompt").value;
    const response = await fetch("/api/encounters", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
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
  function evidenceClass(kind) { return ({ local_process: "local", fixture: "fixture", modal_remote: "remote", blender_window: "remote", absent: "absent" })[kind] || "absent"; }
  function statusClass(status) { return status === "failed" ? "fault" : evidenceClass(status === "absent" ? "absent" : "local"); }
  function compactCounters(catalog, run) { return ["semantic_entities", "assets", "animations"].map((key) => "<span class=\"badge " + evidenceClass(catalog[key].evidence === "local_sqlite_query" ? "local_process" : "absent") + "\">" + esc(key.replace("_", " ")) + " " + catalog[key].count + "</span>").join("") + "<span class=\"badge local\">package rev " + catalog.package_revisions.count + "</span><span class=\"badge " + (run.packages.length ? "local" : "absent") + "\">" + (run.packages.length ? "package revision observed" : "no observed package revision") + "</span><span class=\"badge absent\">player-ready: not observed</span>"; }
  function buildCard(build, current) { return "<li><a class=\"build-item\" " + (current === build.request_id ? "aria-current=\"true\"" : "") + " href=\"" + esc(build.navigation_url) + "\"><strong>" + esc(build.request_id) + "</strong><small>" + (build.terminal ? "terminal" : "active") + " · " + build.work_graph.workers.length + " work items · " + build.revisions.packages + " package rev</small></a></li>"; }
  function renderDashboard(index) { main.className = "dashboard"; main.innerHTML = "<section class=\"panel\"><div class=\"panel-title\"><h2>Build list</h2></div><div class=\"panel-body\"><p class=\"muted\">Current local projection. Terminal history is bounded to " + index.terminal_limit + ".</p><h3 style=\"margin-top:14px\">Active</h3><ul>" + (index.active.length ? index.active.map((build) => buildCard(build)).join("") : "<li class=\"muted\">No active builds.</li>") + "</ul><h3 style=\"margin-top:14px\">Recent terminal</h3><ul>" + (index.recent_terminal.length ? index.recent_terminal.map((build) => buildCard(build)).join("") : "<li class=\"muted\">No terminal builds.</li>") + "</ul></div></section>"; }
  async function submitSteer(event) { event.preventDefault(); const instruction = document.querySelector("#steer-instruction").value; const response = await fetch("/api/builds/" + encodeURIComponent(activeRequest) + "/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) }); if (!response.ok) alert((await response.json()).error); }
  function assetTiles(run) { const assets = run.topology.asset_inventory || []; if (!assets.length) return "<div class=\"empty-preview\">No observed artifact revisions. A model is never invented for catalog counts alone.</div>"; return "<div class=\"asset-grid\">" + assets.map((asset) => "<button class=\"asset-tile\" type=\"button\" data-asset=\"" + esc(asset.artifact_id) + "\" aria-pressed=\"false\"><span class=\"tile-icon\"></span><strong>" + esc(asset.artifact_id) + "</strong><br><span class=\"muted\">rev " + asset.revision + " · " + (asset.eligible ? "preview ready" : "no preview") + "</span><br><span class=\"badge " + evidenceClass(asset.evidence_kind) + "\">source: " + esc(asset.source_state) + "</span><br><span class=\"badge " + (asset.runtime_state === "accepted" ? "local" : "absent") + "\">runtime: " + esc(asset.runtime_state) + "</span><br><span class=\"badge absent\">player-ready: " + esc(asset.player_ready) + "</span></button>").join("") + "</div>"; }
  function inspector(run) { const map = run.topology.map; if (selected?.type === "edge") { const edge = map.edges.find((item) => item.id === selected.id); if (edge) { const source = map.nodes.find((node) => node.id === edge.from); const target = map.nodes.find((node) => node.id === edge.to); const owner = target?.worker_id ? "Worker: <code>" + esc(target.worker_id) + "</code>" : target?.id === "coordinator" ? "No observed remote owner" : "Local build-room projection"; return "<h2>Route inspector</h2><p><strong>" + esc(edge.label) + "</strong></p><p>" + esc(edge.from) + " → " + esc(edge.to) + "</p><ul class=\"inspector-list\"><li>Kind: " + esc(edge.kind) + "</li><li>Spawned / supplied by: " + esc(source?.label || edge.from) + "</li><li>Target owner: " + owner + "</li><li>Evidence: " + esc(labels[target?.evidence_kind] || "Absent / not observed") + "</li></ul>"; } } const node = map.nodes.find((item) => item.id === selected?.id) || map.nodes[0]; const owner = node.worker_id ? "Worker: <code>" + esc(node.worker_id) + "</code>" : node.id === "coordinator" ? "No observed remote owner" : "Owned by the local build-room projection"; const spawned = map.edges.filter((edge) => edge.from === node.id && edge.kind === "spawn").map((edge) => edge.to); const parents = map.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from); return "<h2>Node inspector</h2><p><strong>" + esc(node.label) + "</strong> <span class=\"badge " + statusClass(node.status) + "\">" + esc(node.status) + "</span></p><ul class=\"inspector-list\"><li>Evidence: " + esc(labels[node.evidence_kind] || "Absent / not observed") + "</li><li>" + owner + "</li><li>Spawned by: " + (parents.length ? parents.map(esc).join(", ") : "none") + "</li><li>Spawns: " + (spawned.length ? spawned.map(esc).join(", ") : "none") + "</li><li>" + esc(node.detail) + "</li></ul>"; }
  function mapMarkup(run) {
    const map = run.topology.map;
    const groups = [["intake", "Request"], ["control", "Planner / coordinator / dispatcher"], ["worker", "Worker lanes"], ["finish", "Validation / composer / package"]];
    const routeClass = (edge) => edge.kind === "dependency" || edge.kind === "absence" ? edge.kind : edge.kind === "package" ? "package" : "spawn";
    const nodeMarkup = (node) => "<button type=\"button\" class=\"map-node status-" + esc(node.status) + "\" data-node=\"" + esc(node.id) + "\" aria-pressed=\"" + (selected?.type === "node" && selected.id === node.id) + "\"><span class=\"node-name\">" + esc(node.label) + "</span><span class=\"node-meta\">" + esc(node.status) + " · " + esc(labels[node.evidence_kind] || "absent / not observed") + (node.worker_id ? "<br>" + esc(node.worker_id) : "") + "</span></button>";
    const workerFamilies = [["Source", (node) => node.label?.includes("source")], ["Animation", (node) => node.label?.includes("animation")], ["Combat", (node) => node.label?.includes("combat")], ["Validation", (node) => node.label === "validation"]];
    const columns = groups.map(([family, name]) => { const nodes = map.nodes.filter((node) => node.family === family); const content = family === "worker" ? workerFamilies.map(([familyName, match]) => { const members = nodes.filter(match); return members.length ? "<section class=\"worker-family\"><h4 class=\"family-heading\">" + familyName + "</h4>" + members.map(nodeMarkup).join("") + "</section>" : ""; }).join("") : nodes.map(nodeMarkup).join(""); return "<section class=\"map-column\"><h3 class=\"column-heading\">" + name + "</h3>" + content + "</section>"; }).join("");
    const routes = map.edges.map((edge) => "<path class=\"" + routeClass(edge) + (selected?.type === "edge" && selected.id === edge.id ? " selected" : "") + "\" data-route=\"" + esc(edge.id) + "\" d=\"\"/>").join("");
    return "<div class=\"map-wrap\"><div class=\"topology-map\" role=\"group\" aria-label=\"Encounter assembly topology\"><svg class=\"routes\" viewBox=\"0 0 1000 510\" preserveAspectRatio=\"none\" aria-hidden=\"false\"><defs><marker id=\"arrow\" markerWidth=\"7\" markerHeight=\"7\" refX=\"6\" refY=\"3.5\" orient=\"auto\"><path d=\"M0,0 L7,3.5 L0,7 z\" fill=\"#39778d\"/></marker></defs>" + routes + "</svg>" + columns + "</div><div class=\"edge-legend\" aria-label=\"Topology routes\"><span class=\"badge remote\">solid: local spawn/provenance</span><span class=\"badge fixture\">dashed: dependency or absent remote route</span><span class=\"badge local\">seafoam: package</span></div><div class=\"edge-list\">" + map.edges.map((edge) => "<button class=\"badge " + routeClass(edge) + "\" type=\"button\" data-edge=\"" + esc(edge.id) + "\" aria-pressed=\"" + (selected?.type === "edge" && selected.id === edge.id) + "\">" + esc(edge.from) + " → " + esc(edge.to) + "</button>").join("") + "</div></div>";
  }
  function layoutRoutes(run) { const mapElement = document.querySelector(".topology-map"); if (!mapElement) return; const bounds = mapElement.getBoundingClientRect(); const node = (id) => [...mapElement.querySelectorAll("[data-node]")].find((element) => element.dataset.node === id); const point = (element, side) => { const rect = element.getBoundingClientRect(); return { x: ((side === "right" ? rect.right : rect.left) - bounds.left) / bounds.width * 1000, y: (rect.top + rect.height / 2 - bounds.top) / bounds.height * 510 }; }; mapElement.querySelectorAll("path[data-route]").forEach((path) => { const edge = run.topology.map.edges.find((item) => item.id === path.dataset.route); const from = node(edge?.from); const to = node(edge?.to); if (!edge || !from || !to) return; const source = point(from, "right"); const target = point(to, "left"); const sameColumn = Math.abs(source.x - target.x) < 80; const bend = sameColumn ? 75 : Math.min(150, Math.abs(target.x - source.x) / 2); const end = sameColumn ? point(to, "right") : target; path.setAttribute("d", "M " + source.x + " " + source.y + " C " + (source.x + bend) + " " + source.y + ", " + (end.x - bend) + " " + end.y + ", " + end.x + " " + end.y); }); }
  function events(run) { return run.events.length ? "<details class=\"panel event-strip\"><summary>Event strip · " + run.events.length + " ordered receipts</summary><ul class=\"event-list\">" + run.events.map((entry) => "<li><strong>" + esc(entry.kind) + "</strong> <span class=\"badge " + evidenceClass(entry.evidence.kind) + "\">" + esc(labels[entry.evidence.kind]) + "</span><small>" + esc(entry.workerId) + " · " + esc(entry.message) + "</small></li>").join("") + "</ul></details>" : ""; }
  function render(run) {
    main.className = "room";
    const catalog = run.topology.catalog;
    main.innerHTML = "<aside class=\"panel build-list\"><div class=\"panel-title\"><h2>Build list</h2></div><div id=\"build-list-body\" class=\"panel-body\"><p class=\"muted\">Loading current build index…</p></div></aside><section class=\"panel topology-panel\"><div class=\"topology-toolbar\"><div><h2>Encounter assembly</h2><p class=\"muted\">" + esc(run.ids.requestId) + "</p></div><div class=\"badge-row\">" + compactCounters(catalog, run) + "</div></div>" + mapMarkup(run) + "</section><aside class=\"inspector\"><section class=\"panel\"><div class=\"panel-body\">" + inspector(run) + "</div></section><section class=\"panel\"><div class=\"panel-title\"><h2>Visual asset inventory</h2></div><div class=\"panel-body\">" + assetTiles(run) + "<div id=\"preview-state\" class=\"empty-preview\" style=\"margin-top:8px\">Select an asset tile. Preview requires an observed receipt, accepted runtime state, and a compatible GLB.</div></div></section><section class=\"panel\"><div class=\"panel-title\"><h2>Steer active build</h2></div><form id=\"steer\" class=\"panel-body\"><label for=\"steer-instruction\">Instruction<textarea id=\"steer-instruction\" required placeholder=\"Optional steering instruction…\"></textarea></label><button>Queue steer</button></form></section></aside>" + (selected?.type ? events(run) : "");
    requestAnimationFrame(() => layoutRoutes(run));
    fetch("/api/builds").then((response) => response.json()).then((index) => { const target = document.querySelector("#build-list-body"); if (target) target.innerHTML = "<ul>" + [...index.active, ...index.recent_terminal].map((build) => buildCard(build, activeRequest)).join("") + "</ul>"; }).catch(() => {});
    document.querySelectorAll("[data-node]").forEach((button) => button.addEventListener("click", () => { selected = { type: "node", id: button.dataset.node }; render(run); }));
    document.querySelectorAll("[data-edge]").forEach((button) => { const selectEdge = () => { selected = { type: "edge", id: button.dataset.edge }; render(run); }; button.addEventListener("click", selectEdge); button.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEdge(); } }); });
    document.querySelectorAll("[data-asset]").forEach((button) => button.addEventListener("click", () => { const asset = (run.topology.asset_inventory || []).find((item) => item.artifact_id === button.dataset.asset); const state = document.querySelector("#preview-state"); document.querySelectorAll("[data-asset]").forEach((tile) => tile.setAttribute("aria-pressed", String(tile === button))); if (!asset.eligible) { state.textContent = "Preview withheld: " + asset.reason + "."; return; } state.outerHTML = "<model-viewer id=\"preview-state\" src=\"" + esc(asset.uri) + "\" camera-controls auto-rotate aria-label=\"Observed compatible GLB preview\"></model-viewer>"; if (!document.querySelector("script[data-model-viewer]")) { const script = document.createElement("script"); script.type = "module"; script.dataset.modelViewer = "true"; script.src = "https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"; document.head.append(script); } }));
    document.querySelector("#steer").addEventListener("submit", submitSteer);
  }

  function watch(encounterId) { const source = new EventSource("/api/encounters/" + encodeURIComponent(encounterId) + "/stream"); source.addEventListener("projection", (event) => render(JSON.parse(event.data))); }
  function watchDashboard() { const source = new EventSource("/api/builds/stream"); source.addEventListener("projection", (event) => renderDashboard(JSON.parse(event.data))); }
  async function start() {
    const requestId = new URLSearchParams(location.search).get("build");
    if (requestId) { const response = await fetch("/api/builds/" + encodeURIComponent(requestId)); if (response.ok) { const run = await response.json(); active = run.ids.encounterId; activeRequest = run.ids.requestId; render(run); watch(active); return; } }
    const response = await fetch("/api/builds");
    if (active) return;
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
