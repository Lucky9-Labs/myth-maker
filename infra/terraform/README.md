# Myth Maker infrastructure foundation

This directory is a small, environment-oriented Terraform layout. Its default
configuration is deliberately review-only: it has no provider credentials, does
not create resources, and does not claim a dispatcher image, Railway domain, or
Cloudflare route exists.

The foundation has three bounded ownership areas:

- **Cloudflare:** the ingress Worker identity, `EncounterCoordinator` Durable
  Object binding, its preserved `v1` SQLite migration, plain configuration, and
  the names of two Worker secrets.
- **Railway:** an opt-in project, an isolated environment, and an intentionally
  empty dispatcher service. A separate opt-in maps the non-secret v1/Modal
  variables onto that service once a real source is attached. The source/image
  and public domain remain outside this foundation until they are real and
  supplied explicitly.
- **Modal:** no Terraform provider is declared. Modal applications and resource
  handles are defined by Python code and deployed with `modal deploy`; the
  offline contract generator in `../../modal/infrastructure.py` is the
  declarative handoff for its app, environment, Volume, Dict, function, and
  secret names.

`application_configuration_contract` is the non-secret output contract. It
connects the Cloudflare binding `COMPUTER_USE_DISPATCH_URL` to an explicit
Railway dispatcher URL, and tells that dispatcher to submit v1 work orders to
`BlenderDraftWorkerAdapter`. That adapter uses `ModalDraftRunner` to invoke
Modal's legacy `run_draft` function in the named environment. It never contains
secret values. A source artifact returned by Modal remains a source receipt; it
is not an `EncounterModule` or playable candidate.

## Offline checks

```sh
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
python3 modal/infrastructure.py --environment dev --check-files
npm test
```

`init` downloads pinned provider binaries but does not authenticate or create
cloud resources. `validate` and the disabled `plan` are safe with the default
example variables. Railway validates provider credentials even with zero
resources, so this layout supplies an inert placeholder only while
`manage_railway=false`; its lifecycle guard rejects an enabled Railway change
without a real token. An apply is a separate, credentialed change and requires
explicit opt-in flags.

## Credentialed bootstrap, not part of this change

1. Copy `dev.tfvars.example` to an ignored `dev.tfvars` and set account IDs,
   explicit dispatcher URL, and secrets through a secure mechanism (for example
   `TF_VAR_*` environment variables). Do not place values in version control.
2. In `dev`, the default Worker name is the existing
   `myth-maker-encounter-runtime`, so its binding-only Terraform version is
   compatible with the `v1` Wrangler migration already on that Worker. Later
   environments receive a suffix by default (or an explicit
   `cloudflare_worker_name`) and must use the two-step bootstrap below. Set
   `manage_cloudflare=true` to create only the Worker identity, then use
   Wrangler to deploy the existing `wrangler.jsonc` Durable Object migration and
   source. The default Terraform version configuration preserves that Wrangler
   `v1` baseline and manages the binding without resending a migration. For a
   new, Terraform-first Worker, Cloudflare requires two reviewed versions: set
   `cloudflare_do_migration_tag` for the first migration-only version (the
   binding is intentionally absent), then set it back to `null` and apply the
   binding version. Do not collapse those steps.
3. Set `manage_railway=true` only after the target Railway workspace is chosen.
   The provider creates an empty service; attach a real source/image first, then
   set `manage_railway_dispatcher_configuration=true` to create the non-secret
   schema/adapter variables. Add secret values, health checks, and any optional
   domain through a separately reviewed deployment.
4. Create the named Modal environment and resources with Modal's CLI/dashboard,
   then deploy its Python app with `modal deploy --env <environment>
   modal/draft_trial.py`. The offline generator verifies names only; it never
   calls Modal.

The Railway provider is community-maintained, not an official Railway provider.
Version `0.6.2` is pinned because its current service resource has an unresolved
upstream issue that can clobber unmanaged service-instance settings on update.
Do not import or update an established dispatcher with this foundation until
that behavior is fixed and an isolated plan/apply has been reviewed.

## Remote state

No backend is provisioned or guessed here. Before any shared apply, select a
team-approved remote backend with encryption, state locking, restricted access,
and audited credential rotation. Configure it through the chosen backend's
documented `terraform init -reconfigure -backend-config=...` inputs, keep those
backend values out of Git, and use one state per environment. Do not use local
state for a shared apply or commit a state file.
