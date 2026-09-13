#!/bin/zsh
set -euo pipefail

spike_root=${0:A:h}
repo_root=${spike_root:h:h}
unity_binary=/Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity
output_root=${1:-"$repo_root/output/reef-skitter/unity-swarm"}
source_glb=${REEF_SKITTER_GLB_PATH:-${2:-}}
build_log="$output_root/build.log"
player_log="$output_root/player.log"
player_binary="$spike_root/Build/ReefSkitterSwarmBenchmark.app/Contents/MacOS/unity-dynamic-load"

if [[ -z "$source_glb" || ! -f "$source_glb" ]]; then
  print -u2 "Provide the integrated five-clip GLB as REEF_SKITTER_GLB_PATH or argument 2"
  exit 2
fi

if [[ -e "$build_log" || -e "$player_log" || -e "$output_root/reef-skitter-swarm-benchmark.json" || -e "$output_root/reef-skitter-swarm.png" ]]; then
  print -u2 "Refusing to overwrite existing benchmark evidence in $output_root"
  exit 2
fi
mkdir -p "$output_root"
"$unity_binary" -batchmode -nographics -quit -projectPath "$spike_root" -executeMethod MythMaker.DynamicAssemblySpike.Editor.ReefSkitterSwarmBuild.BuildStandalone -logFile "$build_log"
REEF_SKITTER_GLB_PATH="$source_glb" REEF_SKITTER_BENCHMARK_OUTPUT="$output_root" REEF_SKITTER_BENCHMARK_AUTORUN=1 "$player_binary" -screen-width 1600 -screen-height 900 -logFile "$player_log"
rg -q '\[ReefSkitterBenchmark\] complete receipt=.*visible=.*frame_avg_ms=' "$player_log"
test -s "$output_root/reef-skitter-swarm-benchmark.json"
test -s "$output_root/reef-skitter-swarm.png"
