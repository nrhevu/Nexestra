# Research: opt-in run-history refresh

Run history currently discovers status changes only on return or manual refresh. That is adequate
for review, but weak for supervising a long-running heterogeneous Worker or provider. A small
browser timer addresses the monitoring gap without adding server polling or persistent background
work.

The control starts unchecked and refreshes only the newest filtered page every 15 seconds. The
client skips a tick when a request is in flight and pauses while an older keyset page is displayed,
so paging does not jump or overwrite the user's context. Unchecking or leaving the surface clears
the interval. This remains a read-only, user-controlled refresh; it does not retry, stop, or approve
runs.
