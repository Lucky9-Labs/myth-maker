import http from "node:http";
import { EncounterDispatcher } from "./encounter-dispatcher.js";
import { createCoordinatorEventSink, createRailwayDispatchHandler } from "./railway-dispatcher.js";
import { PostgresReceiptStore } from "./postgres-receipt-store.js";

const WORK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
    const body = await readBody(request);
    const result = await dispatch(new Request("http://railway.local/v1/dispatch", { method: request.method, headers: request.headers, body }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
}

export async function startFromEnvironment(environment = process.env) {
  for (const name of ["DATABASE_URL", "WORK_DISPATCH_TOKEN", "COORDINATOR_URL", "AGENT_INGRESS_TOKEN"]) {
    if (!environment[name]) throw new Error(`${name} is required to start the Railway dispatcher`);
  }
  const { Pool } = await import("pg");
  const store = new PostgresReceiptStore(new Pool({ connectionString: environment.DATABASE_URL, ssl: environment.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true } }));
  await store.initialize();
  const backend = { async launch() { throw new Error("Modal work execution is not configured; verification remains non-mutating"); } };
  const server = createRailwayServer({ dispatcher: new EncounterDispatcher({ backend, receiptStore: store }), dispatchToken: environment.WORK_DISPATCH_TOKEN, eventSink: createCoordinatorEventSink({ coordinatorUrl: environment.COORDINATOR_URL, ingressToken: environment.AGENT_INGRESS_TOKEN }), releaseRevision: environment.RELEASE_REVISION || "unversioned" });
  await new Promise((resolve) => server.listen(Number(environment.PORT || 3000), "0.0.0.0", resolve));
  return server;
}

function send(response, status, body, headers = {}) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }); response.end(JSON.stringify(body)); }
async function readBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString(); }

if (import.meta.url === `file://${process.argv[1]}`) startFromEnvironment().catch((error) => { process.stderr.write(`railway-dispatcher: ${error.message}\n`); process.exitCode = 1; });
