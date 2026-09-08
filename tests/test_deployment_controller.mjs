import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDeploymentRequest,
  createReceipt,
  deploymentConcurrencyGroup,
  providerDefinitions,
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

test("provider-environment locks isolate providers and serialize duplicates", () => {
  const first = deploymentConcurrencyGroup("cloudflare", "production");
  assert.equal(first, deploymentConcurrencyGroup("cloudflare", "production"));
  assert.notEqual(first, deploymentConcurrencyGroup("railway", "production"));
  assert.notEqual(first, deploymentConcurrencyGroup("cloudflare", "staging"));
});

test("the provider interface has separate least-privilege credentials", () => {
  assert.deepEqual(Object.keys(providerDefinitions).sort(), ["cloudflare", "modal", "railway"]);
  assert.deepEqual(providerDefinitions.cloudflare.secretNames, ["CLOUDFLARE_API_TOKEN", "TF_VAR_agent_ingress_token", "TF_VAR_work_dispatch_token"]);
  assert.deepEqual(providerDefinitions.railway.secretNames, ["RAILWAY_TOKEN"]);
  assert.deepEqual(providerDefinitions.modal.secretNames, ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"]);
});

test("a Railway release requires a project-scoped token and explicit immutable target IDs", () => {
  const result = spawnSync(process.execPath, [
    "scripts/deployment/controller.mjs", "deploy", "--event", "push", "--provider", "railway", "--environment", "dev",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /RAILWAY_PROJECT_ID/);
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
  assert.match(executor, /myth-maker-deploy-\$\{\{ inputs\.provider \}\}-\$\{\{ inputs\.environment \}\}/);
  assert.match(executor, /cancel-in-progress: false/);
  assert.match(executor, /if: inputs\.provider == 'cloudflare'/);
  assert.match(executor, /if: inputs\.provider == 'railway'/);
  assert.match(executor, /if: inputs\.provider == 'modal'/);
  assert.doesNotMatch(executor, /CLOUDFLARE_API_TOKEN:[\s\S]{0,400}MODAL_TOKEN_SECRET:/);
  assert.match(terraformFoundation, /init -reconfigure/);
  assert.match(terraformFoundation, /reviewed\.tfplan/);
  assert.match(terraformFoundation, /deployment_receipt_facts/);
  const preview = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/deployment-preview.yml"],
    { encoding: "utf8" },
  ));
  for (const job of [
    "terraform-foundation-preview",
    "cloudflare-preview",
    "railway-preview",
    "modal-preview",
  ]) {
    assert.equal(preview.jobs[job].if, undefined, `${job} must always emit its required context`);
    assert.equal(preview.jobs[job].needs, "deployment-change-scope");
  }
  assert.match(executor, /RAILWAY_TOKEN/);
  assert.match(executor, /RAILWAY_PROJECT_ID/);
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

test("provider workflow preserves each step's common inputs and scoped secrets after YAML parsing", () => {
  const workflow = JSON.parse(execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", ".github/workflows/provider-executor.yml"],
    { encoding: "utf8" },
  ));
  const steps = workflow.jobs.deploy.steps;
  const cloudflare = steps.find((step) => step.id === "deploy").env;
  const railway = steps.find((step) => step.id === "railway").env;
  const modal = steps.find((step) => step.id === "modal").env;
  const receipt = steps.find((step) => step.name === "Write machine-readable receipt").env;
  assert.deepEqual(Object.keys(cloudflare).sort(), ["CLOUDFLARE_API_TOKEN", "DEPLOYMENT_ENVIRONMENT", "EVENT_NAME", "TF_VAR_agent_ingress_token", "TF_VAR_work_dispatch_token"]);
  assert.deepEqual(Object.keys(railway).sort(), ["DEPLOYMENT_ENVIRONMENT", "EVENT_NAME", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_TOKEN"]);
  assert.deepEqual(Object.keys(modal).sort(), ["DEPLOYMENT_ENVIRONMENT", "EVENT_NAME", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"]);
  assert.deepEqual(Object.keys(receipt).sort(), ["CLOUDFLARE_OUTCOME", "DEPLOYMENT_ENVIRONMENT", "MODAL_OUTCOME", "PREFLIGHT_OUTCOME", "PROVIDER", "RAILWAY_OUTCOME", "SOURCE_SHA"]);
});
