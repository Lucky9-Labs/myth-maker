import http from "node:http";
import { EncounterDispatcher } from "./encounter-dispatcher.js";
import { createCoordinatorEventSink, createRailwayDispatchHandler } from "./railway-dispatcher.js";
import { PostgresReceiptStore } from "./postgres-receipt-store.js";

const WORK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY_BYTES = 1_048_576;

export function createRailwayServer({ dispatcher, dispatchToken, eventSink, releaseRevision = "unversioned" }) {
  const dispatch = createRailwayDispatchHandler({ dispatcher, dispatchToken, eventSink });
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://railway.local");
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/v1/dispatch/verify") {
      const workId = request.headers["x-work-id"];
      if (typeof workId !== "string" || !WORK_ID.test(workId)) return send(response, 400, { error: "invalid_x_work_id" });
      // This route never claims work, invokes the backend, or writes a receipt.
      return send(response, 200, { status: "ready", acknowledgement: "x-work-id-accepted", work_id: workId, dispatch_mutated: false, release_revision: releaseRevision }, { "x-work-id": workId });
    }
    if (url.pathname !== "/v1/dispatch") return send(response, 404, { error: "not_found" });
    let body;
    try { body = await readBody(request); } catch (error) { return send(response, error.code === "body_too_large" ? 413 : 400, { error: error.code || "invalid_body" }); }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string"));
    const result = await dispatch(new Request("http://railway.local/v1/dispatch", { method: request.method, headers, body }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
}

export async function startFromEnvironment(environment = process.env, { backend } = {}) {
  for (const name of ["DATABASE_URL", "WORK_DISPATCH_TOKEN", "COORDINATOR_URL", "AGENT_INGRESS_TOKEN"]) {
    if (!environment[name]) throw new Error(`${name} is required to start the Railway dispatcher`);
  }
  const { Pool } = await import("pg");
  const store = new PostgresReceiptStore(new Pool({ connectionString: environment.DATABASE_URL, ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true } }));
  await store.initialize();
  const configuredBackend = backend || await loadBackend(environment);
  const dispatcher = new EncounterDispatcher({ backend: configuredBackend, receiptStore: store });
  const eventSink = createCoordinatorEventSink({ coordinatorUrl: environment.COORDINATOR_URL, ingressToken: environment.AGENT_INGRESS_TOKEN });
  await dispatcher.recoverDeliveries(eventSink);
  const server = createRailwayServer({ dispatcher, dispatchToken: environment.WORK_DISPATCH_TOKEN, eventSink, releaseRevision: environment.RELEASE_REVISION || "unversioned" });
  await new Promise((resolve) => server.listen(Number(environment.PORT || 3000), "0.0.0.0", resolve));
  return server;
}

function send(response, status, body, headers = {}) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }); response.end(JSON.stringify(body)); }
async function loadBackend(environment) {
  if (!environment.DISPATCH_BACKEND_MODULE) throw new Error("DISPATCH_BACKEND_MODULE is required; refuse to start a dispatcher that cannot execute work");
  const module = await import(environment.DISPATCH_BACKEND_MODULE);
  if (typeof module.createBackend !== "function") throw new Error("DISPATCH_BACKEND_MODULE must export createBackend(environment)");
  const backend = await module.createBackend(environment);
  if (!backend || typeof backend.launch !== "function") throw new Error("configured dispatch backend must implement launch(order, options)");
  return backend;
}
async function readBody(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) { const error = new Error("body_too_large"); error.code = "body_too_large"; throw error; } chunks.push(chunk); } return Buffer.concat(chunks).toString(); }

if (import.meta.url === `file://${process.argv[1]}`) startFromEnvironment().catch((error) => { process.stderr.write(`railway-dispatcher: ${error.message}\n`); process.exitCode = 1; });
