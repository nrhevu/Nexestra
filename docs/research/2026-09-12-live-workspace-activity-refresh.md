# Live workspace activity refresh research — 2026-09-12

Bootstrap-time activity badges can become stale while another workspace runs. A count-only endpoint
and conditional five-second poll keeps supervision current without exposing transcript details or
polling when all workspaces are idle.
