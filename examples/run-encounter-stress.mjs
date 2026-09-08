import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { EncounterDispatcher } from "../src/encounter-dispatcher.js";
import { LocalWorkerBackend } from "../src/local-worker-backend.js";
import { assembleEncounterInputs, planEncounterWork } from "../src/workgraph-planner.js";

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) throw new Error("--output requires a receipt path");

// Demo-scale fixture only. The planner has no creature, genre, or asset-format
// branch; desired roles are the only fan-out input.
const spec = {
  schema_version: "2",
  encounter_id: "full-scale-demo",
  seed: 413,
  deadline_at: "2026-12-31T00:00:00Z",
  host_capabilities: {
    schema_version: "1", host_id: "local-stress-host", host_build: "2026.09.08", platform: "local",
    scripting_backend: "il2cpp", execution_kinds: ["recipe"], loaders: ["recipe-loader"],
    contracts: ["encounter-module.v1"], limits: { memory_mb: 2048, preload_seconds: 30 },
  },
  objective: { kind: "survive", parameters: { seconds: 180 } },
  arena_envelope: { bounds: { width: 90, height: 24, depth: 90 }, navigation_profiles: ["ground", "air"] },
  desired_roles: ["control", "pressure", "support"],
  production_gate: {
    kind: "bootstrap_waiver",
    waiver: {
      kind: "bootstrap_waiver",
      bounded_reason: "This one-shot local process stress receipt exercises generic planning only; it is not concept-first production or remote execution.",
      approver: "local-demo-owner",
      approved_at: "2026-09-08T00:00:00Z",
      expires_at: "2026-12-31T00:00:00Z",
      requested_provides: ["encounter.body.source", "encounter.body.segment.source", "encounter.critical-spot.module", "encounter.motion.clip", "encounter.material.binding", "encounter.arena.envelope", "encounter.combat.recipe", "encounter.assembly.receipt", "encounter.validation.report"],
      not_concept_compliant: true,
    },
  },
};

const graph = planEncounterWork(spec);
// The longer observed window keeps overlap measurable when all 16 independent
// local child processes start under a loaded host.
const result = await new EncounterDispatcher({ backend: new LocalWorkerBackend({ workDurationMs: 800 }) }).dispatch(graph);
const roots = graph.work_orders.filter((order) => !["assembly", "validation"].includes(order.lane));
const rootEvents = roots.map((order) => result.events.filter((event) => event.work_id === order.work_id));
const starts = rootEvents.map((events) => Date.parse(events.find((event) => event.kind === "started").occurred_at));
const completes = rootEvents.map((events) => Date.parse(events.find((event) => event.kind === "completed").occurred_at));
const receipt = {
  format: "myth-maker.one-shot-stress-receipt.v1",
  evidence_scope: "observed_local_node_processes_only",
  encounter_id: graph.encounter_id,
  component_graph: graph.component_graph,
  work_orders: graph.work_orders.map((order) => ({ work_id: order.work_id, lane: order.lane, requested_provides: order.requested_provides, depends_on_work_ids: order.depends_on_work_ids })),
  worker_receipts: result.receipts,
  assembly_inputs: assembleEncounterInputs(graph, result.receipts),
  concurrency: {
    independent_work_order_count: roots.length,
    overlap_observed: Math.max(...starts) < Math.min(...completes),
    root_started_at: starts.map((value) => new Date(value).toISOString()),
    root_completed_at: completes.map((value) => new Date(value).toISOString()),
  },
  providers: {
    local_node_processes: "observed",
    local_blender_cli: "not_run",
    blender_gui_worker: "not_run",
    modal_remote: "not_run",
  },
  remaining_gaps: [
    "Local Node worker receipts and assembly input plan are a dispatcher simulation, not Blender output or package-assembly receipts.",
    "No Blender GUI worker, Modal remote job, cloud provider work ID, Unity import, or host-game combat was observed.",
    "The bootstrap waiver is explicitly not concept-first compliant.",
  ],
};

const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (outputPath) {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, serialized);
}
process.stdout.write(serialized);
