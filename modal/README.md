# Modal encounter-component runtime

`draft_trial.py` is the initial bounded worker for one encounter component. It
runs Blender 5.2.1 in a headful virtual desktop (`Xvfb` + Openbox), sends desktop
screenshots to Astra through the Responses API computer tool, validates returned
input actions, and publishes a hash-verified native checkpoint plus evidence.
Its API-operated `run_draft` path authors Blender geometry only through the GUI.
The separately documented deterministic fallback below runs a closed recipe via
Blender Python; it does not relax the GUI-only policy for `run_draft`.

The worker has no GitHub credential, no mounted Unity checkout, no local desktop
access, no old job migrations, and no automatic integration. It stages a
version-one input package at stable paths:

- `/inputs/source_scene.blend`
- `/inputs/structure_reference.png`
- `/inputs/component_reference.png`
- `/inputs/primary_artwork.png`
- `/inputs/concept_reference.png`

The generic `component_id` is lowercase kebab-case and produces
`/output/<component_id>.blend`. The caller must snapshot and hash inputs before
submission, and namespace its lease by project plus component before invoking
this function.

## Configuration before any deployment

Create independent Modal resources only after a preflight verifies credentials,
model computer-tool access, volume access, and spending limits. Resource names
and the selected Modal environment are declared in
[`infrastructure.py`](infrastructure.py); it has no Modal SDK dependency and can
render the non-secret handoff locally:

```sh
python3 modal/infrastructure.py --environment dev --check-files
```

The `dev` environment must already exist before deployment. The app's Volume,
Dict, and secret handles intentionally omit an explicit environment name, so
Modal resolves them in the `modal deploy --env <environment>` target rather than
pinning every deployment to `dev`. The CI deployment controller—not an
implementation worker—creates those resources after the preflight, using:

```sh
# CI deployment controller only
modal secret create --env dev myth-maker-encounter-openai OPENAI_API_KEY='...'
modal volume create --env dev myth-maker-encounter-submissions
modal dict create --env dev myth-maker-encounter-component-leases
modal deploy --env dev modal/draft_trial.py
```

Its receipt must identify the immutable source revision, Modal app deployment
ID/version, named resource verification, and the non-secret handoff revision.

The app expects the private Volume `myth-maker-encounter-submissions`, the lease
dictionary `myth-maker-encounter-component-leases`, and the secret
`myth-maker-encounter-openai` with an `OPENAI_API_KEY` key. Do not reuse the
source project's resources, secrets, jobs, or artifacts. The image pins Blender
5.2.1 and verifies its archive SHA-256 before extraction. Its download may retry
during image construction only; worker-function and OpenAI API retries remain
disabled.

## Runtime boundary

The function has a T4 GPU, 4 CPUs, 8 GiB memory, a 16-minute container timeout,
a 12-minute interaction deadline, at most four containers, and zero function or
API retries. It preserves the last valid checkpoint after a failure but does not
provide a global coordinator, cross-release capacity limit, idempotent submission
API, active-release pointer, or Unity importer. Build and validate those layers
before treating it as a production service.

`DRAFT_STATUS: READY_FOR_REVIEW` means only that the model requested additional
inspection; it is not acceptance. Automated host validation must inspect the
native output, validate dependencies, and run the host game's import,
gameplay-interface, animation, collision, and encounter checks before a result
can graduate.

## Deterministic recipe fallback

`draft_trial.run_deterministic_recipe` is a separate bounded Modal function for
an observable fallback when the API-operated GUI worker cannot be used. It
accepts the closed `myth-maker.deterministic-encounter-recipe/v1` shape:
generic body dimensions, repeated curved appendage dimensions, four material
colors, and one camera. It runs Blender's own Python entrypoint inside the
Modal container and writes a native `.blend`, a self-contained GLB validated by
the existing GLB structural validator, and three real renders: `initial`,
`intermediate`, and `final`.

This function has the same private evidence Volume but **does not mount the
OpenAI secret, initialize an OpenAI client, or require `OPENAI_API_KEY`**. Its
in-container receipt binds the provider call/input IDs, immutable source
revision, recipe hash, native/GLB/frame hashes, Blender command result hashes,
and GLB structural summary. The observed GitHub workflow downloads every
provider-persisted byte and rejects any mismatch. `Kraken` is merely the
workflow's demo recipe ID; it is not a type, schema field, or special branch in
the construction code.

The fallback proves Blender construction and artifact persistence, not a
gameplay-ready enemy. It does not claim rigging, collision, navigation, AI,
host import, or player-facing acceptance.

## v1 worker-event adapter

`encounter_worker_adapter.py` is an offline-testable adapter around one
existing draft invocation. Its small interface is
`BlenderDraftWorkerAdapter(...).run(work_order) -> BlenderDraftRunResult`: the
caller binds the existing `run_draft.remote` invocation and its
already-snapshotted inputs through `ModalDraftRunner`, while the adapter accepts
one `EncounterWorkOrder` and translates the returned terminal receipt. That
binding maps `work_id` to the legacy `part` and its expected
`<work_id>.blend` filename, and derives an attempt-specific legacy job ID.

