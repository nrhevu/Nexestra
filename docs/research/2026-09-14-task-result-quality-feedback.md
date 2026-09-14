# Task-result quality feedback research — 2026-09-14

Worker output already has canonical-message provenance and the application already tracks reviewed
agent replies for cost and quality analysis. Exposing the same rating where a task result is inspected
creates one feedback loop for delivered work without adding a second review store or copying output
into a task field.

The process endpoint can return only the existing feedback associated with its bounded canonical
source message. Helpful and needs-work controls reuse the established message-feedback mutation;
negative feedback continues to enter the Needs-work queue. A rating is evidence about output quality,
not proof of task completion, so it must not change task status or automatically retry a Worker.
