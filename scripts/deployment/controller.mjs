#!/usr/bin/env node
/**
 * CI-owned deployment policy and provider adapter.
 *
 * This module deliberately contains no credentials. Workflows provide only the
 * provider-specific environment variables after their GitHub Environment gate.
 * Its command arrays avoid a shell, so a requested environment cannot become
 * executable input.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

export const providerDefinitions = Object.freeze({
  cloudflare: Object.freeze({
    secretNames: ["CLOUDFLARE_API_TOKEN", "TF_VAR_agent_ingress_token", "TF_VAR_work_dispatch_token"],
    requiredFiles: ["wrangler.jsonc", "src/worker.js", "src/encounter-package-assembler.js"],
    preview: ["npx", ["--yes", "wrangler@4.37.0", "deploy", "--dry-run", "--config", "wrangler.jsonc"]],
    // Terraform owns the Worker version/deployment because it also owns the
    // environment bindings. A second Wrangler deploy would race that state.
    deploy: null,
  }),
  railway: Object.freeze({
    secretNames: ["TF_VAR_railway_token", "WORK_DISPATCH_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    requiredFiles: [],
    preview: null,
    deploy: null,
  }),
  modal: Object.freeze({
    secretNames: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"],
    requiredFiles: ["modal/draft_trial.py"],
    preview: null,
    deploy: ["uvx", ["--from", "modal==1.0.3", "modal", "deploy"]],
  }),
});

export function deploymentConcurrencyGroup(provider, environment) {
  assertProvider(provider);
  assertEnvironment(environment);
  return `myth-maker-deploy-${provider}-${environment}`;
}

export function selectProviderOutcome(provider, outcomes) {
  assertProvider(provider);
  const outcome = outcomes?.[provider];
  return typeof outcome === "string" && outcome.length ? outcome : "failure";
}

export function validateProviderRequest({ eventName, mode, provider, environment }) {
  assertProvider(provider);
  assertEnvironment(environment);
  if (!new Set(["validate", "preview", "deploy"]).has(mode)) {
    throw new Error("mode must be validate, preview, or deploy");
  }
  if (mode === "deploy" && !new Set(["push", "workflow_dispatch"]).has(eventName)) {
    throw new Error("deployments require a trusted main push or manual workflow dispatch");
  }
  if (eventName === "pull_request" && mode === "deploy") {
    throw new Error("pull-request events are validation-only");
  }
  return { provider, environment, mode, mutating: mode === "deploy" };
}

export function assertDeploymentRequest({ eventName, sourceSha, checkoutSha, isReachableFromMain, isClean }) {
  if (!new Set(["push", "workflow_dispatch"]).has(eventName)) {
    throw new Error("deployment must be initiated by a trusted main push or workflow_dispatch");
  }
  if (!SHA.test(sourceSha ?? "")) {
    throw new Error("source SHA must be a full immutable 40-character SHA-1");
  }
  if (checkoutSha !== sourceSha) {
    throw new Error("checked out revision does not match the requested immutable source SHA");
  }
  if (!isReachableFromMain) {
    throw new Error("source SHA must already be reachable from origin/main");
  }
  if (!isClean) {
    throw new Error("deployment checkout must have no uncommitted changes");
  }
  return { sourceSha };
}

export function createReceipt({ provider, environment, sourceSha, status, startedAt, completedAt, artifactIds = [], verification = {}, details = {} }) {
  assertProvider(provider);
  assertEnvironment(environment);
  if (!SHA.test(sourceSha ?? "")) throw new Error("receipt source SHA must be immutable");
  if (!new Set(["success", "failure", "skipped"]).has(status)) throw new Error("receipt status is invalid");
  return {
    format: "myth-maker.deployment-receipt/v1",
    provider,
    environment,
    source_sha: sourceSha,
    artifact_version_ids: artifactIds,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    verification,
    details,
  };
}

export function providerCommand(provider, mode, environment) {
  const definition = providerDefinitions[provider];
  assertProvider(provider);
  assertEnvironment(environment);
  if (mode === "preview") return definition.preview;
  if (mode !== "deploy") return null;
  if (provider === "modal") {
    return [definition.deploy[0], [...definition.deploy[1], "--env", environment, "modal/draft_trial.py"]];
  }
  return definition.deploy;
}

export function providerReceiptMetadata(provider, environment, sourceSha) {
  assertProvider(provider);
  assertEnvironment(environment);
  if (!SHA.test(sourceSha ?? "")) throw new Error("receipt source SHA must be immutable");
  const buildVersion = `git:${sourceSha}`;
  if (provider === "cloudflare") {
    return {
      artifactIds: [buildVersion, `worker:${environment === "dev" ? "myth-maker-encounter-runtime" : `myth-maker-${environment}-encounter-runtime`}`],
      details: {
        target: "Cloudflare Worker",
        module_sha256: Object.fromEntries(
          ["src/worker.js", "src/encounter-package-assembler.js"].map((file) => [file, sha256File(file)]),
        ),
        bindings_snapshot_required: ["WORK_DISPATCH_URL", "WORK_DISPATCH_TOKEN"],
      },
    };
  }
  if (provider === "railway") {
    return {
      artifactIds: [buildVersion],
      details: {
        evidence_status: "unavailable",
        reason: "dispatcher acknowledgement adapter is not implemented",
      },
    };
  }
  return {
    artifactIds: [buildVersion, "app:myth-maker-encounter-draft"],
    details: {
      target: "Modal draft application",
      required_resources: ["myth-maker-encounter-submissions", "myth-maker-encounter-component-leases"],
    },
  };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(resolve(file))).digest("hex");
}

function assertProvider(value) {
  if (!PROVIDER.test(value ?? "") || !(value in providerDefinitions)) {
    throw new Error("unknown deployment provider");
  }
}

function assertEnvironment(value) {
  if (!ENVIRONMENT.test(value ?? "")) throw new Error("environment must be lowercase kebab-case");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must be --key value pairs");
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return { command, options };
}

function validateLocalFiles(provider) {
  const missing = providerDefinitions[provider].requiredFiles.filter((file) => {
    try { readFileSync(resolve(file)); return false; } catch { return true; }
  });
  if (missing.length) throw new Error(`missing required ${provider} deployment files: ${missing.join(", ")}`);
}

function run(command, options) {
  const provider = options.provider;
  const environment = options.environment;
  const request = validateProviderRequest({
    eventName: options.event,
    mode: command,
    provider,
    environment,
  });
  validateLocalFiles(provider);
  if (command === "validate") {
    process.stdout.write(`${JSON.stringify({ ...request, status: "validated" })}\n`);
    return;
  }
  const invocation = providerCommand(provider, command, environment);
  if (!invocation) {
    if (command === "deploy" && provider === "railway") {
      throw new Error("Railway dispatcher deployment and x-work-id acknowledgement are unsupported until a dispatcher adapter is supplied");
    }
    process.stdout.write(`${JSON.stringify({ ...request, status: "validated", command: null })}\n`);
    return;
  }
  if (command === "preview") {
    process.stdout.write(`${JSON.stringify({ ...request, status: "previewed", command: invocation })}\n`);
    return;
  }
  const missingSecrets = providerDefinitions[provider].secretNames.filter((secret) => !process.env[secret]);
  if (missingSecrets.length) {
    throw new Error(`${missingSecrets.join(", ")} are required only after the reviewed environment gate`);
  }
  execFileSync(invocation[0], invocation[1], { stdio: "inherit", env: process.env });
}

function writeReceipt(options) {
  const generated = providerReceiptMetadata(options.provider, options.environment, options.source_sha);
  const receipt = createReceipt({
    provider: options.provider,
    environment: options.environment,
    sourceSha: options.source_sha,
    status: options.status,
    startedAt: options.started_at,
    completedAt: options.completed_at,
    artifactIds: options.artifact_ids ? options.artifact_ids.split(",").filter(Boolean) : generated.artifactIds,
    verification: JSON.parse(options.verification ?? "{}"),
    details: { ...generated.details, ...JSON.parse(options.details ?? "{}") },
  });
  const path = resolve(options.output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === "receipt") writeReceipt(options);
    else if (new Set(["validate", "preview", "deploy"]).has(command)) run(command, options);
    else throw new Error("command must be validate, preview, deploy, or receipt");
  } catch (error) {
    process.stderr.write(`deployment-controller: ${error.message}\n`);
    process.exitCode = 1;
  }
}
