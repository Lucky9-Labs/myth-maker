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
      dispatcher_url        = var.railway_dispatch_url
    }
    railway = {
      project_name          = local.railway_project_name
      environment_name      = var.environment
      dispatcher_service    = local.railway_service_name
      required_secret_names = local.railway_secret_names
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
