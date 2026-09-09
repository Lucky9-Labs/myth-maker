import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EncounterDispatcher, JsonReceiptStore } from "./encounter-dispatcher.js";
import { ModalBridgeBackend } from "./modal-bridge-backend.js";
import { createCoordinatorEventSink, createRailwayDispatchHandler } from "./railway-dispatcher.js";

const port = Number(process.env.PORT || 3000);
const receiptPath = resolve(requireEnv("RECEIPT_STORE_PATH"));
const dispatcher = new EncounterDispatcher({
  backend: new ModalBridgeBackend(),
  receiptStore: new JsonReceiptStore(receiptPath),
});
const eventSink = createCoordinatorEventSink({
  coordinatorUrl: requireEnv("COORDINATOR_URL"),
  ingressToken: requireEnv("AGENT_INGRESS_TOKEN"),
});
const dispatch = createRailwayDispatchHandler({
  dispatcher,
  dispatchToken: requireEnv("WORK_DISPATCH_TOKEN"),
  eventSink,
  defer: true,
  onBackgroundError: (message) => console.error(message),
});

await mkdir(dirname(receiptPath), { recursive: true });
try { await dispatcher.recoverDeliveries(eventSink); }
catch (error) { console.error(`receipt recovery deferred: ${error.message}`); }

createServer(async (request, response) => {
  const url = `http://${request.headers.host || "localhost"}${request.url || "/"}`;
  if (request.method === "GET" && new URL(url).pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: "ok", receipt_store: "mounted-json-v1", modal_app: process.env.MODAL_APP_NAME || "myth-maker-encounter-draft" }));
  }
  const body = await readBody(request);
  const result = await dispatch(new Request(url, { method: request.method, headers: request.headers, body: body.length ? body : undefined }));
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
}).listen(port, "0.0.0.0", () => console.log(`myth-maker Railway dispatcher listening on ${port}`));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
