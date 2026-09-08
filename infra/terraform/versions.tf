terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24.0"
    }
    railway = {
      source  = "terraform-community-providers/railway"
      version = "= 0.6.2"
    }
  }
}
