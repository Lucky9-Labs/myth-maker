import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySteeringStore, ResponsesSteeringGateway, ResponsesSteeringWorker, createCoordinatorSteeringReporter, createSteeringWorkerCommandHandler } from "../src/responses-steering.js";

class FakeWebSocketLane {
  constructor() { this.frames = []; this.listeners = new Map(); }
  send(frame) { this.frames.push(JSON.parse(frame)); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  emit(type, data) { for (const listener of this.listeners.get(type) || []) listener(type === "message" ? { data } : {}); }
}

async function drainEvents() { await new Promise((resolve) => setImmediate(resolve)); }

test("a single-agent attempt queues a user steer and commits only at its successor response", async () => {
  const lane = new FakeWebSocketLane();
  const gateway = new ResponsesSteeringGateway();
  await gateway.recordAttempt({
    attempt_id: "attempt-alpha",
    encounter_id: "encounter-alpha",
    work_id: "arena-shell",
    worker_id: "worker-one",
    lane_id: "lane-alpha",
    response_id: "resp-original",
    mode: "single_agent",
    model_supports_steering: true,
  }, lane);

  const receipt = await gateway.requestSteer("attempt-alpha", {
    client_steering_id: "steer-alpha",
    input: [{ role: "user", content: [{ type: "input_text", text: "Prefer a flooded courtyard." }] }],
  });

  assert.equal(receipt.status, "queued");
  assert.equal(receipt.response_id, "resp-original");
  assert.equal(receipt.input.text, "Prefer a flooded courtyard.");
  assert.equal(lane.frames.length, 1);
  assert.deepEqual(lane.frames[0], {
    type: "response.steer",
    previous_response_id: "resp-original",
    input: [{ role: "user", content: [{ type: "input_text", text: "Prefer a flooded courtyard." }] }],
  });

  lane.emit("message", JSON.stringify({ type: "response.steer.accepted", steer: { id: "steer-server-01", previous_response_id: "resp-original" } }));
  await drainEvents();
  assert.equal((await gateway.getReceipt("steer-alpha")).status, "accepted");
  assert.equal((await gateway.getReceipt("steer-alpha")).server_steering_id, "steer-server-01");
  lane.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp-successor", previous_response_id: "resp-original" } }));
  await drainEvents();
  const committed = await gateway.getReceipt("steer-alpha");
  assert.equal(committed.status, "committed");
  assert.equal(committed.successor_response_id, "resp-successor");
  lane.emit("message", JSON.stringify({ type: "response.completed", response: { id: "resp-successor" } }));
  await drainEvents();
  await gateway.requestSteer("attempt-alpha", {
    client_steering_id: "steer-after-complete",
    input: [{ role: "user", content: [{ type: "input_text", text: "Keep the flooded courtyard." }] }],
  });
  assert.equal(lane.frames[1].type, "response.create");
  assert.equal(lane.frames[1].previous_response_id, "resp-successor");
});

test("a closed Responses lane fails the queued receipt without replaying its frame", async () => {
  const lane = new FakeWebSocketLane();
  const gateway = new ResponsesSteeringGateway();
  await gateway.recordAttempt({ attempt_id: "attempt-close", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", lane_id: "lane-close", response_id: "resp-close", mode: "single_agent", model_supports_steering: true }, lane);
  await gateway.requestSteer("attempt-close", { client_steering_id: "steer-close", input: [{ role: "user", content: [{ type: "input_text", text: "Stay readable." }] }] });
  lane.emit("close");
  await drainEvents();
  const receipt = await gateway.getReceipt("steer-close");
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.error_code, "steering_transport_reconnect_uncertain");
  assert.equal(lane.frames.length, 1);
});

test("nested steering pending input resolves saved stubs once across a gateway restart", async () => {
  const lane = new FakeWebSocketLane();
  const store = new InMemorySteeringStore();
  const gateway = new ResponsesSteeringGateway({ store });
  await gateway.recordAttempt({ attempt_id: "attempt-required", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", lane_id: "lane-required", response_id: "resp-required", mode: "single_agent", model_supports_steering: true }, lane);
  await gateway.requestSteer("attempt-required", { client_steering_id: "steer-required", input: [{ role: "user", content: [{ type: "input_text", text: "Keep terrain readable." }] }] });
  await gateway.handleServerEvent("lane-required", { type: "response.steer.pending", steer: { id: "steer-server-required", previous_response_id: "resp-required" } });
  await gateway.handleServerEvent("lane-required", { type: "response.required_input", steer: { id: "steer-server-required", previous_response_id: "resp-required", required_input: [{ id: "tool-call-01" }] } });
  assert.equal((await gateway.getReceipt("steer-required")).status, "required_input");
  const restarted = new ResponsesSteeringGateway({ store });
  restarted.attachLane("lane-required", lane);
  await restarted.resolveRequiredInput("attempt-required", { "tool-call-01": { type: "function_call_output", call_id: "tool-call-01", output: "cached result" } });
  assert.deepEqual(lane.frames.at(-1), { type: "response.create", previous_response_id: "resp-required", input: [{ type: "function_call_output", call_id: "tool-call-01", output: "cached result" }] });
  const frameCount = lane.frames.length;
  await restarted.resolveRequiredInput("attempt-required", { "tool-call-01": { type: "function_call_output", call_id: "tool-call-01", output: "cached result" } });
  assert.equal(lane.frames.length, frameCount);
});

test("the worker-owned command handler separates socket ownership from authenticated reporting", async () => {
  const frames = [];
  const reports = [];
  const gateway = new ResponsesSteeringGateway();
  const worker = new ResponsesSteeringWorker({ gateway, reporter: { async registerAttempt(attempt) { reports.push({ kind: "attempt", attempt }); }, async reportReceipt(receipt) { reports.push({ kind: "receipt", receipt }); } } });
  await worker.registerAttempt({ attempt_id: "attempt-owner", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", lane_id: "lane-owner", response_id: "resp-owner", mode: "single_agent", model_supports_steering: true }, { send(frame) { frames.push(JSON.parse(frame)); } });
  const handler = createSteeringWorkerCommandHandler({ worker, workerToken: "worker-secret" });
  assert.equal((await handler(new Request("https://worker/v1/steering/commands", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" }))).status, 401);
  const accepted = await handler(new Request("https://worker/v1/steering/commands", { method: "POST", headers: { authorization: "Bearer worker-secret" }, body: JSON.stringify({ attempt_id: "attempt-owner", request: { client_steering_id: "steer-owner", input: [{ role: "user", content: [{ type: "input_text", text: "Use a single bridge." }] }] } }) }));
  assert.equal(accepted.status, 202);
  assert.equal(frames[0].type, "response.steer");
  assert.equal(reports.filter((report) => report.kind === "receipt").length, 1);

  const requests = [];
  const reporter = createCoordinatorSteeringReporter({ coordinatorUrl: "https://coordinator", workerToken: "worker-secret", fetcher: async (url, init) => { requests.push({ url, init }); return new Response("{}", { status: 202 }); } });
  await reporter.registerAttempt({ encounter_id: "encounter-alpha", work_id: "arena-shell" });
  await reporter.reportReceipt({ encounter_id: "encounter-alpha", work_id: "arena-shell" });
  assert.ok(requests.every(({ init }) => init.headers.authorization === "Bearer worker-secret"));
  assert.match(requests[1].url, /steering-receipts$/);
});

test("completed attempts use an explicit continuation while unsupported and pending modes never rerun tools", async () => {
  const lane = new FakeWebSocketLane();
  const gateway = new ResponsesSteeringGateway();
  const request = { client_steering_id: "steer-beta", input: [{ role: "user", content: [{ type: "input_file", file_id: "file-brief" }] }] };
  await gateway.recordAttempt({
    attempt_id: "attempt-complete", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one",
    lane_id: "lane-complete", response_id: "resp-complete", response_status: "completed", mode: "single_agent", model_supports_steering: true,
  }, lane);
  assert.equal((await gateway.requestSteer("attempt-complete", request)).status, "queued");
  assert.deepEqual(lane.frames[0], { type: "response.create", previous_response_id: "resp-complete", input: request.input });
  await gateway.handleServerEvent("lane-complete", { type: "response.required_input", previous_response_id: "resp-complete" });
  assert.equal((await gateway.getReceipt("steer-beta")).status, "required_input");
  assert.equal(lane.frames.length, 1);

  const pendingLane = new FakeWebSocketLane();
  await gateway.recordAttempt({ attempt_id: "attempt-pending", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", lane_id: "lane-pending", response_id: "resp-pending", mode: "single_agent", model_supports_steering: true }, pendingLane);
  await gateway.requestSteer("attempt-pending", { ...request, client_steering_id: "steer-pending" });
  await gateway.handleServerEvent("lane-pending", { type: "response.incomplete", response: { previous_response_id: "resp-pending", incomplete_details: { reason: "steered" } } });
  assert.equal((await gateway.getReceipt("steer-pending")).status, "pending");
  assert.equal(pendingLane.frames.length, 1);

  await gateway.recordAttempt({
    attempt_id: "attempt-multi", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one",
    lane_id: "lane-multi", response_id: "resp-multi", mode: "multi_agent", model_supports_steering: true,
  }, new FakeWebSocketLane());
  const unsupported = await gateway.requestSteer("attempt-multi", { ...request, client_steering_id: "steer-multi" });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.error_code, "multi_agent_mode_unsupported");

  for (const [attemptId, flags, reason] of [
    ["attempt-model", { model_supports_steering: false }, "model_unsupported"],
    ["attempt-conversation", { conversation_mode: true }, "conversation_mode_unsupported"],
    ["attempt-compaction", { automatic_compaction: true }, "automatic_compaction_unsupported"],
  ]) {
    await gateway.recordAttempt({ attempt_id: attemptId, encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", lane_id: `lane-${attemptId}`, response_id: `resp-${attemptId}`, mode: "single_agent", model_supports_steering: true, ...flags }, new FakeWebSocketLane());
    const rejected = await gateway.requestSteer(attemptId, { ...request, client_steering_id: `steer-${attemptId}` });
    assert.equal(rejected.status, "unsupported");
    assert.equal(rejected.error_code, reason);
  }
});
