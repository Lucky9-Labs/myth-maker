import assert from "node:assert/strict";
import test from "node:test";
import { assembleEncounterPackage, freezeEncounterPackage } from "../src/encounter-package-assembler.js";
import worker, { EncounterCoordinator } from "../src/worker.js";
import { ResponsesSteeringGateway, ResponsesSteeringWorker } from "../src/responses-steering.js";

const baseWorkOrder = {
  schema_version: "1",
  work_id: "arena-shell",
  encounter_id: "encounter-alpha",
  lane: "arena",
  deadline_at: "2026-09-08T20:00:00.000Z",
  requested_provides: ["arena.shell"],
  host_capabilities: {
    schema_version: "1",
    host_id: "mech-host",
    host_build: "test-build",
    platform: "macos",
    scripting_backend: "il2cpp",
    execution_kinds: ["recipe"],
    loaders: ["recipe-loader"],
    contracts: ["encounter.module.v1"],
    limits: { memory_mb: 512, preload_seconds: 30 },
  },
  input_module_ids: [],
  attempt: 1,
};

function playablePackage() {
  return assembleEncounterPackage({
    host: baseWorkOrder.host_capabilities,
    encounterId: "encounter-alpha",
    packageId: "package-alpha",
    baselineModules: [{
      schema_version: "1",
      module_id: "baseline-core",
      revision: 1,
      execution_kind: "recipe",
      provides: ["combat.core"],
      requires: [],
      conflicts: [],
      compatibility: { host_contract_version: "1" },
      quality: { tier: 0, score: 1 },
      inline_recipe: { kind: "baseline" },
      fallback_module_ids: [],
    }],
    assembledAt: "2026-09-08T19:30:00.000Z",
  }).package;
}

function workOrder(overrides = {}) {
  return { ...structuredClone(baseWorkOrder), ...overrides };
}

function storage() {
  const values = new Map();
  const store = { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value) };
  let pending = Promise.resolve();
  return {
    ...store,
    transaction(callback) {
      const transaction = pending.then(() => callback(store));
      pending = transaction.catch(() => undefined);
      return transaction;
    },
  };
}

function coordinator(steeringGateway, steeringTransport) {
  return new EncounterCoordinator({ storage: storage() }, {
    WORK_DISPATCH_URL: "https://workers.example/dispatch",
    WORK_DISPATCH_TOKEN: "dispatch",
  }, { steeringGateway, steeringTransport });
}

function submit(instance, order, idempotencyKey = "encounter-work-0001") {
  return instance.fetch(new Request("https://coordinator/work-items", {
    method: "POST",
    body: JSON.stringify({ idempotency_key: idempotencyKey, work_order: order }),
  }));
}

function event(workId, sequence, kind, extra = {}) {
  return {
    schema_version: "1",
    event_id: `event-${String(sequence).padStart(4, "0")}-${kind}`,
    work_id: workId,
    encounter_id: "encounter-alpha",
    worker_id: "worker-one",
    sequence,
    occurred_at: "2026-09-08T19:00:00.000Z",
    kind,
    ...extra,
  };
}

function appendEvent(instance, value) {
  return instance.fetch(new Request(`https://coordinator/work-items/${value.work_id}/events`, {
    method: "POST",
    body: JSON.stringify(value),
  }));
}

async function body(result) {
  return result.json();
}

