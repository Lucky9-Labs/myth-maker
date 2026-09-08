import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDeploymentRequest,
  createReceipt,
  deploymentConcurrencyGroup,
  parseModalDeploymentEvidence,
  providerDefinitions,
  providerCommand,
  releaseReadiness,
  trustedDeploymentContext,
  validateGitHubOidcClaims,
  selectProviderOutcome,
  validateProviderRequest,
} from "../scripts/deployment/controller.mjs";
import { classifyPreviewPaths } from "../scripts/deployment/preview-scope.mjs";

test("pull-request requests are validation-only and cannot deploy", () => {
  const result = validateProviderRequest({
    eventName: "pull_request",
    mode: "preview",
    provider: "cloudflare",
    environment: "dev",
  });
  assert.equal(result.mutating, false);
  assert.throws(
    () => validateProviderRequest({
      eventName: "pull_request",
      mode: "deploy",
      provider: "cloudflare",
      environment: "dev",
    }),
    /manual workflow dispatch/,
  );
});

test("a trusted main push deploys only an immutable clean SHA", () => {
  assert.equal(assertDeploymentRequest({
    eventName: "push",
    sourceSha: "a".repeat(40),
    checkoutSha: "a".repeat(40),
    isReachableFromMain: true,
    isClean: true,
  }).sourceSha, "a".repeat(40));

  for (const invalid of [
    { eventName: "pull_request", sourceSha: "a".repeat(40), checkoutSha: "a".repeat(40), isReachableFromMain: true, isClean: true },
    { eventName: "workflow_dispatch", sourceSha: "not-a-sha", checkoutSha: "not-a-sha", isReachableFromMain: true, isClean: true },
    { eventName: "workflow_dispatch", sourceSha: "a".repeat(40), checkoutSha: "a".repeat(40), isReachableFromMain: false, isClean: true },
    { eventName: "workflow_dispatch", sourceSha: "a".repeat(40), checkoutSha: "a".repeat(40), isReachableFromMain: true, isClean: false },
  ]) {
    assert.throws(() => assertDeploymentRequest(invalid));
  }
});

test("a deploy request derives its immutable source from trusted GitHub Actions context", () => {
  const sourceSha = "a".repeat(40);
  assert.deepEqual(trustedDeploymentContext({
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sourceSha,
  }), { eventName: "push", sourceSha });

  for (const environment of [
    {},
    { GITHUB_ACTIONS: "false", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sourceSha },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/15/merge", GITHUB_SHA: sourceSha },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feature", GITHUB_SHA: sourceSha },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "not-a-sha" },
  ]) {
    assert.throws(() => trustedDeploymentContext(environment), /trusted GitHub Actions/);
  }
});

test("legacy all-provider readiness remains fail-closed while Modal has its own independent path", () => {
  assert.deepEqual(releaseReadiness({ environment: "dev", deploymentReady: false }), {
    ready: false,
    reason: "DEPLOYMENT_READY is not true; no provider command was invoked",
  });
  assert.deepEqual(releaseReadiness({ environment: "dev", deploymentReady: true }), {
    ready: false,
    reason: "provider deploy commands are unavailable: cloudflare, railway",
  });
});

test("GitHub OIDC claims bind a provider executor to this repository, main, and one SHA", () => {
  const trusted = { eventName: "push", sourceSha: "a".repeat(40) };
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    repository: "Lucky9-Labs/myth-maker",
    ref: "refs/heads/main",
    sha: trusted.sourceSha,
  };
  assert.equal(validateGitHubOidcClaims(claims, trusted), true);
  for (const altered of [
    { ...claims, repository: "example/other" },
    { ...claims, ref: "refs/heads/feature" },
    { ...claims, sha: "b".repeat(40) },
  ]) {
    assert.throws(() => validateGitHubOidcClaims(altered, trusted), /OIDC identity/);
  }
});

test("provider-environment locks isolate providers and serialize duplicates", () => {
  const first = deploymentConcurrencyGroup("cloudflare", "production");
  assert.equal(first, deploymentConcurrencyGroup("cloudflare", "production"));
  assert.notEqual(first, deploymentConcurrencyGroup("railway", "production"));
  assert.notEqual(first, deploymentConcurrencyGroup("cloudflare", "staging"));
});

