#!/usr/bin/env python3
"""Restore the pinned authoring release; requires boto3 and art-bucket read access."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile
import boto3

ROOT = Path(__file__).resolve().parents[2]
def digest(data):
    return hashlib.sha256(data).hexdigest()
def restore(destination):
    manifest = json.loads((ROOT / 'art-library/releases/strokah-shared-pistol-v1.json').read_text())
    artifact = manifest['artifact']
    response = boto3.client('s3').get_object(Bucket=manifest['bucket'], Key=artifact['object_key'], VersionId=artifact['s3_version_id'])
    payload = response['Body'].read()
    if digest(payload) != artifact['sha256']:
        raise ValueError('Release archive hash mismatch')
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        if set(archive.namelist()) != set(manifest['files']):
            raise ValueError('Unexpected archive members')
        verified = {}
        for name, expected in manifest['files'].items():
            target = (destination / name).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive path')
            data = archive.read(name)
            if digest(data) != expected:
                raise ValueError(f'File hash mismatch: {name}')
            if target.exists() and digest(target.read_bytes()) != expected:
                raise ValueError(f'Refusing to overwrite modified file: {target}')
            verified[target] = data
        for target, data in verified.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    print(json.dumps({'release': manifest['release'], 'sha256': artifact['sha256'], 'verified_files': len(verified)}))
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=ROOT / 'output/pistol')
    restore(parser.parse_args().destination)