test("the edge route scopes each work submission to its encounter", async () => {
  let seenName;
  let proxied;
  const payload = { idempotency_key: "encounter-work-0001", work_order: workOrder() };
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { seenName = name; return name; },
      get() { return { fetch: async (_url, init) => { proxied = JSON.parse(init.body); return new Response("{}", { status: 202 }); } }; },
    },
  };
  const result = await worker.fetch(new Request("https://runtime/v1/encounters/encounter-alpha/work-items", {
    method: "POST",
    headers: { authorization: "Bearer ingress", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
  assert.equal(result.status, 202);
  assert.equal(seenName, "encounter-alpha");
  assert.deepEqual(proxied, payload);
});

test("the edge route rejects a work order for a different encounter", async () => {
  let called = false;
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { return name; },
      get() { called = true; return { fetch: async () => new Response("{}") }; },
    },
  };
  const result = await worker.fetch(new Request("https://runtime/v1/encounters/encounter-alpha/work-items", {
    method: "POST",
    headers: { authorization: "Bearer ingress", "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: "encounter-work-0001", work_order: workOrder({ encounter_id: "encounter-beta" }) }),
  }), env);
  assert.equal(result.status, 409);
  assert.equal(called, true);
  assert.equal((await body(result)).error, "encounter_path_mismatch");
});

test("only the dedicated steering-worker token can report attempts or receipts", async () => {
  const calls = [];
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    STEERING_WORKER_TOKEN: "steering-worker",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { return name; },
      get() { return { fetch: async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 202 }); } }; },
    },
  };
  const url = "https://runtime/v1/encounters/encounter-alpha/work-items/arena-shell/steering-attempts";
  const bodyValue = JSON.stringify({ attempt_id: "attempt-alpha" });
  assert.equal((await worker.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer ingress" }, body: bodyValue }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer steering-worker" }, body: bodyValue }), env)).status, 202);
  assert.equal(calls.length, 1);
});

