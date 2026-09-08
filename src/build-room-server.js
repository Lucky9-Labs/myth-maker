import { createServer } from "node:http";
import { BuildRoom, CoordinatorEventAdapter } from "./build-room.js";

export function createBuildRoomServer({ room = new BuildRoom() } = {}) {
  const adapter = new CoordinatorEventAdapter(room);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") return html(response);
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { status: "ok", encounters: room.list().length });
      if (request.method === "POST" && url.pathname === "/api/encounters") {
        return json(response, 201, room.submit(await body(request)));
      }
      const match = url.pathname.match(/^\/api\/encounters\/([^/]+)$/);
      if (request.method === "GET" && match) {
        const snapshot = room.snapshot(match[1]);
        const after = url.searchParams.get("after");
        return json(response, 200, { ...snapshot, events: room.replay(match[1], after || undefined) });
      }
      if (request.method === "POST" && ["/api/ingest/coordinator", "/api/ingest/dispatcher"].includes(url.pathname)) {
        return json(response, 201, adapter.ingest(await body(request)));
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, error instanceof RangeError ? 404 : 400, { error: error.message });
    }
  });
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
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Myth Maker Build Room</title><style>
  :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#101318;color:#e9eef4}body{max-width:1160px;margin:0 auto;padding:28px}h1{margin:0}small,.muted{color:#a9b5c3}.notice{border:1px solid #e2ae54;background:#372815;padding:12px;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.card{border:1px solid #334050;background:#171d25;padding:14px;border-radius:6px}.stage{border-left:4px solid #52677d;padding:9px;margin:8px 0}.stage.live{border-color:#4bd8a7}.stage.fixture{border-color:#e2ae54}textarea{width:100%;min-height:80px;background:#0d1117;color:inherit;border:1px solid #52677d;padding:8px;box-sizing:border-box}button{margin-top:8px;padding:9px 13px;background:#4bd8a7;border:0;color:#07130f;font-weight:bold;cursor:pointer}code{color:#91c8ff;word-break:break-word}table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-top:1px solid #334050;padding:8px;text-align:left;vertical-align:top}.pill{display:inline-block;border:1px solid #52677d;border-radius:12px;padding:2px 7px;font-size:11px}#empty{padding:30px;text-align:center;border:1px dashed #52677d}</style><body>
  <h1>Myth Maker <span class="muted">/ encounter build room</span></h1><p class="muted">Local inspection surface. It does not dispatch a coordinator, Modal job, or Blender worker by itself.</p>
  <div class="notice"><strong>Evidence boundary:</strong> fixture rows are simulated; local HTTP acceptance is observed locally; Modal and Blender evidence stay absent until receipt-bearing adapter input arrives.</div>
  <form id="submit"><label for="prompt">Encounter request</label><textarea id="prompt" required placeholder="Describe the encounter to inspect…"></textarea><button>Create local build-room request</button></form>
  <main id="empty">Submit an encounter request to generate its encounter, request, and worker IDs.</main><script>
  const main=document.querySelector('main');let active;document.querySelector('#submit').addEventListener('submit',async(e)=>{e.preventDefault();const prompt=document.querySelector('#prompt').value;const r=await fetch('/api/encounters',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt})});const data=await r.json();if(!r.ok)return alert(data.error);active=data.ids.encounterId;render(data);document.querySelector('#prompt').value=''});
  function esc(value){const s=String(value??'');const d=document.createElement('div');d.textContent=s;return d.innerHTML}function evidence(e){return ({fixture:'Simulated fixture (not live)',local_process:'Local process receipt (observed)',adapter_reported:'Coordinator/dispatcher report (unverified)',modal_remote:'Modal remote receipt (observed)',blender_window:'Blender window/screenshot/stream (observed)'})[e.kind]||'Unknown evidence source'}
  function render(run){const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(run.submittedAt))/1000));main.innerHTML='<section class="grid"><div class="card"><h2>Identity</h2><p>Encounter<br><code>'+esc(run.ids.encounterId)+'</code></p><p>Request<br><code>'+esc(run.ids.requestId)+'</code></p><p>Worker<br><code>'+esc(run.ids.workerId)+'</code></p><p>Timer <strong>'+elapsed+'s</strong></p></div><div class="card"><h2>Pipeline / work graph</h2><div class="stage live">Local intake — observed receipt</div><div class="stage fixture">Preview fixture — simulated only</div><div class="stage">Coordinator adapter — no observed receipt</div><div class="stage">Dispatcher / Modal — '+(run.evidence.modal.length?'observed receipt':'no observed remote receipt')+'</div><div class="stage">Blender — '+(run.evidence.blender.length?'observed visual evidence':'no observed window, screenshot, or stream')+'</div><div class="stage">Package — '+(run.packages.length?'revision observed':'no observed package revision')+'</div></div></section><section class="card"><h2>Ordered worker events</h2><table><thead><tr><th>Sequence</th><th>Event</th><th>Evidence source</th><th>Message</th></tr></thead><tbody>'+run.events.map(e=>'<tr><td>'+e.sequence+'</td><td>'+esc(e.kind)+'</td><td><span class="pill">'+esc(evidence(e.evidence))+'</span></td><td>'+esc(e.message)+'</td></tr>').join('')+'</tbody></table></section><section class="grid"><div class="card"><h2>Artifact revisions</h2>'+revisionList(run.artifacts,'artifact_id')+'</div><div class="card"><h2>Package revisions</h2>'+revisionList(run.packages,'package_id')+'</div></section>'}
  function revisionList(rows,key){return rows.length?'<ul>'+rows.map(x=>'<li><code>'+esc(x[key])+'</code> rev '+x.revision+'</li>').join('')+'</ul>':'<p class="muted">No observed revisions.</p>'}setInterval(async()=>{if(!active)return;const r=await fetch('/api/encounters/'+encodeURIComponent(active));if(r.ok)render(await r.json())},1000);
  </script></body></html>`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const port = Number(process.env.BUILD_ROOM_PORT || 4173);
  createBuildRoomServer().listen(port, "127.0.0.1", () => console.log(`Myth Maker build room: http://127.0.0.1:${port}`));
}