test("the provider interface has separate least-privilege credentials", () => {
  assert.deepEqual(Object.keys(providerDefinitions).sort(), ["cloudflare", "modal", "railway"]);
  assert.deepEqual(providerDefinitions.cloudflare.secretNames, []);
  assert.deepEqual(providerDefinitions.railway.secretNames, ["RAILWAY_TOKEN"]);
  assert.deepEqual(providerDefinitions.modal.secretNames, ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"]);
});

test("an unsupported Railway deployment is skipped rather than presented as a preview or success", () => {
  assert.throws(
    () => validateProviderRequest({ eventName: "pull_request", mode: "deploy", provider: "railway", environment: "dev" }),
  );
  const receipt = createReceipt({
    provider: "railway", environment: "dev", sourceSha: "a".repeat(40), status: "failure",
    startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z",
    verification: { provider_command_outcome: "failure" },
  });
  assert.equal(receipt.status, "failure");
  assert.equal(receipt.verification.provider_command_outcome, "failure");
  const result = spawnSync(process.execPath, [
    "scripts/deployment/controller.mjs", "preview", "--event", "pull_request", "--provider", "railway", "--environment", "dev",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status":"skipped"/);
});

test("only non-mutating provider checks run on a pull request, and local deploy commands fail closed", () => {
  assert.deepEqual(providerCommand("cloudflare", "preview", "dev"), [
    "npx", ["--yes", "wrangler@4.37.0", "deploy", "--dry-run", "--config", "wrangler.jsonc"],
  ]);
  assert.deepEqual(providerCommand("modal", "preview", "dev"), [
    "python3", ["modal/infrastructure.py", "--environment", "dev", "--check-files"],
  ]);
  assert.equal(providerCommand("railway", "preview", "dev"), null);

  const localDeploy = spawnSync(process.execPath, [
    "scripts/deployment/controller.mjs", "deploy", "--provider", "cloudflare", "--environment", "dev",
  ], { encoding: "utf8" });
  assert.notEqual(localDeploy.status, 0, localDeploy.stdout);
  assert.match(localDeploy.stderr, /trusted GitHub Actions context/);
  const callerOverride = spawnSync(process.execPath, [
    "scripts/deployment/controller.mjs", "deploy", "--event", "push", "--checkout-sha", "a".repeat(40), "--provider", "cloudflare", "--environment", "dev",
  ], { encoding: "utf8" });
  assert.notEqual(callerOverride.status, 0, callerOverride.stdout);
  assert.match(callerOverride.stderr, /not CLI arguments/);
});

test("Modal receipts accept only parsed deployment and healthy resource evidence", () => {
  assert.deepEqual(parseModalDeploymentEvidence(JSON.stringify({
    deployment_id: "depl-123",
    version_id: "ver-123",
    resource_ids: ["volume-123", "dict-123"],
    health: { status: "healthy", dedicated_secret_verified: true, verified_secret_name: "myth-maker-encounter-openai" },
    dispatch: { status: "completed", function_call_id: "fc-123", function_id: "fu-123", input_id: "in-123", worker_id: "in-123" },
  })), {
    deployment_id: "depl-123",
    version_id: "ver-123",
    resource_ids: ["volume-123", "dict-123"],
    health: { status: "healthy", dedicated_secret_verified: true, verified_secret_name: "myth-maker-encounter-openai" },
    dispatch: { status: "completed", function_call_id: "fc-123", function_id: "fu-123", input_id: "in-123", worker_id: "in-123" },
  });
  for (const output of ["not-json", JSON.stringify({ deployment_id: "depl-123" }), JSON.stringify({
    deployment_id: "depl-123", version_id: "ver-123", resource_ids: [], health: { status: "unhealthy" },
  })]) {
    assert.throws(() => parseModalDeploymentEvidence(output), /Modal deployment/);
  }
});

test("receipt outcome selects the invoked provider, never an earlier skipped step", () => {
  assert.equal(selectProviderOutcome("modal", { cloudflare: "skipped", railway: "skipped", modal: "success" }), "success");
  assert.equal(selectProviderOutcome("railway", { cloudflare: "skipped", railway: "failure", modal: "skipped" }), "failure");
});

test("workflows use non-mutating PR previews and provider locks", async () => {
  const [prWorkflow, deployWorkflow, executor, terraformFoundation] = await Promise.all([
    readFile(new URL("../.github/workflows/deployment-preview.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/provider-executor.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/terraform-foundation.yml", import.meta.url), "utf8"),
  ]);

  assert.match(prWorkflow, /pull_request:/);
  assert.doesNotMatch(prWorkflow, /pull_request:\n\s+paths:/);
  assert.match(prWorkflow, /deployment-change-scope:/);
  for (const provider of ["terraform", "cloudflare", "railway", "modal"]) {
    assert.match(prWorkflow, new RegExp(`needs\\.deployment-change-scope\\.outputs\\.${provider} != 'true'`));
    assert.match(prWorkflow, new RegExp(`needs\\.deployment-change-scope\\.outputs\\.${provider} == 'true'`));
  }
  assert.match(prWorkflow, /controller\.mjs preview/);
  assert.doesNotMatch(prWorkflow, /secrets: inherit/);
  assert.match(deployWorkflow, /workflow_dispatch:/);
  assert.match(deployWorkflow, /push:/);
  assert.match(deployWorkflow, /branches: \[main\]/);
  assert.match(deployWorkflow, /github\.sha/);
  assert.match(deployWorkflow, /assert-deployment-input/);
  assert.match(deployWorkflow, /write-unavailable-provider-receipts/);
  assert.match(deployWorkflow, /Modal deployment proceeds independently/);
  assert.doesNotMatch(deployWorkflow, /release-readiness/);
  assert.doesNotMatch(deployWorkflow, /DEPLOYMENT_READY/);
  assert.match(deployWorkflow, /modal:\n\s+needs: assert-deployment-input/);
  assert.match(deployWorkflow, /MODAL_TOKEN_ID: \$\{\{ secrets\.MODAL_TOKEN_ID \}\}/);
  assert.doesNotMatch(deployWorkflow, /uses: \.\/\.github\/workflows\/provider-modal\.yml/);
  assert.match(deployWorkflow, /id-token: write/);
  assert.match(executor, /myth-maker-deploy-\$\{\{ inputs\.provider \}\}-\$\{\{ inputs\.environment \}\}/);
  assert.match(executor, /cancel-in-progress: false/);
  assert.match(executor, /if: inputs\.provider == 'cloudflare'/);
  assert.match(executor, /if: inputs\.provider == 'railway'/);
  assert.match(executor, /if: inputs\.provider == 'modal'/);
  assert.match(executor, /MODAL_TOKEN_ID: \$\{\{ secrets\.MODAL_TOKEN_ID \}\}/);
  assert.match(executor, /modal==1\.4\.0/);
  assert.match(executor, /assert-github-deployment/);
  assert.match(executor, /id-token: write/);
  assert.doesNotMatch(executor, /controller\.mjs deploy --event/);
  assert.doesNotMatch(executor, /CLOUDFLARE_API_TOKEN:[\s\S]{0,400}MODAL_TOKEN_SECRET:/);
  assert.match(terraformFoundation, /init -reconfigure/);
  assert.match(terraformFoundation, /reviewed\.tfplan/);
  assert.match(terraformFoundation, /deployment_receipt_facts/);
  assert.match(terraformFoundation, /id-token: write/);

  const preview = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/deployment-preview.yml"],
    { encoding: "utf8" },
  ));
  const deploy = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/deploy.yml"],
    { encoding: "utf8" },
  ));
  assert.match(deploy.jobs["write-unavailable-provider-receipts"].steps[0].uses, /^actions\/checkout@/);
  for (const job of [
    "terraform-foundation-preview",
    "cloudflare-preview",
    "railway-preview",
    "modal-preview",
  ]) {
    assert.equal(preview.jobs[job].if, undefined, `${job} must always emit its required context`);
    assert.equal(preview.jobs[job].needs, "deployment-change-scope");
  }
});

