# ADR 0062 — Configure safe declarative workspace surfaces

## Status

Accepted.

## Context

The product brief calls for workspace surfaces that adapt to a domain such as inference
optimization. Nexestra's core surfaces are intentionally fixed and trusted, while arbitrary browser
code in a workspace configuration would widen the local server's attack and maintenance surface.

## Decision

Extend `nexestra.config.json` with optional `surfaces`. Each surface has a bounded ID, title,
description, and up to twelve cards. A card contains only text and an action that targets one of
the existing trusted surfaces: Taskboard, Knowledge, Attention, Run history, Needs-work review, or
Agents. The server validates and redacts these labels before including them in bootstrap data. The
SPA renders the cards and routes through its existing navigation; it does not evaluate HTML,
JavaScript, URLs, or commands from configuration.

## Consequences

Users can make a domain-specific launch surface, such as an “Inference lab” that groups model
profiles, run comparison, and review, without changing the core data model. Cards that target
Taskboard, Knowledge, Attention, and Agents also show live counts from the selected workspace.
The first slice is a safe navigation composition. Data-backed widgets, custom forms, and executable
plug-ins remain separate proposals requiring their own permission and persistence design.
