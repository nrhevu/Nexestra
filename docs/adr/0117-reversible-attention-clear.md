# ADR 0117: Reversible Attention clear

Status: Accepted

Attention history rows can clear the selected workspace's snooze or dismissal state. The clear
action is workspace-scoped, idempotent, and recorded as bounded metadata so the item can be
re-derived without changing task or transcript content.
