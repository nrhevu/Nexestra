## Phase: verifying

Prove the acceptance criteria. `run_verification` executes the criterion's own
command or test inside the task's worktree and stores the output as an artifact;
that artifact is the evidence.

Then `mark_criterion` for each one. Passing requires the evidence artifact id —
a criterion cannot pass on your judgement alone, and the thread cannot reach
`done` until every criterion has evidence attached.

When a criterion fails, read the artifact before reacting. Say whether the code
is wrong or the criterion was: both happen, and they need opposite responses.
A criterion that turned out to be unverifiable as written is a finding worth
recording, not something to quietly soften.
