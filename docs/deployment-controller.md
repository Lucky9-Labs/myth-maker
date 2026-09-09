# CI-owned deployment controller

Only GitHub Actions may deploy Myth Maker infrastructure or runtime services.
Implementation workers, local developer commands, and pull requests have no
deployment path. This controller makes the deployment trust boundary explicit:

```text
pull request -> non-mutating checks/previews only
trusted GitHub Actions main event -> explicit environment bootstrap gate
  -> Cloudflare binds discovery secrets -> immutable Worker version -> live discovery probe
  -> unavailable providers: credential-free skipped receipts; no provider command
  -> one JSON receipt artifact per provider, never a fabricated success
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
to `main` deploy automatically. Optionally configure
`CLOUDFLARE_DISCOVERY_ENCOUNTER_ID` to probe a known accepted package; otherwise
CI uses its generic no-selection probe ID. The Worker URL is taken from the
current Wrangler deployment receipt and the pinned base64 SPKI is the explicit
dev signing identity, so neither is an unverified Environment variable. A
missing credential fails the Cloudflare job and emits a failure receipt; it
never claims a skipped or partial deployment. Store only
the indicated CLI credentials in the environment that needs them:

| Environment-gated provider job | Secrets it reads |
| --- | --- |
| Cloudflare adapter | `CLOUDFLARE_API_TOKEN`, `AGENT_INGRESS_TOKEN`, and `PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY` |
| Railway adapter | `RAILWAY_TOKEN`; the executor installs the pinned Railway CLI, uploads the exact trusted source revision to the configured service/environment, and polls for a `SUCCESS` deployment receipt |
| Modal adapter | None until a documented machine-readable deploy/health query seam exists |

The environment boundary lives in the shared executor, before any credential is
passed to a command. Runtime secrets stay in their owning Terraform or provider
seam and are never copied into an unrelated/no-op adapter. Cloudflare, Railway,
and Modal activation occur in their first-level environment jobs; do not use
`secrets: inherit` for the dispatcher workflow. The Terraform foundation job
additionally needs `TF_BACKEND_CONFIG` for the approved remote backend,
`CLOUDFLARE_API_TOKEN`, and the provider/runtime secrets using their owning
names: `RAILWAY_TOKEN`, `PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY`, and
`CATALOG_ACCEPTANCE_TOKEN`. The workflow maps those names to Terraform inputs;
do not duplicate them under `TF_VAR_*` GitHub secret names. Separately, the
Unity/client verification handoff reads the non-secret dev environment variables
`PACKAGE_DISCOVERY_SIGNING_PUBLIC_KEY_SPKI` and
`PACKAGE_DISCOVERY_SIGNING_KEY_ID=package-discovery-ed25519-v1`; Terraform does
not consume them. The job also uses the non-secret GitHub Environment variables described by
`infra/terraform/variables.tf` (account/workspace IDs, dispatcher URL, and
explicit `MANAGE_*` flags).

Bootstrap is intentionally fail-closed: configure branch protection to require
the PR preview and the environment configuration. A missing provider credential
produces a failed deployment receipt rather than a partial release. An arbitrary
local command cannot deploy: every mutating executor derives event/SHA from GitHub Actions, requires
`refs/heads/main`, obtains a GitHub-issued OIDC token bound to this repository
and SHA, validates main ancestry from those claims, and rejects a dirty checkout.

The `CI-owned deployment` workflow runs automatically for covered changes on
`main`. A manual dispatch is only an immutable retry of its GitHub Actions main
SHA. Both paths derive that SHA from `GITHUB_SHA`, check it out exactly, reject a
dirty checkout, and lock the exact `(provider, environment)` pair with
`cancel-in-progress: false`. A duplicate request queues rather than overlapping
the active deployment. Provider releases are independently locked; Cloudflare
code activation does not wait on the unrelated Railway or Modal lanes.

## Cloudflare package-discovery activation

On a trusted `main` push, the Cloudflare executor writes the ingress bearer and
base64 PKCS#8 Ed25519 signing key to the Worker with `wrangler secret put`, then
deploys the checked-out immutable revision. It refuses a success receipt unless
the deploy output, current deployment listing, and version listing agree on one
current Worker version ID. Secret values are never logged; the receipt names
only the two bound discovery secrets.

The same job extracts the direct HTTPS workers.dev URL from the just-deployed
version receipt (and rejects a URL whose worker-name prefix does not match
`wrangler.jsonc`), then calls it with `Authorization: Bearer
<AGENT_INGRESS_TOKEN>` at
the encounter-scoped discovery path. `CLOUDFLARE_DISCOVERY_ENCOUNTER_ID` is
optionally identifies a known accepted package. The matching public key is
pinned in the reviewed CI workflow and the probe verifies the canonical unsigned
manifest's Ed25519 signature before it
can accept a selection. The probe accepts only a
signed `selected` manifest or the explicit
`no_accepted_compatible_package` response. The latter is the expected honest
result until a separately produced and accepted package is present; this lane
does not create catalog records or artifacts. Its compact outcome is appended
to the Cloudflare provider receipt alongside the current Worker version ID.

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
that same saved plan. Successful Terraform receipts include that non-empty plan
digest; failed receipts contain no invented plan identifier. It never falls back
to local state or synthesizes backend credentials.

The additive `deployment_receipt_facts` Terraform output supplies Cloudflare
worker/version/deployment IDs, Railway project/environment/service IDs, module
SHA-256s, and configured non-secret variable names when those resources are
managed; disabled resources are null or empty. Modal has no documented
machine-readable deploy/health query seam in this controller, so it is skipped.
If enabled later, success must require parsed deployment ID, version ID, named
resources, and healthy status—never a command exit code alone.

The Railway receiver is a Docker-deployed Node HTTP service. It stores receipts
and its serial event outbox on the service's mounted `/data` volume, validates
the coordinator bearer token and stable `x-work-id`, and calls the deployed
Modal function by its named app/function identity. Its service configuration
must provide the two coordinator tokens plus `MODAL_INPUT_PACKAGE_BASE64` before
an end-to-end work order can be admitted; those values are never emitted in a
CI receipt or application response. The Railway provider receipt is successful
only after its deployment list reports `SUCCESS`; that alone is not a
coordinator-to-dispatcher acknowledgement or a Modal worker receipt.

## Receipts and build-room consumption

Every provider execution writes and uploads
`deployment-receipt-<provider>-<environment>-<sha>` containing:

- provider, environment, immutable source SHA, and only observed target version IDs;
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
