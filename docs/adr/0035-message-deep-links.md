# 0035 — Stable message links and focused conversation navigation

## Status

Accepted for Milestone M9.

## Context

Transcript search needs to open the matched message, including in an archived conversation. Opening
only the thread would immediately scroll to its latest content and leave the user to find the match
again. Thread names can change, and a link can be opened while another workspace is selected.

## Decision

Message links use `/threads/<thread-id>?message=<message-id>`. Both IDs are stable stored identities;
thread names and slugs are never used to locate a message. The message query is optional, so existing
thread links keep their behavior. The existing foreign-thread lookup resolves the owning workspace
before rendering a target, including archived threads.

The route carries a fresh message-target object for each navigation. The conversation switches to
Messages, highlights the matching group and focuses it once it is available. New transcript updates
do not pull the view to the bottom while a message target is selected. **Show latest** removes the
query and resumes ordinary latest-message scrolling. Selecting the same result again is a new
navigation, so it can reopen the Messages tab after the user viewed Files & links.

A missing message shows an explicit notice and a Show latest action; another message is never
highlighted as a substitute. An ordinary workspace switch clears the old message target. Resolving
a foreign message link retains the target, since that switch belongs to the link itself.

Message links, highlighting and focus are view state. They do not append events, change thread
metadata, restore archived threads or dispatch agents. Draft handling stays thread-scoped.

## Validation and limits

Focused UI tests cover active/archived links, selected-message focus, Show latest, another message
in the same thread after changing tabs, missing targets, foreign archived links and ordinary
workspace switches. Search-to-message tests also cover selecting the same archived result again
after opening Files & links. Browser verification remains required when the API is integrated.

- The current thread endpoint and renderer still load a full transcript. This change does not add
  transcript pagination or rendering virtualization.
- Focus selects the message group, not a substring inside formatted Markdown. Media loaded later
  can change row height; browser verification must check the actual selected message is visible.
- External malformed message IDs longer than 200 characters are ignored by the route parser.
