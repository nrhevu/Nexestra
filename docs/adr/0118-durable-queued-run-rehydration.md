# ADR 0118: Durable queued-run rehydration

Status: Accepted

Queued runs remain queued across a server restart and are rehydrated into the dispatcher when the
application starts. Runs that were already executing or waiting for an interaction remain subject
to interruption recovery. This preserves accepted work without pretending to provide multi-process
leasing or exactly-once external effects; those remain future work.
