import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EncounterDispatcher, JsonReceiptStore } from "./encounter-dispatcher.js";
import { ModalBridgeBackend } from "./modal-bridge-backend.js";
import { createCoordinatorEventSink, createRailwayDispatchHandler } from "./railway-dispatcher.js";
import { createCoordinatorArtifactPublicationClient, createRailwayArtifactHandler, createRailwayArtifactStore } from "./railway-artifact-store.js";

const port = Number(process.env.PORT || 3000);
const receiptPath = resolve(requireEnv("RECEIPT_STORE_PATH"));
const artifactStore = createRailwayArtifactStore({
  rootPath: requireEnv("ARTIFACT_STORE_PATH"),
  publicOrigin: requireEnv("PUBLIC_ARTIFACT_ORIGIN"),
});
const artifacts = createRailwayArtifactHandler({
  store: artifactStore,
  publicationToken: requireEnv("ARTIFACT_PUBLICATION_TOKEN"),
  coordinator: createCoordinatorArtifactPublicationClient({
    coordinatorUrl: requireEnv("COORDINATOR_URL"),
    ingressToken: requireEnv("AGENT_INGRESS_TOKEN"),
    catalogAcceptanceToken: requireEnv("CATALOG_ACCEPTANCE_TOKEN"),
  }),
});
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
  const pathname = new URL(url).pathname;
  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: "ok", receipt_store: "mounted-json-v1", modal_app: process.env.MODAL_APP_NAME || "myth-maker-encounter-draft" }));
  }
  if (isArtifactRoute(pathname)) {
    const body = await readBody(request, 52 * 1024 * 1024);
    const result = await artifacts(new Request(url, { method: request.method, headers: request.headers, body: body.length ? body : undefined }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    return response.end(Buffer.from(await result.arrayBuffer()));
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

async function readBody(request, maximumBytes = 256 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isArtifactRoute(pathname) {
  return pathname === "/v1/artifact-publications"
    || pathname === "/v1/encounter-artifact-publications"
    || /^\/v1\/artifacts\/[a-f0-9]{64}$/.test(pathname)
    || /^\/v1\/artifact-receipts\/(catalog|package|assembly)$/.test(pathname);
}
