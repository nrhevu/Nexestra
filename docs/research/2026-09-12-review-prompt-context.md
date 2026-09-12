# Review prompt context research — 2026-09-12

The review queue is the harness's quality-loop checkpoint: a human decides whether a response should
be trusted or captured as Knowledge. The existing row contained a bounded response excerpt and an
optional note, but not the request that established success criteria. Deep links preserve accuracy,
yet requiring a navigation for every row makes triage expensive.

Nexestra already stores the exact `triggerMessageId` on generated replies and indexes transcript
message offsets. The selected design reads that one canonical user message, validates its thread and
author, redacts known credentials, and caps the excerpt at 800 characters. It omits context when old
messages lack provenance or the transcript is unreliable, preserving the queue's explicit coverage
warning and avoiding guesses from neighboring messages.

This keeps review useful without turning a human rating into an automated benchmark. A future export
can build on the stable IDs if evaluation cases become an explicit product surface.
