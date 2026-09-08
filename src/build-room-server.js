import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BuildRoom, CoordinatorEventAdapter } from "./build-room.js";

export function createBuildRoomServer({ room = new BuildRoom(), persist = () => {} } = {}) {
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: (_input, request) => trustedObserver(request) });
  const streams = new Map();
  const buildStreams = new Set();
  room.subscribe((encounterId, snapshot) => {
    for (const response of streams.get(encounterId) || []) stream(response, snapshot);
    for (const response of buildStreams) stream(response, room.buildIndex());
  });
  return createServer(async (request, response) => {
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
  code { color: #91c8ff; word-break: break-word; } table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { border-top: 1px solid #334050; padding: 8px; text-align: left; vertical-align: top; } .pill { display: inline-block; border: 1px solid #52677d; border-radius: 12px; padding: 2px 7px; font-size: 11px; }
  #empty { padding: 30px; text-align: center; border: 1px dashed #52677d; }
</style>
<body>
  <h1>Myth Maker <span class="muted">/ encounter build room</span></h1>
  <p class="muted">Local inspection surface. It does not dispatch a coordinator, Modal job, or Blender worker by itself.</p>
  <div class="notice"><strong>Evidence boundary:</strong> fixture rows are simulated; local HTTP acceptance is observed locally; Modal and Blender evidence stay absent until receipt-bearing adapter input arrives.</div>
  <form id="submit"><label for="prompt">Encounter request</label><textarea id="prompt" required placeholder="Describe the encounter to inspect…"></textarea><button>Create local build-room request</button></form>
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
  function revisionList(rows, key) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row[key]) + "</code> rev " + row.revision + "</li>").join("") + "</ul>" : "<p class=\"muted\">No observed revisions.</p>"; }
  function eventRows(events) { return events.map((entry) => "<tr><td>" + entry.sequence + "</td><td>" + esc(entry.kind) + "</td><td><span class=\"pill\">" + esc(labels[entry.evidence.kind] || "Unknown evidence source") + "</span></td><td>" + esc(entry.message) + "</td></tr>").join(""); }
  function workerLanes(run, elapsed) {
    const workItems = run.topology.work_graph;
    if (!workItems.length) return "<div class=\"lane absent\"><strong>No observed work items</strong><br>Coordinator work graph has not been received.</div>";
    return workItems.map((work) => { const workElapsed = Math.max(0, Math.floor((Date.now() - Date.parse(work.started_at)) / 1000)); return "<div class=\"lane " + evidenceClass(work.evidence_kind) + "\"><strong>planner → coordinator → dispatcher → " + esc(work.lane) + "</strong><br>work: <code>" + esc(work.work_id) + "</code><br>worker: <code>" + esc(work.worker_id) + "</code><br>status: " + esc(work.status) + " · " + workElapsed + "s<br>dependency edge: " + esc(work.depends_on_work_ids.join(" → ") || "request") + " → " + esc(work.work_id) + "<br>evidence: " + esc(labels[work.evidence_kind]) + "</div>"; }).join("");
  }
  function evidenceClass(kind) { return ({ local_process: "observed-local", fixture: "fixture", modal_remote: "observed-modal", blender_window: "observed-blender" })[kind] || "absent"; }
  function buildCard(build) { return "<li><a href=\"" + esc(build.navigation_url) + "\"><code>" + esc(build.request_id) + "</code></a><br>encounter: <code>" + esc(build.encounter_id) + "</code><br>" + esc(build.terminal ? "terminal" : "active") + " · workers: " + build.work_graph.workers.length + " · revisions: " + build.revisions.artifacts + "/" + build.revisions.packages + "</li>"; }
  function renderDashboard(index) { main.innerHTML = "<section class=\"card\"><h2>Live builds</h2><p class=\"muted\">Active builds are projected from current local state; terminal history is bounded to " + index.terminal_limit + ".</p><h3>Active</h3>" + (index.active.length ? "<ul>" + index.active.map(buildCard).join("") + "</ul>" : "<p class=\"muted\">No active builds.</p>") + "<h3>Recent terminal</h3>" + (index.recent_terminal.length ? "<ul>" + index.recent_terminal.map(buildCard).join("") + "</ul>" : "<p class=\"muted\">No terminal builds.</p>") + "</section>"; }
  function steerRows(rows) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row.steer_id) + "</code> — " + esc(row.status) + (row.status === "accepted" ? " (not applied)" : "") + (row.status === "committed" ? " (successor response committed)" : "") + "</li>").join("") + "</ul>" : "<p class=\"muted\">No steering receipts.</p>"; }
  async function submitSteer(event) { event.preventDefault(); const instruction = document.querySelector("#steer-instruction").value; const response = await fetch("/api/builds/" + encodeURIComponent(activeRequest) + "/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) }); if (!response.ok) alert((await response.json()).error); }
  function render(run) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(run.submittedAt)) / 1000));
    const modal = run.evidence.modal.length ? "observed receipt" : "no observed remote receipt";
    const blender = run.evidence.blender.length ? "observed visual evidence" : "no observed window, screenshot, or stream";
    const packageRevision = run.packages.length ? "revision observed" : "no observed package revision";
    const catalog = run.topology.catalog;
    main.innerHTML = "<p><a href=\"/\">← All builds</a></p><section class=\"grid\"><div class=\"card\"><h2>Identity</h2><p>Encounter<br><code>" + esc(run.ids.encounterId) + "</code></p><p>Request<br><code>" + esc(run.ids.requestId) + "</code></p><p>Worker correlation<br><code>" + esc(run.ids.workerId) + "</code></p><p>Timer <strong>" + elapsed + "s</strong></p></div><div class=\"card\"><h2>Evidence legend</h2><p class=\"fixture\">Fixture — simulated only</p><p class=\"observed-local\">Local — observed process receipt</p><p class=\"observed-modal\">Modal — only observed with trusted receipt</p><p class=\"observed-blender\">Blender — only observed with trusted visual receipt</p><p class=\"absent\">Gray — absent / unobserved</p></div></section><section class=\"card\"><h2>Observed work graph</h2><div class=\"topology\"><div class=\"node observed-local\">Request<br>↓<br>Encounter</div><div class=\"arrow\">→</div><div class=\"node absent\">Coordinator/dispatcher<br>only receipt-derived work shown below</div></div><div class=\"topology\">" + workerLanes(run, elapsed) + "</div></section><section class=\"grid\"><div class=\"card\"><h2>Catalog counters</h2><p>Semantic entities: " + catalog.semantic_entities.count + " (" + catalog.semantic_entities.evidence + ")</p><p>Assets: " + catalog.assets.count + " (" + catalog.assets.evidence + ")</p><p>Animations: " + catalog.animations.count + " (" + catalog.animations.evidence + ")</p><p>Artifact revisions: " + catalog.artifact_revisions.count + " (" + catalog.artifact_revisions.evidence + ")</p><p>Package revisions: " + catalog.package_revisions.count + " (" + catalog.package_revisions.evidence + ")</p></div><div class=\"card\"><h2>Steer active build</h2><form id=\"steer\"><textarea id=\"steer-instruction\" required placeholder=\"Optional steering instruction…\"></textarea><button>Queue steer</button></form>" + steerRows(run.steering) + "</div><div class=\"card\"><h2>Pipeline / work graph</h2><div class=\"stage live\">Local intake — observed receipt</div><div class=\"stage fixture\">Preview fixture — simulated only</div><div class=\"stage absent\">Coordinator adapter — no observed receipt</div><div class=\"stage absent\">Dispatcher / Modal — " + modal + "</div><div class=\"stage absent\">Blender — " + blender + "</div><div class=\"stage absent\">Package — " + packageRevision + "</div></div></section><section class=\"card\"><h2>Ordered worker events</h2><table><thead><tr><th>Sequence</th><th>Event</th><th>Evidence source</th><th>Message</th></tr></thead><tbody>" + eventRows(run.events) + "</tbody></table></section><section class=\"grid\"><div class=\"card\"><h2>Artifact revisions</h2>" + revisionList(run.artifacts, "artifact_id") + "</div><div class=\"card\"><h2>Package revisions</h2>" + revisionList(run.packages, "package_id") + "</div></section>";
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
