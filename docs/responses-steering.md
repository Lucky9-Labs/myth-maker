# Responses steering gateway

The coordinator offers an optional, no-approval human-steering path for one
active, single-agent Responses WebSocket attempt.

## Coordinator interface

All routes are scoped to an encounter:

```text
POST /v1/encounters/:encounterId/work-items/:workId/steering-attempts
POST /v1/encounters/:encounterId/work-items/:workId/steers
GET  /v1/encounters/:encounterId/work-items/:workId/steers
GET  /v1/encounters/:encounterId/work-items/:workId/steers/:clientSteeringId

POST /v1/encounters/:encounterId/steers
GET  /v1/encounters/:encounterId/steers
```

The attempt sidecar has a stable attempt, worker, lane, and active response ID.
It is intentionally not added to the closed `WorkerEvent` v1 contract. A
receipt persists a client steering ID, input SHA-256, bounded user input,
request time, lifecycle status, and successor response ID. The receipt's event
list is suitable for a build-room timeline.

`ResponsesSteeringWorker` owns the upgraded Responses connection in the worker
process. It reports an attempt and lifecycle receipts through the dedicated
worker token; the coordinator never accepts a socket or treats an ingress token
as worker identity. `SteeringWorkerAdapter` carries a queued user command to
that owner. The lane is never sent over HTTP.

The beta event correlation is nested under `event.steer`: its server steering
ID, parent response ID, and lane identify a receipt. `accepted` and `pending`
are non-commit states; an explicit server `failed` is terminal. A dropped
connection remains `pending` with reconciliation metadata—never replayed—until
the worker can report a definitive server outcome.

Only one user-role input message is accepted, with bounded text, image, or file
content. The active lane writes exactly this beta frame:

```json
{
  "type": "response.steer",
  "previous_response_id": "resp_active",
  "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "..." }] }]
}
```

`response.steer.accepted` changes a receipt from `queued` to `accepted`, which
means the request is server-owned, not applied. It becomes `committed` only on
the automatic successor `response.created` whose `previous_response_id` matches
the receipt. An incomplete response whose reason is `steered` remains `pending`.
Required-input stubs become `required_input`; the worker resolves them from its
saved results and sends exactly one explicit `response.create` continuation per
parent, without rerunning a tool or resending the steer. A completed response
uses the same explicit `response.create` continuation path.

Multi-agent, conversation, automatic-compaction, and unsupported-model
attempts return an `unsupported` receipt without writing to a lane.

Encounter-level steering appends a planner directive revision and submits new
work attempts. It cannot change any frozen package, prior package, or prior
artifact.

## Official OpenAI references

- [Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming)
  documents `response.created`, completion/incomplete lifecycle data, response
  chaining with `previous_response_id`, and user-role text/image/file input
  forms.
- [OpenAI API quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)
  provides current user input examples for image and file analysis.

The beta `response.steer` frame is isolated in `ResponsesSteeringGateway` and
is covered by a fake WebSocket lane. This repository makes no live API call or
claim of account-level beta availability.
