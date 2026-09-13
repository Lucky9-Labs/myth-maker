import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyReefSkitterCloudBenchmark } from "../scripts/verify-reef-skitter-cloud-benchmark.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "reef-cloud-benchmark-"));
  const sourceSha = "a".repeat(64);
  const benchmark = {
    receipt_kind: "reef_skitter_swarm_benchmark.v1",
    source_sha256: sourceSha,
    source_part_count: 15,
    source_animation_count: 5,
    creatures_requested: 400,
    creatures_visible: 400,
    creatures_visible_minimum: 400,
    creatures_visible_maximum: 400,
    creatures_visible_average: 400,
    sample_frames: 300,
    frame_ms_average: 8,
    frame_ms_p95: 11,
    cpu_main_thread_ms_average: 3,
    gpu_ms_average: -1,
    memory_allocated_bytes: 123456,
    draw_calls_counter_average: 18,
    batches_counter_average: 17,
    gc_allocated_bytes_per_frame_average: 0,
    submitted_instanced_draw_calls: 15,
    submitted_batch_groups: 15,
    per_agent_animator_count: 0,
    animation_clip_count: 5,
    animation_joint_count: 10,
    animation_samples_per_clip: 30,
    shared_animation_buffer_bytes: 960000,
    per_agent_state_contract_bytes: 32,
  };
  const benchmarkPath = path.join(root, "benchmark.json");
  const tracedBenchmarkPath = path.join(root, "traced-benchmark.json");
  const screenshotPath = path.join(root, "benchmark.png");
  const metalScreenshotPath = path.join(root, "metal.png");
  const intervalsPath = path.join(root, "intervals.xml");
  writeFileSync(benchmarkPath, JSON.stringify(benchmark));
  writeFileSync(tracedBenchmarkPath, JSON.stringify(benchmark));
  writeFileSync(screenshotPath, "benchmark-image");
  writeFileSync(metalScreenshotPath, "metal-image");
  writeFileSync(intervalsPath, "<metal-gpu-intervals />");
  const metal = {
    receiptKind: "metal-gpu-trace.v1",
    sampledGpuFrames: 120,
    gpuFrameMs: { average: 4, p95: 6 },
    benchmark: {
      sourceSha256: sourceSha,
      creaturesVisible: 400,
      submittedInstancedDrawCalls: 15,
      submittedBatchGroups: 15,
    },
    evidenceHashes: {
      metalIntervalsSha256: digest(readFileSync(intervalsPath)),
      benchmarkReceiptSha256: digest(readFileSync(tracedBenchmarkPath)),
      screenshotSha256: digest(readFileSync(metalScreenshotPath)),
    },
  };
  const metalReceiptPath = path.join(root, "metal.json");
  writeFileSync(metalReceiptPath, JSON.stringify(metal));
  const integrationRunPath = path.join(root, "integration-run.json");
  const integrationArtifactPath = path.join(root, "integration-artifact.json");
  const animationInspectionPath = path.join(root, "animation-inspection.json");
  writeFileSync(integrationRunPath, JSON.stringify({ id: 123, run_attempt: 1, head_sha: "b".repeat(40), status: "completed", conclusion: "success", path: ".github/workflows/reef-skitter-cloud-integration.yml" }));
  writeFileSync(integrationArtifactPath, JSON.stringify({ id: 456, name: "reef-skitter-animation-candidate-123-1", digest: `sha256:${"c".repeat(64)}`, expired: false, workflow_run: { id: 123 } }));
  writeFileSync(animationInspectionPath, JSON.stringify({ schema_version: "parted-model-animation-inspection.v1", source_sha256: sourceSha, parts: 15, skinned_parts: 15, rig_count: 1, clips: ["attack", "death", "idle", "run", "walk"].map((name) => ({ name })) }));
  return {
    benchmark,
    paths: {
      benchmarkPath,
      screenshotPath,
      metalReceiptPath,
      metalIntervalsPath: intervalsPath,
      metalBenchmarkPath: tracedBenchmarkPath,
      metalScreenshotPath,
      integrationRunPath,
      integrationArtifactPath,
      animationInspectionPath,
      expectedSourceSha256: sourceSha,
    },
  };
}

test("accepts complete Unity and process-scoped Metal evidence", () => {
  const { paths } = fixture();
  const result = verifyReefSkitterCloudBenchmark(paths);

  assert.equal(result.decision, "PASS");
  assert.equal(result.creatures_visible, 400);
  assert.equal(result.metrics.gpu_frame_ms_average, 4);
  assert.match(result.evidence_sha256.benchmark_receipt, /^[a-f0-9]{64}$/);
});

test("rejects missing required runtime metrics", () => {
  for (const [field, value, message] of [
    ["cpu_main_thread_ms_average", -1, /CPU/],
    ["memory_allocated_bytes", 0, /memory/],
    ["draw_calls_counter_average", -1, /draw-call/],
    ["batches_counter_average", -1, /batch/],
    ["gc_allocated_bytes_per_frame_average", -1, /GC/],
  ]) {
    const { benchmark, paths } = fixture();
    benchmark[field] = value;
    writeFileSync(paths.benchmarkPath, JSON.stringify(benchmark));
    assert.throws(() => verifyReefSkitterCloudBenchmark(paths), message);
  }
});

test("rejects any sample window with fewer than 400 visible creatures", () => {
  const { benchmark, paths } = fixture();
  benchmark.creatures_visible_minimum = 399;
  writeFileSync(paths.benchmarkPath, JSON.stringify(benchmark));

  assert.throws(() => verifyReefSkitterCloudBenchmark(paths), /fewer than 400/);
});

test("rejects unavailable or hash-mismatched Metal evidence", () => {
  const first = fixture();
  const metal = JSON.parse(readFileSync(first.paths.metalReceiptPath, "utf8"));
  metal.sampledGpuFrames = 0;
  writeFileSync(first.paths.metalReceiptPath, JSON.stringify(metal));
  assert.throws(() => verifyReefSkitterCloudBenchmark(first.paths), /GPU frame metric/);

  const second = fixture();
  writeFileSync(second.paths.metalIntervalsPath, "tampered");
  assert.throws(() => verifyReefSkitterCloudBenchmark(second.paths), /interval export hash/);
});
