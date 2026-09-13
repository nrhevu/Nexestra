# ADR 0122: Custom surface agent entry

Status: Accepted

Custom surfaces may include the allowlisted `new_agent` action. It opens Nexestra's existing,
workspace-scoped AgentDialog for creating a Worker or Master profile. The dialog retains its normal
validation, credential handling, and refresh behavior; configuration cannot define provider fields,
URLs, credentials, or executable code.
