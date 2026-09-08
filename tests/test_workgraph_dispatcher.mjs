import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planEncounterWork } from "../src/workgraph-planner.js";
import { EncounterDispatcher, InMemoryReceiptStore, JsonReceiptStore } from "../src/encounter-dispatcher.js";
import { LocalWorkerBackend } from "../src/local-worker-backend.js";
import { createRailwayDispatchHandler } from "../src/railway-dispatcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const hostCapabilities = {
  schema_version: "1",
  host_id: "demo-host",
  host_build: "2026.09.08",
  platform: "linux",
  scripting_backend: "il2cpp",
  execution_kinds: ["recipe"],
  loaders: ["recipe-loader"],
  contracts: ["encounter-module.v1"],
  limits: { memory_mb: 2048, preload_seconds: 30 },
};

const fixture = {
  schema_version: "1",
  encounter_id: "tideglass-reef",
  seed: 17,
  deadline_at: "2026-09-09T12:00:00Z",
  host_capabilities: hostCapabilities,
  objective: { kind: "survive", parameters: { seconds: 90 } },
  arena_envelope: {
    bounds: { width: 30, height: 12, depth: 30 },
    navigation_profiles: ["ground"],
  },
  desired_roles: ["pressure", "support"],
};

test("planner deterministically produces generic dependency-aware v1 lanes", () => {
  const first = planEncounterWork(fixture);
  const second = planEncounterWork(structuredClone(fixture));

  assert.deepEqual(second, first);
  assert.deepEqual(first.work_orders.map((order) => order.lane), [
    "body-source", "animation-recipe", "combat-recipe", "validation",
  ]);
  assert.ok(first.work_orders.slice(0, 3).every((order) => order.depends_on_work_ids.length === 0));
  assert.deepEqual(first.work_orders.at(-1).depends_on_work_ids,
                   first.work_orders.slice(0, 3).map((order) => order.work_id));
  assert.ok(first.work_orders.every((order) => order.schema_version === "1"));
  const revised = structuredClone(fixture);
  revised.objective.parameters.seconds = 120;
  assert.notDeepEqual(planEncounterWork(revised).work_orders.map((order) => order.work_id),
                      first.work_orders.map((order) => order.work_id));
});

test("dispatcher launches independent lanes in concurrent local processes and deduplicates receipts", async () => {
  const graph = planEncounterWork(fixture);
  const dispatcher = new EncounterDispatcher({
    backend: new LocalWorkerBackend({ workDurationMs: 180 }),
  });

  const result = await dispatcher.dispatch(graph);
  const roots = graph.work_orders.slice(0, 3);
  const eventsByWork = new Map(roots.map((order) => [
    order.work_id,
    result.events.filter((event) => event.work_id === order.work_id),
  ]));
  const started = [...eventsByWork.values()].map((events) => Date.parse(events.find((event) => event.kind === "started").occurred_at));
  const completed = [...eventsByWork.values()].map((events) => Date.parse(events.find((event) => event.kind === "completed").occurred_at));

  assert.equal(result.receipts.length, 4);
  assert.ok(Math.max(...started) < Math.min(...completed), "root worker timestamps must overlap");
  for (const events of eventsByWork.values()) {
    assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2]);
  }

  const duplicate = await dispatcher.dispatch(graph);
  assert.equal(duplicate.deduplicated_work_ids.length, 4);
  assert.equal(duplicate.events.length, 0);
  assert.deepEqual(duplicate.receipts.map((receipt) => receipt.work_id).sort(),
                   result.receipts.map((receipt) => receipt.work_id).sort());
});

