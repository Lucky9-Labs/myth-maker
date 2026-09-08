# CI-owned deployment controller

Only GitHub Actions may deploy Myth Maker infrastructure or runtime services.
Implementation workers, local developer commands, and pull requests have no
deployment path. This controller makes the deployment trust boundary explicit:

```text
pull request -> non-mutating checks/previews only
manual dispatch + immutable main SHA -> reviewed GitHub Environment
  -> Modal and Railway (parallel)
  -> Cloudflare (after both dispatch dependencies are ready)
  -> one JSON receipt artifact per provider
```

The reusable workflows in `.github/workflows/provider-*.yml` each call the
shared executor with one provider identifier. `scripts/deployment/controller.mjs`
is the extensible provider interface: adding a provider requires a definition
with its pinned tool command, required local files, secret names, and receipt
metadata, plus a thin provider workflow. It executes argument arrays rather
than shell strings and never prints environment values.

## Required repository configuration

Create GitHub Environments named `dev`, `staging`, and `production`, and require
the appropriate reviewers before deployment. Store only the indicated provider
credentials in the environment that needs them:

| Environment-gated provider job | Secrets it reads |
| --- | --- |
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `TF_VAR_agent_ingress_token`, `TF_VAR_work_dispatch_token` |
| Railway | `RAILWAY_TOKEN`, `TF_VAR_railway_token`, `WORK_DISPATCH_TOKEN` |
| Modal | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `OPENAI_API_KEY` |

The environment gate lives in the shared executor, before any credential is
passed to a command. A provider job receives only its own listed names. Do not
use `secrets: inherit` in the dispatcher workflow.

Run **Reviewed deployment** only with an exact 40-character commit SHA that is
already reachable from `origin/main`. The workflow checks out that SHA, rejects
a dirty checkout, and locks the exact `(provider, environment)` pair with
`cancel-in-progress: false`. A duplicate request therefore queues rather than
overlapping the active deployment. Modal and Railway are independent and run in
parallel; Cloudflare is deliberately serialized after them because its worker
binding points at the Railway dispatcher, which in turn acknowledges `x-work-id`
for Modal work.

## Terraform adapter and PR #7

On current main, `infra/terraform` does not exist. The PR preview workflow
detects that state and records an adapter skip rather than guessing a backend or
creating resources. Once PR #7 lands, its preview performs only:

```sh
terraform -chdir=infra/terraform init -backend=false -input=false
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -refresh=false -lock=false -input=false
```

That deliberately does not authenticate, lock remote state, refresh, or apply.
The reviewed deployment still uses the provider CLIs for the runtime artifacts.
Terraform state initialization/application remains a separate CI-only,
environment-reviewed foundation phase until PR #7 publishes its team-approved
encrypted backend and a reviewed-plan digest contract. It must use the PR's
existing remote backend configuration; this controller will not fall back to
local state or synthesize backend credentials.

PR #7's expected adapter inputs are preserved here: Cloudflare emits module
digests and declares `WORK_DISPATCH_URL`/`WORK_DISPATCH_TOKEN`; Railway records
its dispatcher service and `WORK_DISPATCH_TOKEN`; Modal records the draft app,
Volume, and lease dictionary. The exact provider version/deployment IDs are
collected by the future foundation phase after its provider interface is merged;
the current receipt marks source-build and target identifiers without claiming
that an unavailable provider API returned a deployment ID.

## Receipts and build-room consumption

Every provider execution writes and uploads
`deployment-receipt-<provider>-<environment>-<sha>` containing:

- provider, environment, immutable source SHA, source-build/target version IDs;
- success/failure status and UTC start/completion timestamps;
- checkout/provider-command verification result; and
- provider-specific target metadata (including Cloudflare module SHA-256s).

The build-room viewer or coordinator should download the artifacts by this
stable name, parse only `myth-maker.deployment-receipt/v1`, and display a
provider as deployed only when `status` is `success` and the verification result
is successful. Receipts are evidence of CI execution, not evidence that a
generated encounter is accepted by the Unity host.
