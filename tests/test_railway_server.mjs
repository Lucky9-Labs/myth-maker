import assert from "node:assert/strict";
import test from "node:test";

import { EncounterDispatcher } from "../src/encounter-dispatcher.js";
import { createRailwayServer } from "../src/railway-server.js";

test("Railway verification echoes a stable x-work-id without dispatching or writing a receipt", async () => {
  let launches = 0;
  const server = createRailwayServer({
    dispatcher: new EncounterDispatcher({ backend: { async launch() { launches += 1; throw new Error("must not launch"); } } }),
    dispatchToken: "dispatch-token",
    eventSink: { append: async () => { throw new Error("must not callback"); } },
    releaseRevision: "a".repeat(40),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/dispatch/verify`, { headers: { "x-work-id": "verify-worker-1" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-work-id"), "verify-worker-1");
    assert.deepEqual(await response.json(), {
      status: "ready", acknowledgement: "x-work-id-accepted", work_id: "verify-worker-1", dispatch_mutated: false, release_revision: "a".repeat(40),
    });
    assert.equal(launches, 0);

    const invalid = await fetch(`http://127.0.0.1:${port}/v1/dispatch/verify`, { headers: { "x-work-id": "not valid" } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_x_work_id" });
    const oversized = await fetch(`http://127.0.0.1:${port}/v1/dispatch`, { method: "POST", body: "x".repeat(1_048_577) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "body_too_large" });
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
