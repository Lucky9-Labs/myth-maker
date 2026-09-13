#!/bin/zsh
set -euo pipefail

spike_root=${0:A:h}
repo_root=${spike_root:h:h}
source_glb=${REEF_SKITTER_GLB_PATH:-}
output_root="$repo_root/output/reef-skitter/unity-swarm"
trace_path=${1:-"$output_root/reef-skitter-metal.trace"}
toc_path=${trace_path:r}-toc.xml
intervals_path=${trace_path:r}-gpu-intervals.xml
receipt_path=${trace_path:r}-gpu-receipt.json
player_log=${trace_path:r}-player.log
player_output=${trace_path:r}-run
player_binary="$spike_root/Build/ReefSkitterSwarmBenchmark.app/Contents/MacOS/unity-dynamic-load"

test -x "$player_binary"
if [[ -z "$source_glb" || ! -f "$source_glb" ]]; then
  print -u2 "REEF_SKITTER_GLB_PATH must name the integrated five-clip GLB"
  exit 2
fi
if [[ -e "$trace_path" || -e "$toc_path" || -e "$intervals_path" || -e "$receipt_path" || -e "$player_log" || -e "$player_output" ]]; then
  print -u2 "Refusing to overwrite an existing trace or export: $trace_path"
  exit 2
fi
mkdir -p "$output_root" "$player_output"

set +e
xcrun xctrace record \
  --template 'Metal System Trace' \
  --time-limit 8s \
  --no-prompt \
  --output "$trace_path" \
  --env "REEF_SKITTER_GLB_PATH=$source_glb" \
  --env "REEF_SKITTER_BENCHMARK_OUTPUT=$player_output" \
  --env REEF_SKITTER_BENCHMARK_AUTORUN=0 \
  --launch -- "$player_binary" \
  -screen-width 1600 -screen-height 900 -logFile "$player_log"
record_status=$?
set -e
if [[ ! -d "$trace_path" ]]; then
  print -u2 "Metal trace recording failed with status $record_status and produced no trace"
  exit "$record_status"
fi

xcrun xctrace export --input "$trace_path" --toc --output "$toc_path"
player_pid=$(sed -n 's/.*<process name="unity-dynamic-load" pid="\([0-9][0-9]*\)".*/\1/p' "$toc_path" | head -1)
if [[ -z "$player_pid" ]]; then
  print -u2 "Trace did not identify the launched unity-dynamic-load process"
  exit 1
fi
xcrun xctrace export \
  --input "$trace_path" \
  --xpath '/trace-toc/run[@number="1"]/data/table[@schema="metal-gpu-intervals"]' \
  --output "$intervals_path"
node "$repo_root/scripts/summarize-metal-trace.mjs" \
  "$intervals_path" unity-dynamic-load "$player_pid" 1 "$receipt_path" \
  "$player_output/reef-skitter-swarm-benchmark.json" \
  "$player_output/reef-skitter-swarm.png"
