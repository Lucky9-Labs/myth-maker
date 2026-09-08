import assert from "node:assert/strict";
import test from "node:test";
import worker, { EncounterCoordinator } from "../src/worker.js";

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

const playablePackage = {
  schema_version: "1",
  package_id: "package-alpha",
  encounter_id: "encounter-alpha",
  revision: 1,
  state: "ready",
  assembled_at: "2026-09-08T19:30:00.000Z",
  module_ids: ["baseline-core"],
  manifest_sha256: "a".repeat(64),
  fallback_provenance: { used_fallback: true, module_ids: ["baseline-core"] },
};

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

function coordinator() {
  return new EncounterCoordinator({ storage: storage() }, {
    WORK_DISPATCH_URL: "https://workers.example/dispatch",
    WORK_DISPATCH_TOKEN: "dispatch",
  });
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
    await appendEvent(instance, event("arena-shell", 0, "completed"));
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
    const firstFreeze = await instance.fetch(new Request("https://coordinator/freeze", { method: "POST", body: JSON.stringify({ package: playablePackage }) }));
    const frozen = await body(firstFreeze);
    const replayFreeze = await instance.fetch(new Request("https://coordinator/freeze", { method: "POST" }));
    assert.equal(firstFreeze.status, 201);
    assert.equal(replayFreeze.status, 200);
    assert.deepEqual(await body(replayFreeze), frozen);
    assert.equal(frozen.state, "frozen");
    assert.equal(frozen.package_id, playablePackage.package_id);
    assert.ok(frozen.frozen_at);
    assert.equal((await submit(instance, workOrder({ work_id: "late-work" }), "encounter-work-late")).status, 409);
    assert.equal((await appendEvent(instance, event("arena-shell", 0, "accepted"))).status, 409);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
