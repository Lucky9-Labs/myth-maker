#!/usr/bin/env node

import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [xmlPath, processName, pidText, warmupText = "1", outputPath, benchmarkReceiptPath, screenshotPath] = process.argv.slice(2);
if (!xmlPath || !processName || !/^\d+$/.test(pidText ?? "")) {
  console.error("Usage: summarize-metal-trace.mjs <metal-gpu-intervals.xml> <process-name> <pid> [warmup-seconds]");
  process.exit(2);
}
const warmupSeconds = Number(warmupText);
if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0) {
  console.error("warmup-seconds must be a non-negative number");
  process.exit(2);
}

const numericById = new Map();
const spansByFrame = new Map();
let processRef = null;
let eventCount = 0;

const numericDefinition = /<[-\w]+\s+[^>]*id="(\d+)"[^>]*>(\d+)<\/[-\w]+>/g;
const element = (name, line) => {
  const match = line.match(new RegExp(`<${name}\\s+([^>]*)>(\\d+)<\\/${name}>|<${name}\\s+([^>]*)\\/>`));
  if (!match) return null;
  const attributes = match[1] ?? match[3] ?? "";
  const directValue = match[2] ? Number(match[2]) : null;
  const ref = attributes.match(/ref="(\d+)"/)?.[1];
  return directValue ?? (ref ? numericById.get(ref) : null) ?? null;
};

const input = createInterface({ input: createReadStream(xmlPath), crlfDelay: Infinity });
for await (const line of input) {
  for (const match of line.matchAll(numericDefinition)) numericById.set(match[1], Number(match[2]));

  if (!processRef && line.includes(`fmt="${processName} (${pidText})"`)) {
    processRef = line.match(/<process\s+id="(\d+)"/)?.[1] ?? null;
  }
  if (!processRef || !line.includes(`<process ref="${processRef}"/>`)) continue;

  const startNs = element("start-time", line);
  const durationNs = element("duration", line);
  const frame = element("gpu-frame-number", line);
  if (startNs === null || durationNs === null || frame === null || durationNs <= 0) continue;

  eventCount += 1;
  const span = spansByFrame.get(frame) ?? { startNs, endNs: startNs + durationNs, events: 0 };
  span.startNs = Math.min(span.startNs, startNs);
  span.endNs = Math.max(span.endNs, startNs + durationNs);
  span.events += 1;
  spansByFrame.set(frame, span);
}

const orderedFrames = [...spansByFrame.values()].sort((a, b) => a.startNs - b.startNs);
const firstProcessGpuNs = orderedFrames[0]?.startNs;
const retainedFrames = orderedFrames.filter(({ startNs }) => startNs >= firstProcessGpuNs + warmupSeconds * 1_000_000_000);
const samplesMs = retainedFrames
  .map(({ startNs, endNs }) => (endNs - startNs) / 1_000_000)
  .sort((a, b) => a - b);
if (!processRef || samplesMs.length === 0) {
  console.error(`No GPU intervals found for ${processName} (${pidText})`);
  process.exit(1);
}

const percentile = (fraction) => samplesMs[Math.max(0, Math.ceil(samplesMs.length * fraction) - 1)];
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const benchmark = benchmarkReceiptPath ? JSON.parse(readFileSync(benchmarkReceiptPath, "utf8")) : null;
const result = JSON.stringify({
  schemaVersion: 1,
  receiptKind: "metal-gpu-trace.v1",
  source: xmlPath,
  evidenceHashes: {
    metalIntervalsSha256: digest(xmlPath),
    ...(benchmarkReceiptPath ? { benchmarkReceiptSha256: digest(benchmarkReceiptPath) } : {}),
    ...(screenshotPath ? { screenshotSha256: digest(screenshotPath) } : {}),
  },
  ...(benchmark ? { benchmark: {
    sourceSha256: benchmark.source_sha256,
    creaturesVisible: benchmark.creatures_visible,
    submittedInstancedDrawCalls: benchmark.submitted_instanced_draw_calls,
    submittedBatchGroups: benchmark.submitted_batch_groups,
    perAgentAnimatorCount: benchmark.per_agent_animator_count,
    cpuMainThreadMsAverage: benchmark.cpu_main_thread_ms_average,
    memoryAllocatedBytes: benchmark.memory_allocated_bytes,
  } } : {}),
  process: { name: processName, pid: Number(pidText), traceRef: processRef },
  method: "Per GPU frame, span from earliest process-scoped Metal interval start to latest interval end; overlapping channel work is not double-counted.",
  eventCount,
  rawGpuFrames: orderedFrames.length,
  discardedProcessWarmupSeconds: warmupSeconds,
  sampledGpuFrames: samplesMs.length,
  gpuFrameMs: {
    average: samplesMs.reduce((sum, value) => sum + value, 0) / samplesMs.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    maximum: samplesMs.at(-1),
    minimum: samplesMs[0],
  },
}, null, 2);
if (outputPath) writeFileSync(outputPath, `${result}\n`, { flag: "wx" });
console.log(result);
