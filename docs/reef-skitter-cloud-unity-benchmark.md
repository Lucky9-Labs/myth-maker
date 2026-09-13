# Reef Skitter cloud Unity benchmark

The `Reef Skitter cloud Unity Metal benchmark` workflow is the only supported
path for the 400-creature acceptance run. It never executes Unity, a player, or
Metal capture on the developer workstation.

The dispatch is bound to an exact successful `Reef Skitter cloud GUI
integration` run, attempt, commit SHA, GitHub artifact digest, and integrated
GLB SHA-256. The downloaded artifact must still pass its provider receipt and
the exact five-clip, 15-part shared-skin contract before Unity is installed.
The benchmark harness itself is checked out from the dispatch's immutable main
SHA, so an older accepted animation artifact cannot silently replace current
runtime or verification code.

## Cloud prerequisites

- Enable GitHub's `macos-15-xlarge` runner for the repository. GitHub documents
  this arm64 runner as GPU-hardware-accelerated; a standard macOS runner is not
  an acceptable substitute for Metal proof. The runner must permit non-prompted
  `xctrace` Metal System Trace recording for the launched standalone player.
- Configure protected `dev` environment secrets `UNITY_EMAIL`,
  `UNITY_PASSWORD`, and `UNITY_SERIAL` for a paid Unity license that permits
  non-interactive CI activation. The workflow refuses to start editor work
  when any secret is absent and returns the license in an `always()` step.
- The exact editor is Unity `6000.6.0f1`, changeset `f7f8ed4d1e24`. The workflow
  installs that build with Unity Hub and checks its application version.

The repository currently has no registered self-hosted runner and no visible
Unity license secrets. The workflow is therefore implemented but intentionally
not dispatched until those prerequisites are provisioned.

## Acceptance evidence

The workflow uploads four independently inspectable artifacts:

1. Integration-run metadata, artifact metadata, provider receipt, and animated
   GLB inspection.
2. Standalone Unity build/player logs, benchmark JSON, and screenshot.
3. Raw Metal trace, exported trace tables, traced-player receipt/screenshot,
   player log, and process-scoped GPU summary.
4. A compact PASS receipt containing hashes of all accepted evidence.

The final verifier fails when the source hash or animation contract differs,
fewer than 400 creatures remain visible anywhere in the sample window, or any
required frame-time, CPU, GPU, memory, draw-call, batch, GC, or instancing
metric is unavailable. A green workflow is therefore swarm/runtime proof, not
merely a successful Unity build.
