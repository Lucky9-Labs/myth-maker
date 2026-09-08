import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesSteeringGateway } from "../src/responses-steering.js";

class FakeWebSocketLane {
  constructor() { this.frames = []; }
  send(frame) { this.frames.push(JSON.parse(frame)); }
}

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

  await gateway.handleServerEvent("lane-alpha", { type: "response.steer.accepted", previous_response_id: "resp-original" });
  assert.equal((await gateway.getReceipt("steer-alpha")).status, "accepted");
  await gateway.handleServerEvent("lane-alpha", { type: "response.created", response: { id: "resp-successor", previous_response_id: "resp-original" } });
  const committed = await gateway.getReceipt("steer-alpha");
  assert.equal(committed.status, "committed");
  assert.equal(committed.successor_response_id, "resp-successor");
  await gateway.handleServerEvent("lane-alpha", { type: "response.completed", response: { id: "resp-successor" } });
  await gateway.requestSteer("attempt-alpha", {
    client_steering_id: "steer-after-complete",
    input: [{ role: "user", content: [{ type: "input_text", text: "Keep the flooded courtyard." }] }],
  });
  assert.equal(lane.frames[1].type, "response.create");
  assert.equal(lane.frames[1].previous_response_id, "resp-successor");
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

  await gateway.recordAttempt({
    attempt_id: "attempt-multi", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one",
    lane_id: "lane-multi", response_id: "resp-multi", mode: "multi_agent", model_supports_steering: true,
  }, new FakeWebSocketLane());
  const unsupported = await gateway.requestSteer("attempt-multi", { ...request, client_steering_id: "steer-multi" });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.error_code, "multi_agent_mode_unsupported");
});
