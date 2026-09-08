locals {
  offline_railway_token = "offline-validation-only"
  resource_prefix       = "${var.project_slug}-${var.environment}"
  cloudflare_worker_name = coalesce(
    var.cloudflare_worker_name,
    var.environment == "dev" ? "myth-maker-encounter-runtime" : "${local.resource_prefix}-encounter-runtime",
  )
  railway_project_name = var.project_slug
  railway_service_name = "${local.resource_prefix}-dispatcher"

  cloudflare_secret_names = [
    "AGENT_INGRESS_TOKEN",
    "COMPUTER_USE_DISPATCH_TOKEN",
  ]

  railway_secret_names = [
    "COMPUTER_USE_DISPATCH_TOKEN",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
  ]

  railway_plain_configuration = {
    COORDINATOR_WORK_ORDER_SCHEMA_VERSION = "1"
    MODAL_ENVIRONMENT                     = var.environment
    MODAL_APP_NAME                        = "myth-maker-encounter-draft"
    MODAL_ADAPTER_CLASS                   = "BlenderDraftWorkerAdapter"
    MODAL_ADAPTER_RUNNER                  = "ModalDraftRunner"
    MODAL_FUNCTION_NAME                   = "run_draft"
  }

  cloudflare_durable_object_binding = var.cloudflare_do_migration_tag == null ? [{
    type       = "durable_object_namespace"
    name       = "ENCOUNTER_COORDINATOR"
    class_name = "EncounterCoordinator"
  }] : []

  cloudflare_bindings = concat(local.cloudflare_durable_object_binding, [
    {
      type = "plain_text"
      name = "DEPLOYMENT_ENVIRONMENT"
      text = var.environment
    },
    ], var.railway_dispatch_url == null ? [] : [{
      type = "plain_text"
      name = "COMPUTER_USE_DISPATCH_URL"
      text = var.railway_dispatch_url
      }], var.agent_ingress_token == null ? [] : [{
      type = "secret_text"
      name = "AGENT_INGRESS_TOKEN"
      text = var.agent_ingress_token
      }], var.computer_use_dispatch_token == null ? [] : [{
      type = "secret_text"
      name = "COMPUTER_USE_DISPATCH_TOKEN"
      text = var.computer_use_dispatch_token
  }])
}

# Railway validates a token even when all resources have count = 0. The inert
# fallback lets an offline plan prove the disabled topology without credentials;
# the project precondition below prevents it from ever managing resources.
provider "railway" {
  token = coalesce(var.railway_token, local.offline_railway_token)
}

# The Worker resource is the Cloudflare ingress/coordinator identity. Its code
# remains src/worker.js; no hostname or route is invented by this foundation.
resource "cloudflare_worker" "coordinator" {
  count      = var.manage_cloudflare ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.cloudflare_worker_name
  tags       = ["myth-maker", "${var.environment}", "encounter-coordinator"]

  observability = {
    enabled = true
  }

  subdomain = {
    enabled          = var.enable_workers_dev_subdomain
    previews_enabled = false
  }

  lifecycle {
    precondition {
      condition     = var.cloudflare_account_id != null
      error_message = "cloudflare_account_id is required when manage_cloudflare is true."
    }
  }
}

# Worker versions are immutable. By default this retains the existing v1
# Wrangler migration and sends the Durable Object binding only. A one-time
# migration tag deliberately suppresses that binding, matching Cloudflare's
# required two-step bootstrap sequence; see README.md.
resource "cloudflare_worker_version" "coordinator" {
  count              = var.manage_cloudflare && var.manage_cloudflare_worker_versions ? 1 : 0
  account_id         = var.cloudflare_account_id
  worker_id          = cloudflare_worker.coordinator[0].id
  compatibility_date = var.cloudflare_compatibility_date
  main_module        = "worker.js"
  modules = [{
    name         = "worker.js"
    content_type = "application/javascript+module"
    content_file = "${path.module}/../../src/worker.js"
  }]
  bindings = local.cloudflare_bindings
  migrations = var.cloudflare_do_migration_tag == null ? null : {
    new_tag            = var.cloudflare_do_migration_tag
    new_sqlite_classes = ["EncounterCoordinator"]
  }

  lifecycle {
    precondition {
      condition = (
        var.railway_dispatch_url != null &&
        var.agent_ingress_token != null &&
        var.computer_use_dispatch_token != null
      )
      error_message = "An enabled Worker deployment requires the explicit Railway dispatcher URL and both secret values."
    }
  }
}

resource "cloudflare_workers_deployment" "coordinator" {
  count       = var.manage_cloudflare && var.manage_cloudflare_worker_versions ? 1 : 0
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.coordinator[0].name
  strategy    = "percentage"
  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.coordinator[0].id
  }]
}

# Railway's provider represents the project, its isolated environment, and an
# empty service seam. Deliberately omit source_image, source_repo, and domains:
# no application image or public URL exists until a separate deployment decides
# to supply one.
resource "railway_project" "control_plane" {
  count        = var.manage_railway ? 1 : 0
  name         = local.railway_project_name
  description  = "Myth Maker external encounter dispatcher control plane"
  private      = true
  workspace_id = var.railway_workspace_id

  lifecycle {
    precondition {
      condition     = var.railway_token != null && var.railway_token != local.offline_railway_token
      error_message = "A real railway_token is required when manage_railway is true."
    }
  }
}

resource "railway_environment" "control_plane" {
  count      = var.manage_railway ? 1 : 0
  name       = var.environment
  project_id = railway_project.control_plane[0].id
}

resource "railway_service" "dispatcher" {
  count      = var.manage_railway ? 1 : 0
  name       = local.railway_service_name
  project_id = railway_project.control_plane[0].id
}

# These non-secret variables make the dispatcher/control-plane handoff
# explicit. They are separately opt-in because the Railway provider redeploys a
# service when its variable collection changes; do not enable until a real
# dispatcher source is attached and reviewed.
resource "railway_variable" "dispatcher_configuration" {
  for_each = var.manage_railway && var.manage_railway_dispatcher_configuration ? local.railway_plain_configuration : {}

  name           = each.key
  value          = each.value
  environment_id = railway_environment.control_plane[0].id
  service_id     = railway_service.dispatcher[0].id
}
