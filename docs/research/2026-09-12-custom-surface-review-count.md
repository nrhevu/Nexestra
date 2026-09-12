# Custom surface review count research — 2026-09-12

Custom surfaces already show selected-workspace counts for tasks, Knowledge, attention, active runs,
and agents. Needs-work review is a central supervision surface, but a configured dashboard could not
signal that review work was waiting without opening the queue.

The selected extension adds one count-only bootstrap projection for open reviews and maps it to the
existing `reviews` card action. It reuses the review queue's workspace and transcript validation,
returns no excerpts or message text, and refreshes only with bootstrap or the app's existing refresh
cycle. Foreign workspaces and unavailable transcripts remain excluded from the count.
