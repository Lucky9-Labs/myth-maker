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
import { dirname, resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_PROVIDERS = new Set(["cloudflare", "railway", "modal", "terraform-foundation"]);

export const providerDefinitions = Object.freeze({
  cloudflare: Object.freeze({
    // The Terraform foundation owns Cloudflare bindings and their runtime
    // secrets. This provider adapter has no direct deployment command yet.
    secretNames: [],
    requiredFiles: ["wrangler.jsonc", "src/worker.js", "src/encounter-package-assembler.js", "src/package-discovery.js"],
    preview: ["npx", ["--yes", "wrangler@4.37.0", "deploy", "--dry-run", "--config", "wrangler.jsonc"]],
    // Terraform owns the Worker version/deployment because it also owns the
    // environment bindings. A second Wrangler deploy would race that state.
    deploy: null,
  }),
  railway: Object.freeze({
    secretNames: ["RAILWAY_TOKEN"],
    requiredFiles: ["Dockerfile", "railway.toml", "src/railway-server.js", "src/modal-bridge-backend.js", "modal/railway_modal_bridge.py"],
    preview: null,
    deploy: ["railway", ["up", "--ci", "--detach"]],
  }),
  modal: Object.freeze({
    // These are read only by the CI-owned bootstrap helper after the GitHub
    // Environment gate. OPENAI_API_KEY is copied to a named Modal Secret and
    // never passed as a CLI argument or emitted in the deployment evidence.
    secretNames: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"],
    requiredFiles: ["modal/draft_trial.py", "scripts/deployment/modal_deploy.py"],
    preview: null,
    deploy: ["python3", ["scripts/deployment/modal_deploy.py"]],
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

export function trustedDeploymentContext(environment = process.env) {
  const eventName = environment.GITHUB_EVENT_NAME;
  const sourceSha = environment.GITHUB_SHA;
  if (
    environment.GITHUB_ACTIONS !== "true"
    || !new Set(["push", "workflow_dispatch"]).has(eventName)
    || environment.GITHUB_REF !== "refs/heads/main"
    || !SHA.test(sourceSha ?? "")
  ) {
    throw new Error("deployments require trusted GitHub Actions context on main");
  }
  return { eventName, sourceSha };
}

export function releaseReadiness({ environment, deploymentReady }) {
  assertEnvironment(environment);
  if (deploymentReady !== true) {
    return { ready: false, reason: "DEPLOYMENT_READY is not true; no provider command was invoked" };
  }
  const unavailable = Object.entries(providerDefinitions)
    .filter(([, definition]) => definition.deploy === null)
    .map(([provider]) => provider);
  if (unavailable.length) {
    return { ready: false, reason: `provider deploy commands are unavailable: ${unavailable.join(", ")}` };
  }
  return { ready: true, reason: "environment bootstrap and provider commands are ready" };
}

export function validateGitHubOidcClaims(claims, trusted) {
  if (
    claims?.iss !== "https://token.actions.githubusercontent.com"
    || claims.repository !== "Lucky9-Labs/myth-maker"
    || claims.ref !== "refs/heads/main"
    || claims.sha !== trusted.sourceSha
  ) {
    throw new Error("GitHub OIDC identity does not match the trusted main revision");
  }
  return true;
}

export function parseModalDeploymentEvidence(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Modal deployment did not return parseable JSON evidence");
  }
  const deploymentId = parsed.deployment_id;
  const versionId = parsed.version_id;
  const resourceIds = parsed.resource_ids;
  const health = parsed.health;
  const dispatch = parsed.dispatch;
  if (
    typeof deploymentId !== "string" || !deploymentId
    || typeof versionId !== "string" || !versionId
    || !Array.isArray(resourceIds) || resourceIds.length === 0 || resourceIds.some((value) => typeof value !== "string" || !value)
    || health?.status !== "healthy"
    || health?.dedicated_secret_verified !== true
    || typeof health?.verified_secret_name !== "string" || !health.verified_secret_name
    || typeof dispatch?.function_call_id !== "string" || !dispatch.function_call_id
    || typeof dispatch?.function_id !== "string" || !dispatch.function_id
    || typeof dispatch?.input_id !== "string" || !dispatch.input_id
    || typeof dispatch?.worker_id !== "string" || !dispatch.worker_id
    || dispatch?.status !== "completed"
  ) {
    throw new Error("Modal deployment evidence requires deployment_id, version_id, resource_ids, healthy status, and a completed remote dispatch receipt");
  }
  return { deployment_id: deploymentId, version_id: versionId, resource_ids: resourceIds, health, dispatch };
}

export function createReceipt({ provider, environment, sourceSha, status, startedAt, completedAt, artifactIds = [], verification = {}, details = {} }) {
  assertReceiptProvider(provider);
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
  if (mode === "preview") {
    if (provider === "modal") {
      return ["python3", ["modal/infrastructure.py", "--environment", environment, "--check-files"]];
    }
    return definition.preview;
  }
  if (mode !== "deploy") return null;
  if (provider === "railway") {
    const serviceId = process.env.RAILWAY_SERVICE_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    if (!uuid(serviceId) || !uuid(environmentId)) {
      throw new Error("RAILWAY_SERVICE_ID and RAILWAY_ENVIRONMENT_ID must be configured UUIDs in the GitHub Environment");
    }
    return [definition.deploy[0], [...definition.deploy[1], "--service", serviceId, "--environment", environmentId]];
  }
  if (provider === "modal" && definition.deploy) {
    const evidencePath = process.env.MODAL_EVIDENCE_PATH;
    if (!evidencePath) throw new Error("MODAL_EVIDENCE_PATH is required for a Modal deployment receipt");
    return [definition.deploy[0], [...definition.deploy[1], "--environment", environment, "--output", evidencePath]];
  }
  return definition.deploy;
}

export function providerReceiptMetadata(provider, environment, sourceSha) {
  assertProvider(provider);
  assertEnvironment(environment);
  if (!SHA.test(sourceSha ?? "")) throw new Error("receipt source SHA must be immutable");
  // A source revision is evidence of the CI input, not evidence that a remote
  // provider deployed it. Provider IDs are admitted only from parsed output.
  return { artifactIds: [`git:${sourceSha}`], details: { evidence_status: "unverified" } };
}

function assertProvider(value) {
  if (!PROVIDER.test(value ?? "") || !(value in providerDefinitions)) {
    throw new Error("unknown deployment provider");
  }
}

function assertReceiptProvider(value) {
  if (!PROVIDER.test(value ?? "") || !RECEIPT_PROVIDERS.has(value)) {
    throw new Error("unknown deployment receipt provider");
  }
}

function assertEnvironment(value) {
  if (!ENVIRONMENT.test(value ?? "")) throw new Error("environment must be lowercase kebab-case");
}

function uuid(value) { return UUID.test(value ?? ""); }

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

function assertTrustedGitHubDeployment() {
  const trusted = trustedDeploymentContext();
  assertGitHubOidcIdentity(trusted);
  const actualCheckoutSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // The GitHub-issued OIDC claims bind this SHA to refs/heads/main. That is
  // authoritative even for an older queued/main retry, where a shallow local
  // checkout cannot prove ancestry against a newer remote tip.
  const isReachableFromMain = true;
  const isClean = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "";
  assertDeploymentRequest({ ...trusted, checkoutSha: actualCheckoutSha, isReachableFromMain, isClean });
  return trusted;
}

function assertGitHubOidcIdentity(trusted) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken || process.env.GITHUB_REPOSITORY !== "Lucky9-Labs/myth-maker") {
    throw new Error("deployments require a GitHub-issued OIDC identity for this repository");
  }
  const url = new URL(requestUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new Error("deployments require the GitHub Actions OIDC endpoint");
  }
  url.searchParams.set("audience", "myth-maker-deployment");
  const response = JSON.parse(execFileSync("curl", [
    "--fail", "--silent", "--show-error", "--header", `Authorization: bearer ${requestToken}`, url.toString(),
  ], { encoding: "utf8" }));
  const payload = String(response.value ?? "").split(".")[1];
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("GitHub OIDC endpoint returned an invalid identity token");
  }
  validateGitHubOidcClaims(claims, trusted);
}

function executeProviderCommand(invocation) {
  return execFileSync(invocation[0], invocation[1], { encoding: "utf8", env: process.env });
}

function executeRailwayDeployment(invocation) {
  executeProviderCommand(invocation);
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const output = execFileSync("railway", ["deployment", "list", "--json", "--limit", "1", "--service", serviceId, "--environment", environmentId], { encoding: "utf8", env: process.env });
    let deployments;
    try { deployments = JSON.parse(output); } catch { throw new Error("Railway deployment list returned invalid JSON"); }
    const current = Array.isArray(deployments) ? deployments[0] : undefined;
    if (!current?.id || typeof current.status !== "string") throw new Error("Railway did not return a deployment receipt");
    if (current.status === "SUCCESS") return { deployment_id: current.id, status: current.status };
    if (["FAILED", "CRASHED", "CANCELED", "REMOVED"].includes(current.status)) throw new Error(`Railway deployment ${current.id} ended ${current.status}`);
    execFileSync("sleep", ["5"]);
  }
  throw new Error("Railway deployment did not reach SUCCESS before the verification deadline");
}

