# 0019 — `DemoLlmClient` when there is no API key

## Context

Without `ANTHROPIC_API_KEY` the Master cannot run, and a fresh checkout would be
a chat box that errors on the first message. The e2e suite has the same problem
in reverse: a real model would make the Playwright run paid and
non-deterministic.

## Decision

`createMasterLlm()` picks the client at startup:
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` present → the real Opus 5 client;
otherwise `DemoLlmClient`, a deterministic script that reads the workspace, asks
three clarifying questions, drafts a spec with three verifiable acceptance
criteria, requests approval and proposes a four-task plan.
`NEXESTRA_MASTER_LLM=demo|anthropic` overrides.

It is a real `LlmClient`: same phase machine, same strict tool validation, same
store writes. It decides what to do next from the phase in the system suffix and
from which tools the transcript already shows — no hidden state, so the same
conversation always produces the same run.

## Consequences

- A fresh checkout is a usable application, and the whole loop is demonstrable
  with `NEXESTRA_FAKE_HARNESS=1` and no account anywhere
  ([0018](0018-fake-harness-for-dev-and-tests.md)).
- The demo model gets the *same* acceptance test as the scripted one, because it
  is what someone without a key actually meets.
- It is a script, not a fallback model: it produces a sensible shape for any
  request but understands none of them, and it cannot replan — so the
  `executing` and `verifying` phases are only lightly exercised without a key
  (`docs/ARCHITECTURE.md` §11).
- `GET /api/health` and `GET /api/settings` report which client is live and
  whether a key is present, never the key.
- The e2e suite deliberately strips `ANTHROPIC_API_KEY` from the server's
  environment, so exporting one in a shell cannot silently turn the Playwright
  run into a paid one.

## Status

Accepted. Implemented in `apps/server/src/master/demo-llm.ts`,
`apps/server/src/master/llm.ts`, `packages/master/src/llm/fake.ts` (the unit
test client). Proved by `apps/server/src/master/demo-llm.test.ts`.
`docs/master.md` §9.6.
