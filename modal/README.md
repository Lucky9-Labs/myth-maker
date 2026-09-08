# Modal encounter-component runtime

`draft_trial.py` is the initial bounded worker for one encounter component. It
runs Blender 5.2.1 in a headful virtual desktop (`Xvfb` + Openbox), sends desktop
screenshots to Astra through the Responses API computer tool, validates returned
input actions, and publishes a hash-verified native checkpoint plus evidence.
Blender geometry is authored only through the GUI.

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
model computer-tool access, volume access, and spending limits:

```sh
modal secret create myth-maker-encounter-openai OPENAI_API_KEY='...'
```

The app expects the private Volume `myth-maker-encounter-submissions` and the
lease dictionary `myth-maker-encounter-component-leases`. Do not reuse the
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

`DRAFT_STATUS: READY_FOR_REVIEW` means only that the model requested review. A
reviewer must still reopen the native output in Blender, validate dependencies,
and run the host game's import, gameplay-interface, animation, collision, and
encounter checks before accepting any result.
