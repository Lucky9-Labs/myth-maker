#!/usr/bin/env python3
"""Validate and explicitly publish the S3-backed art-library inventory."""

import argparse
import hashlib
import json
import os
import re
from pathlib import Path


ART_LIBRARY = Path(__file__).parents[1]
REPOSITORY_ROOT = ART_LIBRARY.parent
INVENTORY_PATH = ART_LIBRARY / "inventory.json"
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
CONTENT_TYPE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$")
VALID_STATES = {"staged", "uploaded", "superseded"}
VALID_REVIEW_STATUSES = {"exploring", "selected", "rejected"}
VALID_CATEGORIES = {"environment", "pilot", "equipment", "mech", "weapon", "enemy", "reference"}


def load_inventory(path=INVENTORY_PATH):
    return json.loads(Path(path).read_text())



def validate_inventory(inventory):
    errors = []
    if inventory.get("schema_version") != "art-inventory/v1":
        errors.append("schema_version must be art-inventory/v1")
    if inventory.get("bucket_environment") != "MECH_GAME_ART_BUCKET":
        errors.append("bucket_environment must be MECH_GAME_ART_BUCKET")

    asset_ids = set()
    object_keys = set()
    for index, asset in enumerate(inventory.get("assets", [])):
        prefix = f"assets[{index}]"
        for field in ("id", "category", "title", "revisions"):
            if field not in asset:
                errors.append(f"{prefix} missing {field}")
        asset_id = asset.get("id", "")
        if not ID_PATTERN.fullmatch(asset_id):
            errors.append(f"{prefix} has invalid id")
        elif asset_id in asset_ids:
            errors.append(f"duplicate asset id: {asset_id}")
        asset_ids.add(asset_id)
        if asset.get("category") not in VALID_CATEGORIES:
            errors.append(f"{prefix} has invalid category")
        revisions = asset.get("revisions")
        if not isinstance(revisions, list) or not revisions:
            errors.append(f"{prefix} must have at least one revision")
            continue

        versions = set()
        previous_version = 0
        for revision_index, revision in enumerate(revisions):
            revision_prefix = f"{prefix}.revisions[{revision_index}]"
            for field in ("version", "state", "review_status", "object_key", "sha256", "staged_path", "content_type", "brief", "s3_version_id"):
                if field not in revision:
                    errors.append(f"{revision_prefix} missing {field}")
            version = revision.get("version")
            if not isinstance(version, int) or version < 1:
                errors.append(f"{revision_prefix} version must be a positive integer")
            elif version in versions:
                errors.append(f"duplicate version for asset {asset_id}: {version}")
            elif version <= previous_version:
                errors.append(f"versions must increase for asset {asset_id}")
            versions.add(version)
            previous_version = version if isinstance(version, int) else previous_version
            state = revision.get("state")
            if state not in VALID_STATES:
                errors.append(f"{revision_prefix} has invalid state")
            if revision.get("review_status") not in VALID_REVIEW_STATUSES:
                errors.append(f"{revision_prefix} has invalid review_status")
            object_key = revision.get("object_key", "")
            if not object_key or object_key.startswith("/") or ".." in Path(object_key).parts:
                errors.append(f"{revision_prefix} has invalid object_key")
            elif object_key in object_keys:
                errors.append(f"duplicate object_key: {object_key}")
            object_keys.add(object_key)
            if isinstance(version, int) and f"v{version}" not in Path(object_key).parts:
                errors.append(f"{revision_prefix} object_key must include v{version}")
            staged_path = revision.get("staged_path", "")
            if not staged_path.startswith("references/concepts/") or ".." in Path(staged_path).parts:
                errors.append(f"{revision_prefix} has invalid staged_path")
            if not SHA256_PATTERN.fullmatch(revision.get("sha256", "")):
                errors.append(f"{revision_prefix} has invalid sha256")
            if not CONTENT_TYPE_PATTERN.fullmatch(revision.get("content_type", "")):
                errors.append(f"{revision_prefix} has invalid content_type")
            s3_version_id = revision.get("s3_version_id")
            if state == "staged" and s3_version_id is not None:
                errors.append(f"{revision_prefix} staged revision must have null s3_version_id")
            if state in {"uploaded", "superseded"} and (not isinstance(s3_version_id, str) or not s3_version_id):
                errors.append(f"{revision_prefix} {state} revision requires s3_version_id")
    return errors


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def asset_revision_by_id(inventory, asset_id, version):
    for asset in inventory["assets"]:
        if asset["id"] == asset_id:
            for revision in asset["revisions"]:
                if revision["version"] == version:
                    return asset, revision
            raise ValueError(f"unknown revision {version} for asset id: {asset_id}")
    raise ValueError(f"unknown asset id: {asset_id}")


