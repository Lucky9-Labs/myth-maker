import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDeploymentRequest,
  createReceipt,
  deploymentConcurrencyGroup,
  parseCloudflareDeploymentEvidence,
  parseModalDeploymentEvidence,
  providerDefinitions,
  providerCommand,
  releaseReadiness,
  trustedDeploymentContext,
  validateGitHubOidcClaims,
  selectProviderOutcome,
  validateCloudflareWorkerUrl,
  validateProviderRequest,
  verifyCloudflareDiscoveryResponse,
} from "../scripts/deployment/controller.mjs";
import { canonicalJson } from "../src/package-discovery.js";
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

test("all provider deployment commands are ready only when every provider has an activation path", () => {
  assert.deepEqual(releaseReadiness({ environment: "dev", deploymentReady: false }), {
    ready: false,
    reason: "DEPLOYMENT_READY is not true; no provider command was invoked",
  });
  assert.deepEqual(releaseReadiness({ environment: "dev", deploymentReady: true }), {
    ready: true,
    reason: "environment bootstrap and provider commands are ready",
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
  assert.deepEqual(providerDefinitions.cloudflare.secretNames, ["CLOUDFLARE_API_TOKEN", "AGENT_INGRESS_TOKEN", "PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY"]);
  assert.deepEqual(providerDefinitions.railway.secretNames, ["RAILWAY_TOKEN"]);
  assert.deepEqual(providerDefinitions.modal.secretNames, ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"]);
});

test("Cloudflare receipts require the deployed current Worker version and bound secret names", () => {
  const versionId = "1b2c3d4e-1234-4567-8abc-1234567890ab";
  assert.deepEqual(parseCloudflareDeploymentEvidence(JSON.stringify({
    version_id: versionId,
    worker_url: "https://myth-maker-encounter-runtime.example.workers.dev",
    secret_bindings: ["AGENT_INGRESS_TOKEN", "PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY"],
  })), {
    version_id: versionId,
    worker_url: "https://myth-maker-encounter-runtime.example.workers.dev",
    secret_bindings: ["AGENT_INGRESS_TOKEN", "PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY"],
  });
  for (const output of ["not-json", JSON.stringify({ version_id: versionId }), JSON.stringify({
    version_id: versionId, secret_bindings: ["AGENT_INGRESS_TOKEN"],
  })]) {
    assert.throws(() => parseCloudflareDeploymentEvidence(output), /Cloudflare deployment evidence/);
  }
});

test("the live Cloudflare URL must route directly to the Worker whose version is receipted", () => {
  assert.equal(validateCloudflareWorkerUrl("https://myth-maker-encounter-runtime.example.workers.dev/", "myth-maker-encounter-runtime"), "https://myth-maker-encounter-runtime.example.workers.dev");
  for (const url of [
    "https://another-worker.example.workers.dev/",
    "https://myth-maker-encounter-runtime.example.workers.dev/v1",
    "http://myth-maker-encounter-runtime.example.workers.dev/",
    "https://myth-maker-encounter-runtime.example.test/",
  ]) {
    assert.throws(() => validateCloudflareWorkerUrl(url, "myth-maker-encounter-runtime"), /CLOUDFLARE_WORKER_URL/);
  }
});

test("live Cloudflare discovery verification accepts only verified signed selections or explicit no-package results", async () => {
  const context = { encounterId: "encounter-live-001", requestId: "ci-discovery-001" };
  assert.deepEqual(await verifyCloudflareDiscoveryResponse({
    schema_version: "1", status: "no_package", encounter_id: context.encounterId, request_id: context.requestId,
    reason: "no_accepted_compatible_package",
  }, context), { encounter_id: context.encounterId, request_id: context.requestId, status: "no_package" });
  const manifest = {
    schema_version: "1", manifest_id: "discovery-live-001", encounter_id: context.encounterId, request_id: context.requestId,
    package_id: "package-live-001", package_revision: 1, package_manifest_sha256: "a".repeat(64),
    assembly_receipt_id: "receipt-live-001", assembly_receipt_sha256: "b".repeat(64),
    catalog_revision_id: "catalog-live-001", catalog_revision_sha256: "c".repeat(64),
    artifacts: [{ module_id: "body-live-001", revision: 1, uri: "https://artifacts.example.test/body.glb", sha256: "d".repeat(64), media_type: "model/gltf-binary", byte_length: 1 }],
    issued_at: "2026-09-08T00:00:00Z",
  };
  const privateKey = await crypto.subtle.importKey("pkcs8", Buffer.from("MC4CAQAwBQYDK2VwBCIEII2uBd4SxWoOh7s251KvvH03Hyx3kfMAZTwku//Ga3A4", "base64"), { name: "Ed25519" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalJson(manifest)))).toString("base64url");
  const signingPublicKey = "MCowBQYDK2VwAyEA45D06/XjPdHC8dvH1W/4IIhmHRXsmeyPSOBrSDNcBpY=";
  assert.deepEqual(await verifyCloudflareDiscoveryResponse({
    schema_version: "1", status: "selected", encounter_id: context.encounterId, request_id: context.requestId,
    manifest: { ...manifest, signature: { algorithm: "Ed25519", key_id: "package-discovery-ed25519-v1", value: signature } },
  }, { ...context, signingPublicKey }), { encounter_id: context.encounterId, request_id: context.requestId, status: "selected" });
  await assert.rejects(() => verifyCloudflareDiscoveryResponse({
    schema_version: "1", status: "selected", encounter_id: context.encounterId, request_id: context.requestId,
    manifest: { ...manifest, signature: { algorithm: "Ed25519", key_id: "package-discovery-ed25519-v1", value: "A".repeat(86) } },
  }, { ...context, signingPublicKey }), /invalid Ed25519 signature/);
});

test("a Railway preview stays non-mutating while deployment requires GitHub context", () => {
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
    "npx", ["--yes", "wrangler@4.130.0", "deploy", "--dry-run", "--config", "wrangler.jsonc"],
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
  assert.match(deployWorkflow, /railway:[\s\S]*?RAILWAY_TOKEN: \$\{\{ secrets\.RAILWAY_TOKEN \}\}/);
  assert.match(deployWorkflow, /id-token: write/);
  assert.match(executor, /myth-maker-deploy-\$\{\{ inputs\.provider \}\}-\$\{\{ inputs\.environment \}\}/);
  assert.match(executor, /cancel-in-progress: false/);
  assert.match(executor, /if: inputs\.provider == 'cloudflare'/);
  assert.match(executor, /PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(executor, /CLOUDFLARE_WORKER_URL: \$\{\{ vars\.CLOUDFLARE_WORKER_URL \}\}/);
  assert.match(executor, /PACKAGE_DISCOVERY_SIGNING_PUBLIC_KEY: \$\{\{ vars\.PACKAGE_DISCOVERY_SIGNING_PUBLIC_KEY \}\}/);
  assert.match(executor, /Verify authenticated encounter-scoped package discovery live/);
  assert.match(executor, /id: discovery/);
  assert.match(executor, /CLOUDFLARE_DISCOVERY_OUTCOME: \$\{\{ steps\.discovery\.outcome \}\}/);
  assert.match(executor, /\"\$PROVIDER\" != cloudflare \|\| \"\$DISCOVERY_OUTCOME\" == success/);
  assert.match(executor, /if: inputs\.provider == 'railway'/);
  assert.match(executor, /provider command did not produce parseable result/);
  assert.match(executor, /assert-github-deployment/);
  assert.match(executor, /id-token: write/);
  assert.doesNotMatch(executor, /controller\.mjs deploy --event/);
  assert.doesNotMatch(executor, /CLOUDFLARE_API_TOKEN:[\s\S]{0,400}MODAL_TOKEN_SECRET:/);
  assert.match(terraformFoundation, /init -reconfigure/);
  assert.match(terraformFoundation, /reviewed\.tfplan/);
  assert.match(terraformFoundation, /deployment_receipt_facts/);
  assert.match(terraformFoundation, /id-token: write/);
  assert.match(terraformFoundation, /TF_VAR_package_discovery_signing_private_key: \$\{\{ secrets\.PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(terraformFoundation, /TF_VAR_catalog_acceptance_token: \$\{\{ secrets\.CATALOG_ACCEPTANCE_TOKEN \}\}/);
  assert.match(terraformFoundation, /TF_VAR_railway_token: \$\{\{ secrets\.RAILWAY_TOKEN \}\}/);
  assert.doesNotMatch(terraformFoundation, /secrets\.TF_VAR_(?:package_discovery_signing_private_key|catalog_acceptance_token|railway_token)/);

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
  const railwayProvider = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/provider-railway.yml"],
    { encoding: "utf8" },
  ));
  const cloudflareConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.match(deploy.jobs["write-unavailable-provider-receipts"].steps[0].uses, /^actions\/checkout@/);
  assert.equal(railwayProvider.jobs.deploy.secrets, "inherit");
  assert.deepEqual(cloudflareConfig.secrets.required, ["AGENT_INGRESS_TOKEN", "PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY"]);
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

test("environment-scoped provider activation consumes secrets in top-level deployment jobs", () => {
  const workflow = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/deploy.yml"],
    { encoding: "utf8" },
  ));
  const direct = workflow.jobs.modal;
  const steps = direct.steps;
  const modal = steps.find((step) => step.id === "modal").env;
  const receiptStep = steps.find((step) => typeof step.name === "string" && step.name.startsWith("Write machine-readable Modal receipt"));
  const receipt = receiptStep.env;
  assert.equal(direct.environment.name, "${{ inputs.environment || 'dev' }}");
  assert.equal(direct.concurrency.group, "myth-maker-deploy-modal-${{ inputs.environment || 'dev' }}");
  assert.deepEqual(Object.keys(modal).sort(), ["DEPLOYMENT_ENVIRONMENT", "MODAL_EVIDENCE_PATH", "MODAL_IMAGE_BUILDER_VERSION", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY", "RESULT"]);
  assert.match(JSON.stringify(modal), /secrets\.MODAL_TOKEN_ID/);
  assert.doesNotMatch(JSON.stringify(receipt), /TOKEN|OPENAI/);
  assert.deepEqual(Object.keys(receipt).sort(), ["DEPLOYMENT_ENVIRONMENT", "MODAL_OUTCOME", "MODAL_STATUS", "PREFLIGHT_OUTCOME", "RESULT", "SOURCE_SHA", "STARTED_AT"]);
  assert.match(receiptStep.run, /trusted_github_context=false/);
  assert.match(receiptStep.run, /if \[\[ "\$PREFLIGHT_OUTCOME" == success \]\]; then/);
  assert.doesNotMatch(receiptStep.run, /\\"\$PREFLIGHT_OUTCOME\\"/);

  const railway = workflow.jobs.railway;
  const railwayDeploy = railway.steps.find((step) => step.id === "railway").env;
  const railwayReceiptStep = railway.steps.find((step) => typeof step.name === "string" && step.name.startsWith("Write machine-readable Railway receipt"));
  assert.equal(railway.environment.name, "${{ inputs.environment || 'dev' }}");
  assert.equal(railway.concurrency.group, "myth-maker-deploy-railway-${{ inputs.environment || 'dev' }}");
  assert.match(railwayDeploy.RAILWAY_TOKEN, /secrets\.RAILWAY_TOKEN/);
  assert.doesNotMatch(JSON.stringify(railwayReceiptStep.env), /RAILWAY_TOKEN/);
  assert.equal(railway.uses, undefined);

  const cloudflare = workflow.jobs.cloudflare;
  const cloudflareDeploy = cloudflare.steps.find((step) => step.id === "deploy").env;
  const cloudflareDiscovery = cloudflare.steps.find((step) => step.id === "discovery").env;
  const cloudflareReceiptStep = cloudflare.steps.find((step) => typeof step.name === "string" && step.name.startsWith("Write machine-readable Cloudflare receipt"));
  assert.equal(cloudflare.environment.name, "${{ inputs.environment || 'dev' }}");
  assert.equal(cloudflare.concurrency.group, "myth-maker-deploy-cloudflare-${{ inputs.environment || 'dev' }}");
  assert.match(cloudflareDeploy.CLOUDFLARE_API_TOKEN, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.equal(cloudflareDiscovery.PACKAGE_DISCOVERY_SIGNING_PUBLIC_KEY, "MCowBQYDK2VwAyEAt1H5uJR0eCDxb2C4uHf+vRovjT9UJtCr5VBVYit1rgM=");
  assert.match(JSON.stringify(cloudflareReceiptStep.env), /steps\.discovery\.outcome/);
  assert.doesNotMatch(JSON.stringify(cloudflareReceiptStep.env), /AGENT_INGRESS_TOKEN|PRIVATE_KEY/);
  assert.equal(cloudflare.uses, undefined);
});