test("runnable CLI prints a graph, ordered events, receipts, and overlap evidence", async () => {
  const child = spawn(process.execPath, [path.join(here, "..", "examples", "run-workgraph.mjs")], {
    cwd: path.join(here, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");

  assert.equal(code, 0, stderr);
  const proof = JSON.parse(stdout);
  assert.equal(proof.graph.work_orders.length, 4);
  assert.equal(proof.receipts.length, 4);
  assert.equal(proof.overlap.observed, true);
  assert.ok(proof.events.length >= 12);
});

test("Railway control-plane handler matches Cloudflare's stable x-work-id delivery and replays receipts", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const forwarded = [];
  const handler = createRailwayDispatchHandler({
    dispatcher: new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 20 }) }),
    dispatchToken: "dispatch",
    eventSink: { append: async (workId, event) => forwarded.push({ workId, event }) },
  });
  const request = () => new Request("https://railway.example/dispatch", {
    method: "POST", headers: { authorization: "Bearer dispatch", "content-type": "application/json", "x-work-id": order.work_id }, body: JSON.stringify(order),
  });

  const first = await handler(request());
  const replay = await handler(request());
  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal((await first.json()).events.length, 3);
  assert.equal((await replay.json()).events.length, 0);
  assert.deepEqual(forwarded.slice(0, 3).map(({ event }) => event.sequence), [0, 1, 2]);

  const mismatch = await handler(new Request("https://railway.example/dispatch", {
    method: "POST", headers: { authorization: "Bearer dispatch", "content-type": "application/json", "x-work-id": "wrong-work-id" }, body: JSON.stringify(order),
  }));
  assert.equal(mismatch.status, 409);

  const unauthorized = await handler(new Request("https://railway.example/dispatch", {
    method: "POST", headers: { "content-type": "application/json", "x-work-id": order.work_id }, body: JSON.stringify(order),
  }));
  assert.equal(unauthorized.status, 401);
});

test("dispatcher stores terminal failed receipts instead of relaunching stable work", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  let launches = 0;
  const dispatcher = new EncounterDispatcher({
    backend: { async launch(received) {
      launches += 1;
      return {
        worker_id: "test-worker",
        events: [
          { schema_version: "1", event_id: "evt-test-accepted", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 0, occurred_at: "2026-09-08T20:00:00.000Z", kind: "accepted" },
          { schema_version: "1", event_id: "evt-test-failed", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 1, occurred_at: "2026-09-08T20:00:00.001Z", kind: "failed", error_code: "test_failure", retryable: true },
        ],
      };
    } },
  });

  const first = await dispatcher.dispatchWorkOrder(order);
  const replay = await dispatcher.dispatchWorkOrder(order);
  assert.equal(first.receipt.status, "failed");
  assert.equal(replay.deduplicated, true);
  assert.equal(launches, 1);
});

test("an atomic receipt claim prevents duplicate launches across dispatcher instances", async () => {
  const order = planEncounterWork(fixture).work_orders[0];
  const store = new InMemoryReceiptStore();
  let launches = 0;
  const backend = { async launch(received) {
    launches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { worker_id: "test-worker", events: [
      { schema_version: "1", event_id: "evt-atomic-accepted", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 0, occurred_at: "2026-09-08T20:00:00.000Z", kind: "accepted" },
      { schema_version: "1", event_id: "evt-atomic-completed", work_id: received.work_id, encounter_id: received.encounter_id, worker_id: "test-worker", sequence: 1, occurred_at: "2026-09-08T20:00:00.001Z", kind: "completed" },
    ] };
  } };
  const [first, duplicate] = await Promise.all([
    new EncounterDispatcher({ backend, receiptStore: store }).dispatchWorkOrder(order),
    new EncounterDispatcher({ backend, receiptStore: store }).dispatchWorkOrder(order),
  ]);
  assert.equal(launches, 1);
  assert.equal(first.receipt.work_id, duplicate.receipt.work_id);
  assert.equal(first.deduplicated || duplicate.deduplicated, true);
});

test("restartable receipt outbox resumes only undelivered events after a callback failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "myth-maker-outbox-"));
  try {
    const order = planEncounterWork(fixture).work_orders[0];
    const first = new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 1 }), receiptStore: new JsonReceiptStore(path.join(directory, "receipts.json")) });
    const dispatched = await first.dispatchWorkOrder(order);
    const attempted = [];
    await assert.rejects(first.flush(order.work_id, { append: async (_id, event) => {
      attempted.push(event.sequence);
      if (event.sequence === 1) throw new Error("temporary callback outage");
    } }), /delivery failed/);
    assert.deepEqual(attempted, [0, 1]);

    const resumed = new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 1 }), receiptStore: new JsonReceiptStore(path.join(directory, "receipts.json")) });
    const delivered = [];
    await resumed.recoverDeliveries({ append: async (_id, event) => delivered.push(event.sequence) });
    assert.deepEqual(delivered, [1, 2]);
    assert.equal((await resumed.lookup(order.work_id)).status, "completed");
    assert.equal(dispatched.receipt.events.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
