# Neutral Unity encounter-runner fixture

This disposable Unity 6000.6.0f1 fixture loads no host-game project, package, asset, or animation. It reads its immutable neutral `AssemblyReceipt` from `Assets/Resources/neutral-assembly-receipt.json` (a frozen package hash plus exact asset/animation revisions), instantiates a neutral player proxy and encounter target, runs a deterministic two-event damage exchange, and writes a `SimulationReceipt` to `../../artifacts/encounter-runner/unity-simulation-receipt.json`.

Run it with the installed editor:

```sh
/Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity -batchmode -nographics -quit -projectPath "$PWD/spikes/unity-encounter-runner-fixture" -executeMethod MythMaker.NeutralEncounterRunner.Editor.NeutralEncounterRunnerBatch.Run -logFile "$PWD/artifacts/encounter-runner/unity-batch.log"
```

The evidence tier is **local Unity runner**. `-nographics` creates no frame, clip, stream, or player-facing visual proof, so `player` remains `not_observed` and the receipt omits `frame_or_clip_artifact`. It proves only the neutral fixture's local Unity execution and scripted hit exchange.
