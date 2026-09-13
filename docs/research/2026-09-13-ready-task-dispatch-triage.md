# Ready-task dispatch triage

Custom surfaces already expose blocked tasks and entry points for new Tasks and Knowledge. Dispatch
supervision also needs a bounded answer to “what work can be delegated now?” The `ready_tasks` action
defines that queue from canonical Taskboard state: `todo` tasks without queued or running assignments.

A transient Taskboard filter preserves the full task workflow and workspace boundary while avoiding a
second task index or a configured query language. Finished assignment history remains visible after the
filter is cleared and does not prevent a todo task from becoming ready again.
