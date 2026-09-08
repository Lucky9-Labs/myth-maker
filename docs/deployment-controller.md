# CI-owned deployment controller

Only GitHub Actions may deploy Myth Maker infrastructure or runtime services.
Implementation workers, local developer commands, and pull requests have no
deployment path. This controller makes the deployment trust boundary explicit:

```text
pull request -> non-mutating checks/previews only
validated push to main -> environment-scoped CI deployment
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

Create GitHub Environments named `dev`, `staging`, and `production` to isolate
secrets, but do not configure required reviewers: successful validated commits
to `main` deploy automatically. Store only the indicated provider credentials
in the environment that needs them:

| Environment-gated provider job | Secrets it reads |
| --- | --- |
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `TF_VAR_agent_ingress_token`, `TF_VAR_work_dispatch_token` |
| Railway | `TF_VAR_railway_token`, `WORK_DISPATCH_TOKEN`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` |
| Modal | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `OPENAI_API_KEY` |

The environment boundary lives in the shared executor, before any credential is
passed to a command. A provider job receives only its own listed names. Do not
use `secrets: inherit` in the dispatcher workflow. The Terraform foundation
job additionally needs `TF_BACKEND_CONFIG` for the approved remote backend and
the non-secret GitHub Environment variables described by
`infra/terraform/variables.tf` (account/workspace IDs, dispatcher URL, and
explicit `MANAGE_*` flags).

Bootstrap is intentionally fail-closed: before automatic main deployment is
enabled, configure branch protection to require the PR preview and configure
the environment secrets, approved backend config, and every `MANAGE_*` value.
Missing configuration stops in the Terraform preflight and uploads a failure
receipt; an arbitrary direct main push is not treated as validated by this
repository alone.

The `Reviewed deployment` workflow runs automatically for covered changes on
`main`; its name is retained for compatibility. A manual dispatch is only for
recovery/retry and may optionally name a full 40-character SHA. Both paths
require a SHA already reachable from `origin/main`, check out exactly that SHA,
reject a dirty checkout, and lock the exact `(provider, environment)` pair with
`cancel-in-progress: false`. A duplicate request queues rather than overlapping
the active deployment. Modal and Terraform foundation may run in parallel;
Railway follows the foundation, and Cloudflare is deliberately serialized after
all three because its worker binding points at the Railway dispatcher, which in
turn acknowledges `x-work-id` for Modal work.

## Terraform adapter and PR #7

PR #7's merged `infra/terraform` foundation is now exercised by the preview
workflow using only:

```sh
terraform -chdir=infra/terraform init -backend=false -input=false
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -refresh=false -lock=false -input=false
```

That deliberately does not authenticate, lock remote state, refresh, or apply.
For an automatic `main` deployment, the CI-only Terraform phase initializes the
approved remote backend, builds an exact plan, records its SHA-256, and applies
that same saved plan. A manual recovery can supply an expected plan SHA-256 and
will fail if the generated plan differs. It never falls back to local state or
synthesizes backend credentials.

The additive `deployment_receipt_facts` Terraform output supplies Cloudflare
worker/version/deployment IDs, Railway project/environment/service IDs, module
SHA-256s, and configured non-secret variable names when those resources are
managed; disabled resources are null or empty. Modal CLI output is not assumed
to be JSON, so its receipt must mark a deployment ID unavailable until a
parseable CLI/API seam is added—never invent an ID.

Current release status is intentionally conservative: the Terraform foundation
may create non-version Cloudflare identity/state, but Worker version promotion
is blocked until the Railway dispatcher exposes a verified `x-work-id`
acknowledgement adapter. Railway is likewise an unsupported/failure receipt,
not a successful deployment, until that adapter and its source exist.

## Receipts and build-room consumption

Every provider execution writes and uploads
`deployment-receipt-<provider>-<environment>-<sha>` containing:

- provider, environment, immutable source SHA, source-build/target version IDs;
- success/failure status and UTC start/completion timestamps;
- checkout/provider-command verification result; and
- provider-specific target metadata (including Cloudflare module SHA-256s).

The Terraform foundation also uploads a non-secret companion receipt keyed by
the same environment and source SHA. It supplies the provider IDs and configured
variable names from `deployment_receipt_facts`; build-room consumers should join
it with the three provider receipts before presenting a fully verified release.

The build-room viewer or coordinator should download the artifacts by this
stable name, parse only `myth-maker.deployment-receipt/v1`, and display a
provider as deployed only when `status` is `success` and the verification result
is successful. Receipts are evidence of CI execution, not evidence that a
generated encounter is accepted by the Unity host.

On a failed command, the receipt is uploaded with `status: failure` for the
build-room/coordinator to consume. Automatic rollback is intentionally not
attempted until the receipt contains a verified prior provider version ID and a
provider-specific rollback command; guessing a rollback target would be less
safe than reporting the failure.
