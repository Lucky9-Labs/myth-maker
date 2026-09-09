variable "environment" {
  description = "Short environment identifier used in resource names."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,31}$", var.environment))
    error_message = "environment must be lowercase kebab-case, at most 32 characters."
  }
}

variable "project_slug" {
  description = "Stable, generic prefix for provider resource names."
  type        = string
  default     = "myth-maker"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,31}$", var.project_slug))
    error_message = "project_slug must be lowercase kebab-case, at most 32 characters."
  }
}

variable "manage_cloudflare" {
  description = "Opt in to Cloudflare resource creation or updates. Defaults to false for offline review."
  type        = bool
  default     = false
}

variable "manage_cloudflare_worker_versions" {
  description = "Opt in to Worker version/deployment management after the Durable Object bootstrap procedure is complete."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID. Required only when manage_cloudflare is true."
  type        = string
  default     = null
  nullable    = true
}

variable "cloudflare_worker_name" {
  description = "Optional Cloudflare Worker name override. Null preserves the existing unsuffixed Worker in dev and suffixes later environments."
  type        = string
  default     = null
  nullable    = true
}

variable "cloudflare_compatibility_date" {
  description = "Worker compatibility date, kept aligned with wrangler.jsonc."
  type        = string
  default     = "2026-09-08"
}

variable "cloudflare_do_migration_tag" {
  description = "One-time Durable Object migration tag. Null preserves the existing Wrangler-managed v1 migration and sends only the binding."
  type        = string
  default     = null
  nullable    = true
}

variable "enable_workers_dev_subdomain" {
  description = "Whether Cloudflare should enable the workers.dev subdomain for this Worker. No custom domain is managed here."
  type        = bool
  default     = false
}

variable "work_dispatch_url" {
  description = "Explicit external dispatcher URL for the Worker. Null means no endpoint/domain is asserted or configured."
  type        = string
  default     = null
  nullable    = true
}

variable "agent_ingress_token" {
  description = "Value for the AGENT_INGRESS_TOKEN Worker secret. Never commit this value."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "work_dispatch_token" {
  description = "Value for the WORK_DISPATCH_TOKEN Worker/Railway receiver secret. Never commit this value."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "package_discovery_signing_private_key" {
  description = "Base64 PKCS#8 Ed25519 private key for PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY. Never commit this value."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "catalog_acceptance_token" {
  description = "Value for the CATALOG_ACCEPTANCE_TOKEN Worker secret used only by the catalog acceptance authority. Never commit this value."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "release_revision" {
  description = "Immutable source revision recorded by the CI deployment controller in deployment receipts. Null is allowed for local validation only."
  type        = string
  default     = null
  nullable    = true
}

variable "manage_railway" {
  description = "Opt in to creating the Railway project, environment, and empty dispatcher service."
  type        = bool
  default     = false
}

variable "manage_railway_dispatcher_configuration" {
  description = "Opt in to non-secret Railway service variables after a real dispatcher source has been attached."
  type        = bool
  default     = false
}

variable "railway_workspace_id" {
  description = "Optional Railway workspace ID; required by Railway when the API token sees multiple workspaces."
  type        = string
  default     = null
  nullable    = true
}

variable "railway_token" {
  description = "Railway API token for an enabled Railway change. Null uses an inert placeholder solely so offline Terraform plans can validate provider wiring."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}
