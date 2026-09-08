import { createServer } from "node:http";
import { JsonSteeringStore } from "./responses-steering-worker-store.js";
import { ResponsesSteeringGateway, ResponsesSteeringWorker, createCoordinatorSteeringReporter, createSteeringWorkerCommandHandler } from "./responses-steering.js";

function asRequest(request, body) { return new Request(`http://steering-worker${request.url}`, { method: request.method, headers: request.headers, body: body.length ? body : undefined }); }
async function readBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); }

/** A concrete Node service: this process opens and owns each Responses lane. */
export async function createResponsesSteeringWorkerService({ coordinatorUrl, commandToken, reportToken, ownerId, stateFile, openResponsesSocket, fetcher } = {}) {
  if (typeof openResponsesSocket !== "function") throw new TypeError("openResponsesSocket is required");
  const store = await JsonSteeringStore.open(stateFile);
  const reporter = createCoordinatorSteeringReporter({ coordinatorUrl, reportToken, ownerId, fetcher });
  const worker = new ResponsesSteeringWorker({ ownerId, reporter, gateway: new ResponsesSteeringGateway({ store }) });
  const command = createSteeringWorkerCommandHandler({ worker, commandToken });
  const service = {
    worker,
    async registerAttempt(attempt) { return worker.registerAttempt(attempt, await openResponsesSocket(attempt)); },
    async markPersistedAttemptsUncertain() { return worker.gateway.markPersistedLanesUncertain(); },
    async handle(request, body) {
      if (request.method === "POST" && request.url === "/v1/steering/attempts") {
        if (request.headers.authorization !== `Bearer ${commandToken}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        try { return new Response(JSON.stringify({ attempt: await this.registerAttempt(JSON.parse(body.toString("utf8"))) }), { status: 201 }); } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 409 }); }
      }
      return command(asRequest(request, body));
    },
  };
  await service.markPersistedAttemptsUncertain();
  return service;
}

export async function startResponsesSteeringWorkerService(options) {
  const service = await createResponsesSteeringWorkerService(options);
  const server = createServer(async (request, response) => {
    const result = await service.handle(request, await readBody(request));
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
  });
  await new Promise((resolve) => server.listen(options.port || 8788, resolve));
  return { server, service };
}
