import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemorySteeringStore, ResponsesSteeringGateway, ResponsesSteeringWorker, createCoordinatorSteeringReporter, createSteeringWorkerCommandHandler } from "../src/responses-steering.js";
import { JsonSteeringStore } from "../src/responses-steering-worker-store.js";

class Lane { constructor() { this.frames = []; this.listeners = new Map(); } send(frame) { this.frames.push(JSON.parse(frame)); } addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); } emit(type, value) { for (const callback of this.listeners.get(type) || []) callback(type === "message" ? { data: JSON.stringify(value) } : {}); } }
const attempt = (overrides = {}) => ({ attempt_id: "attempt-alpha", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", owner_id: "owner-one", lane_id: "lane-alpha", response_id: "resp-original", mode: "single_agent", model_supports_steering: true, ...overrides });
const request = (id = "steer-alpha") => ({ client_steering_id: id, input: [{ role: "user", content: [{ type: "input_text", text: "Prefer a flooded courtyard." }] }] });
const drain = () => new Promise((resolve) => setImmediate(resolve));

test("strict nested steer correlation commits only at a successor", async () => {
  const lane = new Lane(); const gateway = new ResponsesSteeringGateway(); await gateway.recordAttempt(attempt(), lane);
  await gateway.requestSteer("attempt-alpha", request()); assert.equal(lane.frames[0].type, "response.steer");
  await gateway.handleServerEvent("lane-alpha", { type: "response.steer.accepted", steer: { id: "server-1", previous_response_id: "resp-original" } });
  assert.equal((await gateway.getReceipt("steer-alpha")).status, "accepted");
  await gateway.handleServerEvent("lane-alpha", { type: "response.steer.pending", steer: { id: "wrong-server", previous_response_id: "resp-original" } });
  await gateway.handleServerEvent("lane-alpha", { type: "response.failed", response: { previous_response_id: "resp-original" } });
  assert.equal((await gateway.getReceipt("steer-alpha")).status, "accepted");
  await gateway.handleServerEvent("lane-alpha", { type: "response.created", response: { id: "resp-next", previous_response_id: "resp-original" } });
  assert.equal((await gateway.getReceipt("steer-alpha")).status, "committed");
});

test("pending carries official required-input fields and durable exact result matching", async () => {
  const lane = new Lane(); const store = new InMemorySteeringStore(); const gateway = new ResponsesSteeringGateway({ store }); await gateway.recordAttempt(attempt(), lane); await gateway.requestSteer("attempt-alpha", request());
  await gateway.handleServerEvent("lane-alpha", { type: "response.steer.accepted", steer: { id: "server-1", previous_response_id: "resp-original" } });
  await gateway.handleServerEvent("lane-alpha", { type: "response.steer.pending", steer: { id: "server-1", previous_response_id: "resp-original" }, reason: "required_input", required_input: [{ call_id: "call-1" }, { approval_request_id: "approval-1" }] });
  assert.equal((await gateway.getReceipt("steer-alpha")).status, "required_input");
  await assert.rejects(gateway.saveRequiredInputResult("attempt-alpha", { type: "function_call_output", call_id: "wrong", output: "no" }), /scope/);
  await gateway.saveRequiredInputResult("attempt-alpha", { type: "function_call_output", call_id: "call-1", output: "saved" });
  await gateway.saveRequiredInputResult("attempt-alpha", { type: "approval_response", approval_request_id: "approval-1", approved: true });
  const restarted = new ResponsesSteeringGateway({ store }); restarted.attachLane("lane-alpha", lane); await restarted.resolveRequiredInput("attempt-alpha");
  assert.deepEqual(lane.frames.at(-1).input.map((item) => item.type), ["function_call_output", "approval_response"]);
  const count = lane.frames.length; await restarted.resolveRequiredInput("attempt-alpha"); assert.equal(lane.frames.length, count);
});

test("claiming a receipt is atomic under competing user requests", async () => {
  const lane = new Lane(); const gateway = new ResponsesSteeringGateway(); await gateway.recordAttempt(attempt(), lane);
  const results = await Promise.allSettled([gateway.requestSteer("attempt-alpha", request("steer-one")), gateway.requestSteer("attempt-alpha", request("steer-two"))]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1); assert.equal((await gateway.listReceipts()).length, 1);
});

test("worker lane listeners report message and disconnect receipts without a coordinator socket", async () => {
  const reports = []; const lane = new Lane(); const worker = new ResponsesSteeringWorker({ ownerId: "owner-one", reporter: { async registerAttempt() {}, async reportReceipt(receipt) { reports.push(receipt); } } });
  await worker.registerAttempt(attempt(), lane); await worker.acceptCommand({ owner_id: "owner-one", attempt_id: "attempt-alpha", request: request() });
  lane.emit("message", { type: "response.steer.accepted", steer: { id: "server-1", previous_response_id: "resp-original" } }); await drain();
  lane.emit("close"); await drain(); assert.ok(reports.some((item) => item.status === "accepted")); assert.ok(reports.some((item) => item.error_code === "steering_transport_reconnect_uncertain"));
});

test("single owner command and report credentials remain separate", async () => {
  const lane = new Lane(); const worker = new ResponsesSteeringWorker({ ownerId: "owner-one", reporter: { async registerAttempt() {}, async reportReceipt() {} } }); await worker.registerAttempt(attempt(), lane);
  const handler = createSteeringWorkerCommandHandler({ worker, commandToken: "command-secret" });
  assert.equal((await handler(new Request("https://worker", { method: "POST", headers: { authorization: "Bearer report-secret" }, body: "{}" }))).status, 401);
  assert.equal((await handler(new Request("https://worker", { method: "POST", headers: { authorization: "Bearer command-secret" }, body: JSON.stringify({ owner_id: "owner-one", attempt_id: "attempt-alpha", request: request() }) }))).status, 202);
  const sent = []; const reporter = createCoordinatorSteeringReporter({ coordinatorUrl: "https://coordinator", reportToken: "report-secret", ownerId: "owner-one", fetcher: async (_url, init) => { sent.push(init); return new Response("", { status: 202 }); } }); await reporter.reportReceipt({ encounter_id: "encounter-alpha", work_id: "arena-shell" }); assert.equal(sent[0].headers.authorization, "Bearer report-secret"); assert.equal(sent[0].headers["x-steering-owner-id"], "owner-one");
});

test("the worker-process JSON store survives restart with required-input results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myth-steering-")); const stateFile = join(directory, "state.json"); const lane = new Lane();
  try {
    const first = new ResponsesSteeringGateway({ store: await JsonSteeringStore.open(stateFile) }); await first.recordAttempt(attempt(), lane); await first.requestSteer("attempt-alpha", request());
    await first.handleServerEvent("lane-alpha", { type: "response.steer.accepted", steer: { id: "server-1", previous_response_id: "resp-original" } });
    await first.handleServerEvent("lane-alpha", { type: "response.steer.pending", steer: { id: "server-1", previous_response_id: "resp-original" }, reason: "required_input", required_input: [{ call_id: "call-1" }] });
    await first.saveRequiredInputResult("attempt-alpha", { type: "function_call_output", call_id: "call-1", output: "persisted" });
    const restarted = new ResponsesSteeringGateway({ store: await JsonSteeringStore.open(stateFile) }); restarted.attachLane("lane-alpha", lane); await restarted.resolveRequiredInput("attempt-alpha");
    assert.equal(lane.frames.at(-1).input[0].output, "persisted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
