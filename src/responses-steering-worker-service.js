import { createServer } from "node:http";
import { JsonSteeringStore } from "./responses-steering-worker-store.js";
import { ResponsesSteeringGateway, ResponsesSteeringWorker, createCoordinatorSteeringReporter, createSteeringWorkerCommandHandler } from "./responses-steering.js";

function asRequest(request, body) { return new Request(`http://steering-worker${request.url}`, { method: request.method, headers: request.headers, body: body.length ? body : undefined }); }
async function readBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); }
function waitForCreated(socket, initialResponse) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => { try { const event = JSON.parse(message.data); if (event.type === "response.created" && typeof event.response?.id === "string") resolve(event.response.id); } catch {} };
    socket.addEventListener("message", onMessage); try { socket.send(JSON.stringify({ type: "response.create", ...initialResponse })); } catch (error) { reject(error); }
  });
}

/** A concrete Node service: this process opens and owns each Responses lane. */
export async function createResponsesSteeringWorkerService({ coordinatorUrl, commandToken, reportToken, ownerId, stateFile, openResponsesSocket, fetcher } = {}) {
  if (typeof openResponsesSocket !== "function") throw new TypeError("openResponsesSocket is required");
  const store = await JsonSteeringStore.open(stateFile);
  const reporter = createCoordinatorSteeringReporter({ coordinatorUrl, reportToken, ownerId, fetcher });
  const worker = new ResponsesSteeringWorker({ ownerId, reporter, gateway: new ResponsesSteeringGateway({ store }) });
  const command = createSteeringWorkerCommandHandler({ worker, commandToken });
  const service = {
    worker,
    async startAttempt(draft, initialResponse) {
      if (draft?.response_id !== undefined) throw new Error("response_id_is_socket_derived");
      const socket = await openResponsesSocket(draft);
      const response_id = await waitForCreated(socket, initialResponse);
      return worker.registerAttempt({ ...draft, response_id }, socket);
    },
    async markPersistedAttemptsUncertain() { return worker.gateway.markPersistedLanesUncertain(); },
    async handle(request, body) {
      if (body.length > 65536) return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 });
      if (request.method === "POST" && request.url === "/v1/steering/attempts") {
        if (request.headers.authorization !== `Bearer ${commandToken}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        try { const value = JSON.parse(body.toString("utf8")); return new Response(JSON.stringify({ attempt: await this.startAttempt(value.attempt, value.initial_response) }), { status: 201 }); } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 409 }); }
      }
      return command(asRequest(request, body));
    },
  };
  await service.markPersistedAttemptsUncertain(); void worker.flushReports();
  return service;
}

export async function startResponsesSteeringWorkerService(options) {
  const service = await createResponsesSteeringWorkerService(options);
  const server = createServer(async (request, response) => {
    const body = await readBody(request); if (body.length > 65536) { response.writeHead(413); response.end(); return; }
    const result = await service.handle(request, body);
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
  });
  await new Promise((resolve) => server.listen(options.port || 8788, resolve));
  return { server, service };
}
