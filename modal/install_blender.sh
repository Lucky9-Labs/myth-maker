#!/bin/sh
# Install the exact Blender archive used by the managed worker image.
set -eu

archive=/tmp/blender.tar.xz
url=https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz
checksum=a31f524fa99a527d3d52b7f5aaa68c34e1a19d5a1c9473f79c5cc610fd5b10e9

curl --fail --location --retry 3 --retry-all-errors --silent --show-error "$url" --output "$archive"
if ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
    actual_sha=$(sha256sum "$archive" | awk '{print $1}')
    actual_bytes=$(wc -c < "$archive")
    printf 'Blender archive checksum mismatch: expected %s, actual %s, bytes %s\n' "$checksum" "$actual_sha" "$actual_bytes" >&2
    exit 1
fi

tar -C /opt -xf "$archive"
ln -s /opt/blender-5.2.1-linux-x64/blender /usr/local/bin/blender
rm "$archive"
