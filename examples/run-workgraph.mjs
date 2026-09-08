import { EncounterDispatcher } from "../src/encounter-dispatcher.js";
import { LocalWorkerBackend } from "../src/local-worker-backend.js";
import { planEncounterWork } from "../src/workgraph-planner.js";

// Fixture only: the planner remains an EncounterSpec-to-work graph transform.
const fixture = {
  schema_version: "2",
  encounter_id: "tideglass-reef",
  seed: 17,
  deadline_at: "2026-09-09T12:00:00Z",
  host_capabilities: {
    schema_version: "1", host_id: "demo-host", host_build: "2026.09.08", platform: "linux",
    scripting_backend: "il2cpp", execution_kinds: ["recipe"], loaders: ["recipe-loader"],
    contracts: ["encounter-module.v1"], limits: { memory_mb: 2048, preload_seconds: 30 },
  },
  objective: { kind: "survive", parameters: { seconds: 90 } },
  arena_envelope: { bounds: { width: 30, height: 12, depth: 30 }, navigation_profiles: ["ground"] },
  desired_roles: ["pressure", "support"],
  production_gate: {
    kind: "bootstrap_waiver",
    waiver: {
      kind: "bootstrap_waiver",
      bounded_reason: "This standalone local dispatcher fixture is pre-gate bootstrap evidence only.",
      approver: "local-demo-owner",
      approved_at: "2026-09-08T00:00:00Z",
      expires_at: "2026-12-31T00:00:00Z",
      requested_provides: ["encounter.body.source", "encounter.animation.recipe", "encounter.combat.recipe", "encounter.validation.report"],
      not_concept_compliant: true,
    },
  },
};

const graph = planEncounterWork(fixture);
const result = await new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 180 }) }).dispatch(graph);
const rootEvents = graph.work_orders.slice(0, 3).map((order) => result.events.filter((event) => event.work_id === order.work_id));
const starts = rootEvents.map((events) => events.find((event) => event.kind === "started").occurred_at);
const completes = rootEvents.map((events) => events.find((event) => event.kind === "completed").occurred_at);
const overlap = Math.max(...starts.map(Date.parse)) < Math.min(...completes.map(Date.parse));

console.log(JSON.stringify({
  graph,
  events: result.events,
  receipts: result.receipts,
  overlap: { observed: overlap, root_started_at: starts, root_completed_at: completes },
}, null, 2));
