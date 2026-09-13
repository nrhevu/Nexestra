# Durable queued-run rehydration

The canonical transcript already persisted queued run records before dispatch. Startup now leaves
those records queued, scans their trigger messages, and resumes them through the normal per-agent
serial queue. Missing trigger messages become explicit failed runs; active or interaction-waiting
runs still recover as interrupted.
