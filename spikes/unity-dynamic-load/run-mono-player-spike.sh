#!/bin/zsh
set -euo pipefail

spike_root=${0:A:h}
unity_binary=/Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity
build_log="$spike_root/Build/build.log"
player_log="$spike_root/Build/player.log"
player_binary="$spike_root/Build/DynamicAssemblySpike.app/Contents/MacOS/unity-dynamic-load"

mkdir -p "$spike_root/Build"
"$unity_binary" -batchmode -nographics -quit -projectPath "$spike_root" -executeMethod MythMaker.DynamicAssemblySpike.Editor.DynamicAssemblySpikeBuild.BuildStandaloneMono -logFile "$build_log"
"$player_binary" -batchmode -nographics -logFile "$player_log"
rg -q 'DynamicAssemblySpike] status=Loaded;.*entrypoint=fixture.DynamicProbe.Describe; message=External assembly executed: DynamicProbe.Describe' "$player_log"
