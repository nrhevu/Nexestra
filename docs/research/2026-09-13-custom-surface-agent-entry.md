# Custom surface agent entry

Domain-specific surfaces need a direct way to add the heterogeneous agents they supervise. The
`new_agent` action reuses the existing AgentDialog, so a surface can move from monitoring to setup
without introducing a second form or bypassing workspace scoping and credential protections.