test("the coordinator dispatches a v1 work item through the adapter", async () => {
  const oldFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (_url, init) => {
    dispatches.push({ body: JSON.parse(init.body), headers: init.headers });
    return new Response("accepted", { status: 202 });
  };
  try {
    const result = await submit(coordinator(), workOrder());
    assert.equal(result.status, 202);
    assert.deepEqual(dispatches[0].body, workOrder());
    assert.equal(dispatches[0].headers.authorization, "Bearer dispatch");
    assert.equal(dispatches[0].headers["x-work-id"], "arena-shell");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("steering routes persist worker-reported receipts but do not treat accepted as committed", async () => {
    const oldFetch = globalThis.fetch;
    const frames = [];
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const gateway = new ResponsesSteeringGateway();
    let worker;
    const instance = coordinator(gateway, { send(command) { return worker.acceptCommand(command); } });
    worker = new ResponsesSteeringWorker({
      gateway: new ResponsesSteeringGateway(),
      reporter: {
        registerAttempt(attempt) { return instance.fetch(new Request(`https://coordinator/work-items/${attempt.work_id}/steering-attempts`, { method: "POST", body: JSON.stringify(attempt) })); },
        reportReceipt(receipt) { return instance.fetch(new Request(`https://coordinator/work-items/${receipt.work_id}/steering-receipts`, { method: "POST", body: JSON.stringify(receipt) })); },
      },
    });
    await submit(instance, workOrder());
    await appendEvent(instance, event("arena-shell", 0, "accepted"));
    const attempt = {
      attempt_id: "attempt-alpha", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one",
      lane_id: "lane-alpha", response_id: "resp-original", mode: "single_agent", model_supports_steering: true,
    };
    await worker.registerAttempt(attempt, { send(frame) { frames.push(JSON.parse(frame)); } });
    const request = new Request("https://coordinator/work-items/arena-shell/steers", {
      method: "POST",
      body: JSON.stringify({ attempt_id: "attempt-alpha", client_steering_id: "steer-alpha", input: [{ role: "user", content: [{ type: "input_text", text: "Use more cover." }] }] }),
    });
    const queued = await instance.fetch(request);
    const queuedBody = await body(queued);
    assert.equal(queued.status, 202, JSON.stringify(queuedBody));
    assert.equal(queuedBody.receipt.status, "queued");
    assert.equal(frames[0].type, "response.steer");
    await worker.receive("lane-alpha", { type: "response.steer.accepted", steer: { id: "steer-server-01", previous_response_id: "resp-original" } });
    const afterAcceptance = await body(await instance.fetch(new Request("https://coordinator/work-items/arena-shell/steers/steer-alpha")));
    assert.equal(afterAcceptance.receipt.status, "accepted");
    await worker.receive("lane-alpha", { type: "response.created", response: { id: "resp-next", previous_response_id: "resp-original" } });
    const listed = await body(await instance.fetch(new Request("https://coordinator/work-items/arena-shell/steers")));
    assert.equal(listed.receipts[0].status, "committed");
    assert.equal(listed.receipts[0].successor_response_id, "resp-next");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("encounter steering appends a planner revision and creates fresh work instead of mutating prior work", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const result = await instance.fetch(new Request("https://coordinator/steers", {
      method: "POST",
      body: JSON.stringify({
        client_steering_id: "planner-steer-01",
        directive: "Prioritize readable cover routes.",
        work_submissions: [{ idempotency_key: "encounter-work-0003", work_order: workOrder({ work_id: "cover-plan", lane: "combat", requested_provides: ["combat.cover"], attempt: 2 }) }],
      }),
    }));
    assert.equal(result.status, 202);
    const bodyValue = await body(result);
    assert.equal(bodyValue.planner_directive.revision, 1);
    assert.equal(bodyValue.work_items[0].work_id, "cover-plan");
    const directives = await body(await instance.fetch(new Request("https://coordinator/steers")));
    assert.deepEqual(directives.planner_directives.map((item) => item.work_ids), [["cover-plan"]]);
    const status = await body(await instance.fetch(new Request("https://coordinator/status")));
    assert.deepEqual(status.work_items.map((item) => item.work_id).sort(), ["arena-shell", "cover-plan"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("an invalid planner batch leaves no directive or partial work attempts behind", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const duplicate = workOrder({ work_id: "duplicate-plan", lane: "combat", requested_provides: ["combat.cover"], attempt: 2 });
    const result = await instance.fetch(new Request("https://coordinator/steers", {
      method: "POST",
      body: JSON.stringify({ client_steering_id: "planner-steer-02", directive: "Avoid partial plans.", work_submissions: [
        { idempotency_key: "encounter-work-0004", work_order: duplicate },
        { idempotency_key: "encounter-work-0005", work_order: duplicate },
      ] }),
    }));
    assert.equal(result.status, 409);
    assert.equal((await body(result)).error, "planner_work_attempt_not_unique");
    assert.deepEqual((await body(await instance.fetch(new Request("https://coordinator/steers")))).planner_directives, []);
    assert.deepEqual((await body(await instance.fetch(new Request("https://coordinator/status")))).work_items.map((item) => item.work_id), ["arena-shell"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Durable Object steering receipt and event indexes survive coordinator reinstantiation", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const state = { storage: storage() };
    const transport = { async send() {} };
    const first = new EncounterCoordinator(state, { WORK_DISPATCH_URL: "https://workers.example/dispatch", WORK_DISPATCH_TOKEN: "dispatch" }, { steeringTransport: transport });
    await submit(first, workOrder());
    await appendEvent(first, event("arena-shell", 0, "accepted"));
    const attempt = { attempt_id: "attempt-restart", encounter_id: "encounter-alpha", work_id: "arena-shell", worker_id: "worker-one", lane_id: "lane-restart", response_id: "resp-restart", mode: "single_agent", model_supports_steering: true };
    assert.equal((await first.fetch(new Request("https://coordinator/work-items/arena-shell/steering-attempts", { method: "POST", body: JSON.stringify(attempt) }))).status, 201);
    assert.equal((await first.fetch(new Request("https://coordinator/work-items/arena-shell/steers", { method: "POST", body: JSON.stringify({ attempt_id: "attempt-restart", client_steering_id: "steer-restart", input: [{ role: "user", content: [{ type: "input_text", text: "Persist this." }] }] }) }))).status, 202);
    const restarted = new EncounterCoordinator(state, { WORK_DISPATCH_URL: "https://workers.example/dispatch", WORK_DISPATCH_TOKEN: "dispatch" }, { steeringTransport: transport });
    const receipt = await body(await restarted.fetch(new Request("https://coordinator/work-items/arena-shell/steers/steer-restart")));
    assert.equal(receipt.receipt.status, "queued");
    assert.equal(receipt.receipt.events.length, 1);
    const listed = await body(await restarted.fetch(new Request("https://coordinator/work-items/arena-shell/steers")));
    assert.equal(listed.receipts.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("idempotency replays an identical request and rejects a fingerprint mismatch", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches += 1; return new Response("accepted", { status: 202 }); };
  try {
    const instance = coordinator();
    const first = await submit(instance, workOrder());
    const replay = await submit(instance, workOrder());
    const mismatch = await submit(instance, workOrder({ lane: "combat" }));
    assert.equal(first.status, 202);
    assert.equal(replay.status, 202);
    assert.equal(mismatch.status, 409);
    assert.equal((await body(mismatch)).error, "idempotency_key_reused_with_different_request");
    assert.equal(dispatches, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("independent work items in one encounter dispatch without a component-wide busy lock", async () => {
  const oldFetch = globalThis.fetch;
  const dispatched = [];
  let releaseDispatch;
  const bothStarted = new Promise((resolve) => { releaseDispatch = resolve; });
  let releaseResponses;
  const responsesReleased = new Promise((resolve) => { releaseResponses = resolve; });
  globalThis.fetch = async (_url, init) => {
    dispatched.push(JSON.parse(init.body).work_id);
    if (dispatched.length === 2) releaseDispatch();
    await responsesReleased;
    return new Response("accepted", { status: 202 });
  };
  try {
    const instance = coordinator();
    const submissions = Promise.all([
      submit(instance, workOrder(), "encounter-work-0001"),
      submit(instance, workOrder({ work_id: "combat-plan", lane: "combat", requested_provides: ["combat.attack"] }), "encounter-work-0002"),
    ]);
    await bothStarted;
    releaseResponses();
    const [first, second] = await submissions;
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.deepEqual(dispatched.sort(), ["arena-shell", "combat-plan"]);
    const status = await body(await instance.fetch(new Request("https://coordinator/status")));
    assert.equal(status.work_items.length, 2);
    assert.deepEqual(status.work_items.map((item) => item.status).sort(), ["queued", "queued"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a dispatch failure is durably replayed without a second external dispatch", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches += 1; return new Response("unavailable", { status: 503 }); };
  try {
    const instance = coordinator();
    const first = await submit(instance, workOrder());
    const replay = await submit(instance, workOrder());
    assert.equal(first.status, 502);
    assert.equal(replay.status, 502);
    assert.equal(dispatches, 1);
    assert.equal((await body(replay)).work_item.status, "blocked");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a restarted coordinator recovers a journaled dispatch with the stable work ID", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  let releaseFirstDispatch;
  const firstDispatchResponse = new Promise((resolve) => { releaseFirstDispatch = resolve; });
  let markFirstDispatch;
  const firstDispatchStarted = new Promise((resolve) => { markFirstDispatch = resolve; });
  globalThis.fetch = async () => {
    dispatches += 1;
    if (dispatches === 1) {
      markFirstDispatch();
      return firstDispatchResponse;
    }
    return new Response("accepted", { status: 202 });
  };
  try {
    const state = { storage: storage() };
    const original = new EncounterCoordinator(state, {
      WORK_DISPATCH_URL: "https://workers.example/dispatch",
      WORK_DISPATCH_TOKEN: "dispatch",
    });
    const interrupted = submit(original, workOrder());
    await firstDispatchStarted;
    const restarted = new EncounterCoordinator(state, {
      WORK_DISPATCH_URL: "https://workers.example/dispatch",
      WORK_DISPATCH_TOKEN: "dispatch",
    });
    const status = await body(await restarted.fetch(new Request("https://coordinator/status")));
    assert.equal(dispatches, 2);
    assert.equal(status.work_items[0].status, "queued");
    releaseFirstDispatch(new Response("accepted", { status: 202 }));
    await interrupted;
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("dependencies and resource leases defer work until the prerequisite completes", async () => {
  const oldFetch = globalThis.fetch;
  const dispatched = [];
  globalThis.fetch = async (_url, init) => { dispatched.push(JSON.parse(init.body).work_id); return new Response("accepted", { status: 202 }); };
  try {
    const instance = coordinator();
    await submit(instance, workOrder({ resource_leases: ["host.scene"] }));
    const dependent = await submit(instance, workOrder({
      work_id: "combat-plan",
      lane: "combat",
      requested_provides: ["combat.attack"],
      depends_on_work_ids: ["arena-shell"],
      resource_leases: ["host.scene"],
    }), "encounter-work-0002");
    assert.equal((await body(dependent)).work_item.status, "waiting");
    assert.deepEqual(dispatched, ["arena-shell"]);
    await appendEvent(instance, event("arena-shell", 0, "accepted"));
    await appendEvent(instance, event("arena-shell", 1, "started"));
    await appendEvent(instance, event("arena-shell", 2, "completed"));
    assert.deepEqual(dispatched.sort(), ["arena-shell", "combat-plan"]);
    const status = await body(await instance.fetch(new Request("https://coordinator/status")));
    assert.equal(status.work_items.find((item) => item.work_id === "combat-plan").status, "queued");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("worker events are append-only, ordered, and observable", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    assert.equal((await appendEvent(instance, event("arena-shell", 0, "accepted"))).status, 202);
    assert.equal((await appendEvent(instance, event("arena-shell", 1, "started"))).status, 202);
    const outOfOrder = await appendEvent(instance, event("arena-shell", 1, "heartbeat", { event_id: "event-duplicate-sequence" }));
    assert.equal(outOfOrder.status, 409);
    assert.equal((await body(outOfOrder)).error, "worker_event_out_of_order");
    const events = await body(await instance.fetch(new Request("https://coordinator/work-items/arena-shell/events")));
    assert.deepEqual(events.events.map((item) => item.kind), ["accepted", "started"]);
    assert.equal(events.work_item.status, "running");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("worker lifecycle prevents regressions and binds event attribution to the accepted worker", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const premature = await appendEvent(instance, event("arena-shell", 0, "progress"));
    assert.equal(premature.status, 409);
    assert.equal((await body(premature)).error, "illegal_worker_event_transition");
    await appendEvent(instance, event("arena-shell", 0, "accepted"));
    const wrongWorker = await appendEvent(instance, event("arena-shell", 1, "started", { worker_id: "worker-two" }));
    assert.equal(wrongWorker.status, 409);
    assert.equal((await body(wrongWorker)).error, "worker_identity_mismatch");
    await appendEvent(instance, event("arena-shell", 1, "started"));
    const regression = await appendEvent(instance, event("arena-shell", 2, "accepted"));
    assert.equal(regression.status, 409);
    assert.equal((await body(regression)).error, "illegal_worker_event_transition");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a failed worker event is visible and terminal", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const failed = await appendEvent(instance, event("arena-shell", 0, "failed", { error_code: "worker_unavailable", retryable: true }));
    assert.equal(failed.status, 202);
    assert.deepEqual((await body(failed)).work_item.failure, { error_code: "worker_unavailable", retryable: true });
    const afterFailure = await appendEvent(instance, event("arena-shell", 1, "heartbeat"));
    assert.equal(afterFailure.status, 409);
    assert.equal((await body(afterFailure)).error, "work_item_terminal");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("freezing persists one immutable assembler-supplied package", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const packageToFreeze = playablePackage();
    const tampered = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify({ package: { ...packageToFreeze, manifest_sha256: "0".repeat(64) } }),
    }));
    assert.equal(tampered.status, 400);
    const firstFreeze = await instance.fetch(new Request("https://coordinator/freeze", { method: "POST", body: JSON.stringify({ package: packageToFreeze }) }));
    const frozen = await body(firstFreeze);
    const replayFreeze = await instance.fetch(new Request("https://coordinator/freeze", { method: "POST" }));
    assert.equal(firstFreeze.status, 201);
    assert.equal(replayFreeze.status, 200);
    assert.deepEqual(await body(replayFreeze), frozen);
    assert.equal(frozen.state, "frozen");
    assert.equal(frozen.package_id, packageToFreeze.package_id);
    assert.ok(frozen.frozen_at);
    assert.equal((await submit(instance, workOrder({ work_id: "late-work" }), "encounter-work-late")).status, 409);
    assert.equal((await appendEvent(instance, event("arena-shell", 0, "accepted"))).status, 409);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("freezing accepts only a hash-valid pre-frozen assembler package", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const frozenPackage = freezeEncounterPackage(playablePackage(), "2026-09-08T19:35:00.000Z");
    const tampered = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify({ package: { ...frozenPackage, manifest_sha256: "0".repeat(64) } }),
    }));
    assert.equal(tampered.status, 400);
    const accepted = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify({ package: frozenPackage }),
    }));
    assert.equal(accepted.status, 201);
    assert.deepEqual(await body(accepted), frozenPackage);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