The adapter never imports Blender or Modal, never changes the GUI-only action
policy, and never retries work. A successful native receipt must be named
`<work_id>.blend` in the draft state and include a SHA-256 and byte count. It
then emits ordered `accepted`, `started`, `progress`, and `completed` events,
alongside an immutable adapter-local `SourceArtifactReceipt` addressed as
`sha256:<digest>`. The `.blend` is an unaccepted source artifact, not a
Unity-loadable runtime asset or target bundle.

`blocked` maps to a non-retryable `failed` event with `draft-blocked` as its
error code. Runtime exceptions,
failed draft states, and missing/invalid native receipts become explicit
`failed` events; retryable events tell the coordinator to issue a new work
order with the next `attempt`, rather than making an automatic worker retry.
The current v1 module envelope has no source-artifact-only kind, so the adapter
does not emit `candidate_produced` or invent an `EncounterModule`. A
policy-validating importer must transform the source into a host-loadable module before emitting
that candidate event. This is an additive contract gap for a later sidecar or
v2, not a reason to modify the published v1 schemas here.

## Dispatcher Modal backend (preflight only by default)

`modal_dispatch_backend.py` is the opt-in bridge from a dispatcher receipt to
the existing `draft_trial.run_draft.remote` entrypoint. `preflight(work_order)`
is local-only: it validates the existing five-file input package and prints the
stable `work_id`-derived `part` and `draft-gui-<work_id>-a<attempt>` job ID. It
does not import Modal, inspect credentials, create resources, launch a
container, or make a paid/cloud call.

`run(work_order)` resolves the existing Modal remote function only when the
backend's deployed `cloud_execution_enabled` policy is true. This is a service
configuration decision, not a per-call human approval gate. Tests and local
workgraphs keep it false. Runtime credentials, spend limits, volume access, and
GUI-output validation remains separate operational checks; the local example is not
evidence that Modal is deployable or that a Blender candidate is accepted.

The deployed Railway bridge uses `ModalVolumeDraftBackend` instead. It passes a
small closed manifest to `run_draft_from_volume_manifest`, which loads the five
inputs from the private Modal Volume and verifies every recorded byte length and
SHA-256 before entering the same GUI-only draft implementation. The checked-in
Kraken manifest is demo data; the manifest schema remains encounter-generic.

## Automated-policy GLB importer sidecar

`glb_source_importer.py` implements that next, deliberately narrow seam. It
requires a hash-matching `SourceArtifactReceipt`, a host-compatible loader target,
and a conversion adapter. After source/hash, GLB structure, and output-hash checks,
the importer itself emits automated `blender-export-v1` acceptance evidence; no caller
supplies an acceptance receipt. A human/API steer is never artifact acceptance. It validates
the output as a self-contained GLB 2.0 and only then emits a generic v1
`runtime_asset` plus its additive `glb.v1` loader sidecar. The sidecar format and its non-goals are in
[`../docs/glb-v1-loader-profile.md`](../docs/glb-v1-loader-profile.md).

The importer discovers the Blender CLI either from `PATH` or the macOS app
bundle. Its focused test suite builds a deterministic real `.blend` fixture,
exports it through `BlenderCliGlbConverter`, then validates the resulting GLB.
The command below reports whether that concrete adapter is available:

```sh
python3 glb_source_importer.py --check-live-conversion
```
## CI-owned Modal activation

Only the trusted GitHub Actions deployment workflow may bootstrap or deploy this
runtime. Its `dev` environment needs `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and
`OPENAI_API_KEY`; the controller creates the dedicated Modal environment,
Volume, Dict, and `myth-maker-encounter-openai` secret idempotently, deploys the
app, resolves public resource/function IDs, and waits for one bounded remote
probe before writing its receipt artifact. The current bootstrap uses the
authenticated maintainer profile because Modal's CLI cannot mint a scoped token
without a browser session. Rotate both GitHub Modal secrets to a dedicated
least-privilege CI token as soon as one is created; do not use local worker
credentials for ordinary dispatches.

### Roadmap assessment

This activation proves one observed Modal function call and terminal generic
work-order receipt only. It does **not** complete C3: Build Room does not yet
show this remote worker beside a current package, steer its next priority, or
freeze a package from this receipt. It does **not** complete C4: this bounded
probe is not a real body-lane draft and does not demonstrate two independent
lanes completing in either order with absence-tolerant assembly. It does
**not** complete D0: it produces no request-scoped Blender artifact, strict GLB
validation, immutable catalog revision, assembly receipt, or player-facing
package. Build Room may label an event `modal_remote` only after its
authenticated observer validates this provider receipt; this CI activation does
not inject one into Build Room.
