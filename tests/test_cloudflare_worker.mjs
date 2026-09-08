import assert from "node:assert/strict";
import test from "node:test";
import worker, { EncounterCoordinator } from "../src/worker.js";

const submission = {
  project_id: "myth-maker",
  component_id: "cryo-warden-arena",
  idempotency_key: "first-encounter-0001",
  agent_id: "encounter-director",
  computer_use: { task: "create the arena shell" },
};

function storage() {
  const values = new Map();
  return { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value) };
}

test("the edge route scopes a submission to project plus component", async () => {
  let seenName;
  let proxied;
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { seenName = name; return name; },
      get() { return { fetch: async (_url, init) => { proxied = JSON.parse(init.body); return new Response("{}", { status: 202 }); } }; },
    },
  };
  const result = await worker.fetch(new Request("https://runtime/v1/encounters", {
    method: "POST", headers: { authorization: "Bearer ingress", "content-type": "application/json" }, body: JSON.stringify(submission),
  }), env);
  assert.equal(result.status, 202);
  assert.equal(seenName, "myth-maker:cryo-warden-arena");
  assert.deepEqual(proxied, submission);
});

test("the coordinator dispatches once and preserves idempotent result", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async (_url, init) => {
    dispatches += 1;
    assert.equal(init.headers.authorization, "Bearer dispatch");
    return new Response("accepted", { status: 202 });
  };
  try {
    const coordinator = new EncounterCoordinator({ storage: storage() }, {
      COMPUTER_USE_DISPATCH_URL: "https://computer-use.example/dispatch",
      COMPUTER_USE_DISPATCH_TOKEN: "dispatch",
    });
    const first = await coordinator.fetch(new Request("https://coordinator/submit", { method: "POST", body: JSON.stringify(submission) }));
    const second = await coordinator.fetch(new Request("https://coordinator/submit", { method: "POST", body: JSON.stringify(submission) }));
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(dispatches, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