function run(command, options) {
  const provider = options.provider;
  const environment = options.environment;
  if (command === "deploy" && (options.event !== undefined || options.checkout_sha !== undefined)) {
    throw new Error("deploy event and checkout are derived from trusted GitHub Actions context, not CLI arguments");
  }
  const trusted = command === "deploy" ? assertTrustedGitHubDeployment() : null;
  const request = validateProviderRequest({
    eventName: trusted?.eventName ?? options.event,
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
    process.stdout.write(`${JSON.stringify({ ...request, status: "skipped", reason: `${provider} provider command is unavailable`, command: null })}\n`);
    return;
  }
  if (command === "preview") {
    executeProviderCommand(invocation);
    process.stdout.write(`${JSON.stringify({ ...request, status: "previewed", command: invocation })}\n`);
    return;
  }
  const missingSecrets = providerDefinitions[provider].secretNames.filter((secret) => !process.env[secret]);
  if (missingSecrets.length) {
    throw new Error(`${missingSecrets.join(", ")} are required only after the reviewed environment gate`);
  }
  if (provider === "railway") {
    const evidence = executeRailwayDeployment(invocation);
    process.stdout.write(`${JSON.stringify({ ...request, status: "deployed", evidence })}\n`);
    return;
  }
  executeProviderCommand(invocation);
  const evidence = provider === "modal"
    ? parseModalDeploymentEvidence(readFileSync(process.env.MODAL_EVIDENCE_PATH, "utf8"))
    : undefined;
  process.stdout.write(`${JSON.stringify({ ...request, status: "deployed", ...(evidence ? { evidence } : {}) })}\n`);
}

function writeReceipt(options) {
  const generated = options.provider === "terraform-foundation"
    ? { artifactIds: [`git:${options.source_sha}`], details: { evidence_status: "unverified" } }
    : providerReceiptMetadata(options.provider, options.environment, options.source_sha);
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
    else if (command === "assert-github-deployment") {
      if (options.checkout_sha !== undefined) throw new Error("trusted checkout is derived from git, not --checkout-sha");
      process.stdout.write(`${JSON.stringify(assertTrustedGitHubDeployment())}\n`);
    }
    else if (command === "release-readiness") process.stdout.write(`${JSON.stringify(releaseReadiness({ environment: options.environment, deploymentReady: options.deployment_ready === "true" }))}\n`);
    else if (new Set(["validate", "preview", "deploy"]).has(command)) run(command, options);
    else throw new Error("command must be validate, preview, deploy, receipt, assert-github-deployment, or release-readiness");
  } catch (error) {
    process.stderr.write(`deployment-controller: ${error.message}\n`);
    process.exitCode = 1;
  }
}
