# Plan review dialog research — 2026-09-14

A durable approval flag is useful only if the user can assess the work it controls. The plan summary
already has bounded task metadata and prerequisite edges in the selected workspace, so a client-only
review dialog can show the proposal without a new transcript, API, or provider session.

The narrow design lists each loaded plan step with its description, verification command,
prerequisite status, and source-thread navigation. It keeps approval and rejection behind that
explicit review action, while reusing the existing workspace-scoped mutation. Viewing the plan must
not create a Knowledge document, assign a Worker, dispatch work, or resume the Master.