test("preview scope emits explicit no-op contexts for unrelated pull request files", () => {
  assert.deepEqual(classifyPreviewPaths(["README.md", "docs/gameplay.md"]), {
    terraform: false,
    cloudflare: false,
    railway: false,
    modal: false,
  });

  assert.deepEqual(classifyPreviewPaths(["infra/terraform/main.tf"]), {
    terraform: true,
    cloudflare: false,
    railway: false,
    modal: false,
  });
  assert.deepEqual(classifyPreviewPaths(["src/railway-server.js", "railway.json"]), {
    terraform: false,
    cloudflare: false,
    railway: true,
    modal: false,
  });
  assert.deepEqual(classifyPreviewPaths(["modal/infrastructure.py"]), {
    terraform: false,
    cloudflare: false,
    railway: false,
    modal: true,
  });
  assert.deepEqual(classifyPreviewPaths(["scripts/deployment/controller.mjs"]), {
    terraform: true,
    cloudflare: true,
    railway: true,
    modal: true,
  });
});

test("preview scope CLI writes GitHub Actions outputs for an empty diff", () => {
  const output = execFileSync(process.execPath, [
    "scripts/deployment/preview-scope.mjs", "--base", "HEAD", "--head", "HEAD",
  ], { encoding: "utf8" });
  assert.equal(output, "terraform=false\ncloudflare=false\nrailway=false\nmodal=false\n");
});

test("Modal activation consumes environment secrets in the top-level deployment job", () => {
  const workflow = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/deploy.yml"],
    { encoding: "utf8" },
  ));
  const direct = workflow.jobs.modal;
  const steps = direct.steps;
  const modal = steps.find((step) => step.id === "modal").env;
  const receipt = steps.find((step) => typeof step.name === "string" && step.name.startsWith("Write machine-readable Modal receipt")).env;
  assert.equal(direct.environment.name, "${{ inputs.environment || 'dev' }}");
  assert.equal(direct.concurrency.group, "myth-maker-deploy-modal-${{ inputs.environment || 'dev' }}");
  assert.deepEqual(Object.keys(modal).sort(), ["DEPLOYMENT_ENVIRONMENT", "MODAL_EVIDENCE_PATH", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY", "RESULT"]);
  assert.match(JSON.stringify(modal), /secrets\.MODAL_TOKEN_ID/);
  assert.doesNotMatch(JSON.stringify(receipt), /TOKEN|OPENAI/);
  assert.deepEqual(Object.keys(receipt).sort(), ["DEPLOYMENT_ENVIRONMENT", "MODAL_OUTCOME", "MODAL_STATUS", "PREFLIGHT_OUTCOME", "RESULT", "SOURCE_SHA", "STARTED_AT"]);
});
