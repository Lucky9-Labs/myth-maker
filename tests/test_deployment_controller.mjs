import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDeploymentRequest,
  createReceipt,
  deploymentConcurrencyGroup,
  providerDefinitions,
  validateProviderRequest,
} from "../scripts/deployment/controller.mjs";

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

test("provider-environment locks isolate providers and serialize duplicates", () => {
  const first = deploymentConcurrencyGroup("cloudflare", "production");
  assert.equal(first, deploymentConcurrencyGroup("cloudflare", "production"));
  assert.notEqual(first, deploymentConcurrencyGroup("railway", "production"));
  assert.notEqual(first, deploymentConcurrencyGroup("cloudflare", "staging"));
});

test("the provider interface has separate least-privilege credentials", () => {
  assert.deepEqual(Object.keys(providerDefinitions).sort(), ["cloudflare", "modal", "railway"]);
  assert.deepEqual(providerDefinitions.cloudflare.secretNames, ["CLOUDFLARE_API_TOKEN", "TF_VAR_agent_ingress_token", "TF_VAR_work_dispatch_token"]);
  assert.deepEqual(providerDefinitions.railway.secretNames, ["TF_VAR_railway_token", "WORK_DISPATCH_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]);
  assert.deepEqual(providerDefinitions.modal.secretNames, ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"]);
});

test("an unsupported Railway deployment fails instead of producing a success", () => {
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
});

test("workflows use non-mutating PR previews and provider locks", async () => {
  const [prWorkflow, deployWorkflow, executor, terraformFoundation] = await Promise.all([
    readFile(new URL("../.github/workflows/deployment-preview.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/provider-executor.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/terraform-foundation.yml", import.meta.url), "utf8"),
  ]);

  assert.match(prWorkflow, /pull_request:/);
  assert.match(prWorkflow, /controller\.mjs preview/);
  assert.doesNotMatch(prWorkflow, /secrets: inherit/);
  assert.match(deployWorkflow, /workflow_dispatch:/);
  assert.match(deployWorkflow, /push:/);
  assert.match(deployWorkflow, /branches: \[main\]/);
  assert.match(deployWorkflow, /github\.sha/);
  assert.match(deployWorkflow, /assert-deployment-input/);
  assert.match(executor, /myth-maker-deploy-\$\{\{ inputs\.provider \}\}-\$\{\{ inputs\.environment \}\}/);
  assert.match(executor, /cancel-in-progress: false/);
  assert.match(executor, /if: inputs\.provider == 'cloudflare'/);
  assert.match(executor, /if: inputs\.provider == 'railway'/);
  assert.match(executor, /if: inputs\.provider == 'modal'/);
  assert.doesNotMatch(executor, /CLOUDFLARE_API_TOKEN:[\s\S]{0,400}MODAL_TOKEN_SECRET:/);
  assert.match(terraformFoundation, /init -reconfigure/);
  assert.match(terraformFoundation, /reviewed\.tfplan/);
  assert.match(terraformFoundation, /deployment_receipt_facts/);
});
