output "application_configuration_contract" {
  description = "Non-secret configuration handoff between Cloudflare ingress, Railway dispatcher, and Modal runtime."
  value = {
    format      = "myth-maker.infrastructure.application-config/v1"
    environment = var.environment
    cloudflare = {
      worker_name = local.cloudflare_worker_name
      durable_object = {
        binding_name    = "ENCOUNTER_COORDINATOR"
        class_name      = "EncounterCoordinator"
        migration_tag   = "v1"
        migration_owner = "wrangler baseline; Terraform only sends a tag when cloudflare_do_migration_tag is set"
      }
      required_secret_names = local.cloudflare_secret_names
      dispatcher_url        = var.work_dispatch_url
      worker_modules = [
        {
          name   = "worker.js"
          source = "src/worker.js"
          sha256 = filesha256("${path.module}/../../src/worker.js")
        },
        {
          name   = "encounter-package-assembler.js"
          source = "src/encounter-package-assembler.js"
          sha256 = filesha256("${path.module}/../../src/encounter-package-assembler.js")
        },
        {
          name   = "package-discovery.js"
          source = "src/package-discovery.js"
          sha256 = filesha256("${path.module}/../../src/package-discovery.js")
        },
      ]
    }
    railway = {
      project_name          = local.railway_project_name
      environment_name      = var.environment
      dispatcher_service    = local.railway_service_name
      required_secret_names = local.railway_secret_names
      receiver = {
        authorization_header = "Authorization: Bearer"
        token_secret_name    = "WORK_DISPATCH_TOKEN"
      }
      # These values tell a dispatcher what it may submit; they are not an
      # assertion that the service has a source image or a reachable domain.
      work_order = {
        schema_version    = "1"
        modal_environment = local.railway_plain_configuration.MODAL_ENVIRONMENT
        modal_app_name    = local.railway_plain_configuration.MODAL_APP_NAME
        adapter_class     = local.railway_plain_configuration.MODAL_ADAPTER_CLASS
        adapter_runner    = local.railway_plain_configuration.MODAL_ADAPTER_RUNNER
        modal_function    = local.railway_plain_configuration.MODAL_FUNCTION_NAME
        work_id_header    = local.railway_plain_configuration.COORDINATOR_WORK_ID_HEADER
        deduplication     = "The dispatcher must deduplicate each stable work_id before side effects."
      }
    }
    ci_deployment_controller = {
      deployment_owner = "ci-only"
      release_revision = var.release_revision
      required_secret_inputs = {
        cloudflare = ["CLOUDFLARE_API_TOKEN", "TF_VAR_agent_ingress_token", "TF_VAR_work_dispatch_token", "TF_VAR_catalog_acceptance_token", "TF_VAR_package_discovery_signing_private_key"]
        railway    = ["TF_VAR_railway_token", "WORK_DISPATCH_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
        modal      = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY"]
      }
      commands = {
        cloudflare = ["terraform -chdir=infra/terraform init -reconfigure -backend-config=<approved-backend>", "terraform -chdir=infra/terraform validate", "terraform -chdir=infra/terraform plan -input=false -out=<reviewed-plan>", "terraform -chdir=infra/terraform apply -input=false <reviewed-plan>"]
        railway    = ["terraform -chdir=infra/terraform validate", "terraform -chdir=infra/terraform plan -input=false -out=<reviewed-plan>", "terraform -chdir=infra/terraform apply -input=false <reviewed-plan>"]
        modal      = ["python3 modal/infrastructure.py --environment <environment> --check-files", "modal deploy --env <environment> modal/draft_trial.py"]
      }
      required_receipts = [
        "release_revision and reviewed plan digest",
        "Cloudflare Worker version and deployment IDs with binding/module digest snapshot",
        "Railway project/environment/service IDs and configured variable names",
        "Modal app deployment ID/version and named resource verification",
        "post-deploy coordinator-to-dispatcher x-work-id acknowledgement",
      ]
    }
    modal = {
      environment          = var.environment
      app_name             = "myth-maker-encounter-draft"
      function_name        = "run_draft"
      volume_name          = "myth-maker-encounter-submissions"
      lease_dict_name      = "myth-maker-encounter-component-leases"
      openai_secret_name   = "myth-maker-encounter-openai"
      required_secret_keys = ["OPENAI_API_KEY"]
    }
  }
}

output "resource_names" {
  description = "Provider resource names only; no resource IDs or endpoints are assumed."
  value = {
    cloudflare_worker = local.cloudflare_worker_name
    railway_project   = local.railway_project_name
    railway_service   = local.railway_service_name
  }
}

# CI consumes this output as receipt facts after a reviewed apply. It is
# intentionally additive: disabled resources produce null IDs, and no secret
# value, endpoint, backend setting, or token is ever exposed.
output "deployment_receipt_facts" {
  description = "Non-secret provider identifiers and configured variable names for CI deployment receipts."
  value = {
    cloudflare = {
      worker_id         = try(cloudflare_worker.coordinator[0].id, null)
      worker_version_id = try(cloudflare_worker_version.coordinator[0].id, null)
      deployment_id     = try(cloudflare_workers_deployment.coordinator[0].id, null)
      worker_modules = [
        {
          name   = "worker.js"
          sha256 = filesha256("${path.module}/../../src/worker.js")
        },
        {
          name   = "encounter-package-assembler.js"
          sha256 = filesha256("${path.module}/../../src/encounter-package-assembler.js")
        },
        {
          name   = "package-discovery.js"
          sha256 = filesha256("${path.module}/../../src/package-discovery.js")
        },
      ]
    }
    railway = {
      project_id                = try(railway_project.control_plane[0].id, null)
      environment_id            = try(railway_environment.control_plane[0].id, null)
      service_id                = try(railway_service.dispatcher[0].id, null)
      configured_variable_names = sort(keys(railway_variable.dispatcher_configuration))
    }
  }
}
