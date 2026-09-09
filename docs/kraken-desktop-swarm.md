# Kraken desktop swarm: two-worker gate

This is an intentionally small local launcher for the first two isolated Blender GUI workers. It is not a substitute for the coordinator, package assembler, or Unity acceptance.

The two reservations are intentionally disjoint:

- `kraken-mantle-core` owns only the mantle/head silhouette and eight named attachment empties, `Mount_T01` through `Mount_T08`.
- `kraken-tentacle-01` owns one complete tentacle and its local anchors, `T01_Root`, `T01_Tip`, and `T01_AccentRail`.
- Follow-on workers must use distinct numbered slots and directions. The second wave reserves `kraken-tentacle-02` for an upward sweep, `kraken-tentacle-03` for a defensive curl, and `kraken-tentacle-04` for a lateral reach; none may edit the tentacle-01 checkpoint.

Each container receives owner-only private writable source, HOME, and temp directories, plus a 127.0.0.1-only noVNC port. The container runs as the host owner UID, so Blender can write its own paths while other local accounts cannot alter them. The exact concept image is read-only. Its baseline checkpoint is copied before launch, then the copy is the only `.blend` it may save.

Launch the gate from a clean checkout with an immutable source checkpoint:

```sh
node tools/kraken-desktop-swarm.mjs launch kraken-mantle-core \
  --baseline /absolute/baseline.blend \
  --concept assets/concepts/kraken-observable-swarm-v1.png \
  --commit "$(git rev-parse HEAD)"
node tools/kraken-desktop-swarm.mjs launch kraken-tentacle-01 \
  --baseline /absolute/baseline.blend \
  --concept assets/concepts/kraken-observable-swarm-v1.png \
  --commit "$(git rev-parse HEAD)"
```

The registry is written outside the checkout by default at `/tmp/myth-maker-kraken-desktop-workers/registry.json`. Before assigning Blender UI actions, inspect both entries and their actual desktop:

```sh
node tools/kraken-desktop-swarm.mjs inspect kraken-mantle-core
node tools/kraken-desktop-swarm.mjs inspect kraken-tentacle-01
```

Passing infrastructure health alone is not a passed worker gate. Each assigned operator must inspect the correct noVNC desktop, make GUI-only changes, save through Blender's UI, emit before/after and final desktop views, then GUI-reopen the immutable checkpoint layout. A serialized integration worker owns the derivative assembly; these workers never write it.

After both source workers have GUI-saved and GUI-reopened their checkpoints, record immutable checkpoint hashes before starting `kraken-assembly`. Its desktop receives the two part sources only as read-only `/published/*.blend` files. It may append/link them through Blender's GUI into its own derivative `.blend`, but it may not alter either source file.
