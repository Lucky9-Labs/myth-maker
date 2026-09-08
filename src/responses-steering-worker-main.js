import { startResponsesSteeringWorkerService } from "./responses-steering-worker-service.js";

const env = process.env;
if (!env.RESPONSES_WEBSOCKET_URL) throw new Error("RESPONSES_WEBSOCKET_URL is required");
await startResponsesSteeringWorkerService({
  coordinatorUrl: env.COORDINATOR_URL, commandToken: env.STEERING_COMMAND_TOKEN, reportToken: env.STEERING_REPORT_TOKEN,
  ownerId: env.STEERING_WORKER_OWNER_ID, stateFile: env.STEERING_STATE_FILE || "/tmp/myth-maker-steering.json", port: Number(env.PORT || 8788),
  openResponsesSocket: async () => {
    const socket = new WebSocket(env.RESPONSES_WEBSOCKET_URL);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("responses_socket_open_failed")), { once: true });
    });
    return socket;
  },
});
