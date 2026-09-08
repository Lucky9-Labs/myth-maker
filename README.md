# Myth Maker encounter generator

Myth Maker is an encounter-generation service for an existing Unity FPS. It
creates the next boss encounter while the player is in the preceding one (or
ahead of play when capacity permits): novel boss components, enemy variants,
loot, encounter spaces, and the data or assets that describe them.

This repository is **only** the encounter generator. It does not own the FPS's
combat, movement, weapons, save system, matchmaking, Unity project, or release
pipeline. Generated output is an untrusted candidate until the host game
validates its contract and explicitly accepts it.

## Starting architecture

```text
Encounter coordinator
  -> Cloudflare Worker + component ownership lease
  -> external encounter agents / computer-use dispatcher
  -> external computer-use workers
  -> future GPU asset-generation runtime
  -> review / Unity import / continuation
```

The lightweight Cloudflare runtime lives in [`src/worker.js`](src/worker.js).
It keeps request authorization, idempotency, and one active job per
project/component in a Durable Object, then forwards opaque computer-use work to
an external dispatcher. It does not run a model or Blender itself; agents outside
Cloudflare remain responsible for deciding what to ask the computer-use workers
to do. The GPU/Blender worker integration remains deliberately unshipped until
its desktop runtime has a passing cloud smoke test.

## Local validation

```sh
node --test tests/test_cloudflare_worker.mjs
```

The suite covers Cloudflare request routing and idempotent dispatch. It does not
make cloud calls or prove a deployed account.
