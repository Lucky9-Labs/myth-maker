#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const finitePositive = (value) => Number.isFinite(value) && value > 0;
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyReefSkitterCloudBenchmark({
  benchmarkPath,
  screenshotPath,
  metalReceiptPath,
  metalIntervalsPath,
  metalBenchmarkPath,
  metalScreenshotPath,
  integrationRunPath,
  integrationArtifactPath,
  animationInspectionPath,
  expectedSourceSha256,
}) {
  requireCondition(/^[a-f0-9]{64}$/.test(expectedSourceSha256 ?? ""), "expected source SHA-256 is invalid");
  const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8"));
  const metal = JSON.parse(readFileSync(metalReceiptPath, "utf8"));
  const tracedBenchmark = JSON.parse(readFileSync(metalBenchmarkPath, "utf8"));
  const integrationRun = JSON.parse(readFileSync(integrationRunPath, "utf8"));
  const integrationArtifact = JSON.parse(readFileSync(integrationArtifactPath, "utf8"));
  const animationInspection = JSON.parse(readFileSync(animationInspectionPath, "utf8"));

  requireCondition(integrationRun.status === "completed" && integrationRun.conclusion === "success", "integration run was not successful");
  requireCondition(integrationRun.path === ".github/workflows/reef-skitter-cloud-integration.yml", "unexpected integration workflow");
  requireCondition(integrationArtifact.expired === false && integrationArtifact.workflow_run?.id === integrationRun.id, "integration artifact is expired or belongs to another run");
  requireCondition(/^sha256:[a-f0-9]{64}$/.test(integrationArtifact.digest ?? ""), "integration artifact digest is unavailable");
  requireCondition(animationInspection.schema_version === "parted-model-animation-inspection.v1" && animationInspection.source_sha256 === expectedSourceSha256, "animation inspection identity mismatch");
  requireCondition(animationInspection.parts === 15 && animationInspection.skinned_parts === 15 && animationInspection.rig_count === 1, "animation inspection does not prove the 15-part shared rig");
  requireCondition(JSON.stringify(animationInspection.clips?.map(({ name }) => name).sort()) === JSON.stringify(["attack", "death", "idle", "run", "walk"]), "animation inspection does not prove the exact five clips");

  requireCondition(benchmark.receipt_kind === "reef_skitter_swarm_benchmark.v1", "unexpected benchmark receipt kind");
  requireCondition(benchmark.source_sha256 === expectedSourceSha256, "benchmark source SHA-256 mismatch");
  requireCondition(benchmark.source_part_count === 15, "benchmark did not retain all 15 provider parts");
  requireCondition(benchmark.source_animation_count === 5 && benchmark.animation_clip_count === 5, "benchmark did not load the exact five clips");
  requireCondition(benchmark.animation_joint_count > 1 && benchmark.animation_samples_per_clip > 1, "shared animation samples are unavailable");
  requireCondition(benchmark.shared_animation_buffer_bytes > 0 && benchmark.per_agent_state_contract_bytes > 0, "shared animation/runtime metrics are unavailable");
  requireCondition(benchmark.per_agent_animator_count === 0, "benchmark used per-agent Animator components");
  requireCondition(benchmark.creatures_requested === 400, "benchmark did not request 400 creatures");
  requireCondition(
    benchmark.creatures_visible === 400
      && benchmark.creatures_visible_minimum === 400
      && benchmark.creatures_visible_maximum === 400
      && benchmark.creatures_visible_average === 400,
    "fewer than 400 creatures were visible during the sample window",
  );
  requireCondition(benchmark.sample_frames >= 300, "benchmark sample window is incomplete");
  requireCondition(finitePositive(benchmark.frame_ms_average) && finitePositive(benchmark.frame_ms_p95), "frame-time metrics are unavailable");
  requireCondition(finitePositive(benchmark.cpu_main_thread_ms_average), "CPU main-thread metric is unavailable");
  requireCondition(Number.isInteger(benchmark.memory_allocated_bytes) && benchmark.memory_allocated_bytes > 0, "memory metric is unavailable");
  requireCondition(finitePositive(benchmark.draw_calls_counter_average), "draw-call counter is unavailable");
  requireCondition(finitePositive(benchmark.batches_counter_average), "batch counter is unavailable");
  requireCondition(benchmark.submitted_instanced_draw_calls > 0 && benchmark.submitted_batch_groups > 0, "submitted instancing metrics are unavailable");
  requireCondition(finiteNonNegative(benchmark.gc_allocated_bytes_per_frame_average), "GC allocation metric is unavailable");
  requireCondition(readFileSync(screenshotPath).length > 0, "benchmark screenshot is empty");

  requireCondition(metal.receiptKind === "metal-gpu-trace.v1", "unexpected Metal trace receipt kind");
  requireCondition(metal.benchmark?.sourceSha256 === expectedSourceSha256, "Metal trace source SHA-256 mismatch");
  requireCondition(metal.benchmark?.creaturesVisible === 400, "Metal trace did not observe 400 visible creatures");
  requireCondition(metal.sampledGpuFrames > 0 && finitePositive(metal.gpuFrameMs?.average) && finitePositive(metal.gpuFrameMs?.p95), "GPU frame metric is unavailable");
  requireCondition(metal.benchmark?.submittedInstancedDrawCalls > 0 && metal.benchmark?.submittedBatchGroups > 0, "Metal trace is missing submitted draw/batch metrics");
  requireCondition(metal.evidenceHashes?.metalIntervalsSha256 === sha256(metalIntervalsPath), "Metal interval export hash mismatch");
  requireCondition(metal.evidenceHashes?.benchmarkReceiptSha256 === sha256(metalBenchmarkPath), "Metal benchmark receipt hash mismatch");
  requireCondition(metal.evidenceHashes?.screenshotSha256 === sha256(metalScreenshotPath), "Metal screenshot hash mismatch");
  requireCondition(tracedBenchmark.source_sha256 === expectedSourceSha256 && tracedBenchmark.creatures_visible === 400, "traced benchmark identity/visibility mismatch");

  return {
    schema_version: "reef-skitter-cloud-benchmark-acceptance.v1",
    decision: "PASS",
    source_sha256: expectedSourceSha256,
    integration: {
      run_id: integrationRun.id,
      run_attempt: integrationRun.run_attempt,
      head_sha: integrationRun.head_sha,
      artifact_id: integrationArtifact.id,
      artifact_name: integrationArtifact.name,
      artifact_digest: integrationArtifact.digest,
    },
    creatures_visible: 400,
    metrics: {
      frame_ms_average: benchmark.frame_ms_average,
      frame_ms_p95: benchmark.frame_ms_p95,
      cpu_main_thread_ms_average: benchmark.cpu_main_thread_ms_average,
      gpu_frame_ms_average: metal.gpuFrameMs.average,
      gpu_frame_ms_p95: metal.gpuFrameMs.p95,
      memory_allocated_bytes: benchmark.memory_allocated_bytes,
      draw_calls_average: benchmark.draw_calls_counter_average,
      batches_average: benchmark.batches_counter_average,
      gc_allocated_bytes_per_frame_average: benchmark.gc_allocated_bytes_per_frame_average,
    },
    evidence_sha256: {
      benchmark_receipt: sha256(benchmarkPath),
      benchmark_screenshot: sha256(screenshotPath),
      metal_receipt: sha256(metalReceiptPath),
      metal_intervals: sha256(metalIntervalsPath),
      metal_benchmark_receipt: sha256(metalBenchmarkPath),
      metal_screenshot: sha256(metalScreenshotPath),
      integration_run: sha256(integrationRunPath),
      integration_artifact: sha256(integrationArtifactPath),
      animation_inspection: sha256(animationInspectionPath),
    },
  };
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  const required = ["benchmark", "screenshot", "metal-receipt", "metal-intervals", "metal-benchmark", "metal-screenshot", "integration-run", "integration-artifact", "animation-inspection", "expected-source-sha256", "output"];
  requireCondition(required.every((name) => args[name]), `usage: ${required.map((name) => `--${name} VALUE`).join(" ")}`);
  const result = verifyReefSkitterCloudBenchmark({
    benchmarkPath: args.benchmark,
    screenshotPath: args.screenshot,
    metalReceiptPath: args["metal-receipt"],
    metalIntervalsPath: args["metal-intervals"],
    metalBenchmarkPath: args["metal-benchmark"],
    metalScreenshotPath: args["metal-screenshot"],
    integrationRunPath: args["integration-run"],
    integrationArtifactPath: args["integration-artifact"],
    animationInspectionPath: args["animation-inspection"],
    expectedSourceSha256: args["expected-source-sha256"],
  });
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result));
}
