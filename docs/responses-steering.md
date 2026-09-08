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

`src/responses-steering-worker-main.js` is the deployable Node worker entrypoint.
That process opens and owns each Responses socket, persists its lane state and
required-input results in `JsonSteeringStore`, and reports lifecycle receipts to
the coordinator. The coordinator never accepts a socket. `STEERING_COMMAND_TOKEN`
is only for coordinator-to-worker commands; `STEERING_REPORT_TOKEN` is only for
worker-to-coordinator reports. `STEERING_WORKER_OWNER_ID` pins this V0 to one
configured worker owner: the authenticated report header, attempt, receipt, and
command must all name that exact owner. The lane is never sent over HTTP.
After a worker-process restart, a new WebSocket is never treated as the old
attempt's lane. Existing receipts are retained as transport-uncertain and the
producer must register a fresh attempt once it has a genuinely active socket.

The beta event correlation is nested under `event.steer`: its server steering
ID, parent response ID, and lane identify a receipt. A lifecycle event without
that complete correlation is ignored, and generic response errors are never
attributed to a steer. `accepted` and `pending` are non-commit states; an
explicit server `failed` (whose code is `event.error.code`) is terminal. A dropped
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
`response.steer.pending` may carry its root `reason` and `required_input`
stubs. Those stubs become `required_input`; the worker validates the protocol's
discriminated result union (function/custom/computer/shell/apply-patch/tool-search
call outputs by `call_id`, and MCP approval responses by `approval_request_id`).
It sends exactly one explicit
`response.create` continuation per parent, without rerunning a tool or
resending the steer. A completed response uses the same explicit continuation
path.

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

The beta `response.steer` frame is isolated in `ResponsesSteeringGateway` as
an injected beta protocol contract. The public references below do not document
this beta wire shape; they support only the general Responses lifecycle and
input forms. The gateway is covered by a fake WebSocket lane plus a restartable
worker-process store. This repository makes no live API call or claim of
account-level beta availability.
