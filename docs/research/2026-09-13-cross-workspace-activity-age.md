# Cross-workspace activity age research — 2026-09-13

The cross-workspace Monitor already exposes bounded active-run and attention counts. The next
useful triage signal is the oldest timestamp in each category: a user can immediately see whether a
workspace has been running or waiting for hours without opening its transcript.

The server can derive these minima from existing projections, preserving the loopback API's
count-only and secret-free boundary. A shared `observedAt` timestamp keeps the snapshot coherent;
the browser formats optional ISO values as coarse relative ages and falls back to the existing
observation-age or archived labels when no timestamp is available.