def publish_command(asset, revision, bucket, staged_path=None):
    body_path = staged_path or revision["staged_path"]
    return [
        "aws", "s3api", "put-object", "--bucket", bucket, "--key", revision["object_key"],
        "--body", str(body_path), "--content-type", revision["content_type"],
        "--if-none-match", "*", "--metadata",
        f"asset-id={asset['id']},sha256={revision['sha256']},inventory-version={revision['version']}",
        "--output", "json",
    ]


def s3_client():
    try:
        import boto3
    except ImportError as error:
        raise SystemExit("boto3 is required for --execute publishing") from error
    return boto3.client("s3")


def verify_bucket_prerequisites(bucket, client):
    versioning = client.get_bucket_versioning(Bucket=bucket)
    if versioning.get("Status") != "Enabled":
        raise SystemExit("art-library bucket must have S3 versioning enabled")
    client.get_bucket_encryption(Bucket=bucket)
    access = client.get_public_access_block(Bucket=bucket)
    configuration = access.get("PublicAccessBlockConfiguration", {})
    required_blocks = ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")
    if not all(configuration.get(block) is True for block in required_blocks):
        raise SystemExit("art-library bucket must enable all public-access blocks")


def write_inventory(inventory):
    INVENTORY_PATH.write_text(json.dumps(inventory, indent=2) + "\n")


def upload_revision(client, asset, revision, bucket, staged_path):
    with staged_path.open("rb") as source:
        return client.put_object(
            Bucket=bucket,
            Key=revision["object_key"],
            Body=source,
            ContentType=revision["content_type"],
            Metadata={
                "asset-id": asset["id"],
                "sha256": revision["sha256"],
                "inventory-version": str(revision["version"]),
            },
            IfNoneMatch="*",
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "publish"))
    parser.add_argument("--asset-id", help="required for publish")
    parser.add_argument("--revision", type=int, help="required for publish")
    parser.add_argument("--execute", action="store_true", help="perform the AWS upload; otherwise print the command")
    args = parser.parse_args()
    inventory = load_inventory()
    errors = validate_inventory(inventory)
    if errors:
        raise SystemExit("invalid art inventory:\n- " + "\n- ".join(errors))
    if args.command == "validate":
        print(f"valid art inventory: {len(inventory['assets'])} assets")
        return
    if not args.asset_id or args.revision is None:
        raise SystemExit("--asset-id and --revision are required for publish")
    asset, revision = asset_revision_by_id(inventory, args.asset_id, args.revision)
    if revision["state"] != "staged":
        raise SystemExit("only staged revisions may be published; create a new revision instead")
    staged_path = REPOSITORY_ROOT / revision["staged_path"]
    if not staged_path.is_file():
        raise SystemExit(f"staged file is missing: {staged_path}")
    actual_hash = sha256(staged_path)
    if actual_hash != revision["sha256"]:
        raise SystemExit(f"sha256 mismatch for {staged_path}: inventory={revision['sha256']} actual={actual_hash}")
    bucket = os.environ.get(inventory["bucket_environment"])
    if not bucket:
        raise SystemExit(f"set {inventory['bucket_environment']} before publishing")
    command = publish_command(asset, revision, bucket, staged_path)
    if not args.execute:
        print("dry run:")
        print(" ".join(command))
        return
    client = s3_client()
    verify_bucket_prerequisites(bucket, client)
    upload = upload_revision(client, asset, revision, bucket, staged_path)
    s3_version_id = upload.get("VersionId")
    if not isinstance(s3_version_id, str) or not s3_version_id:
        raise SystemExit("S3 upload did not return a VersionId; inventory was not updated")
    revision["state"] = "uploaded"
    revision["s3_version_id"] = s3_version_id
    write_inventory(inventory)
    print(f"uploaded s3://{bucket}/{revision['object_key']} (VersionId: {s3_version_id})")


if __name__ == "__main__":
    main()
