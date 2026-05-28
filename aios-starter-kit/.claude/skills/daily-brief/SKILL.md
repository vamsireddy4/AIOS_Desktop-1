---
name: daily-brief
description: Produce a tight, skimmable daily brief for the user — priorities, what's due, what's at risk, what moved. Use whenever the user asks for a brief, a daily/morning rundown, "what's on today", "catch me up", "where do things stand", a standup, or a start-of-day summary. Pulls from context files and any connected services.
---

# Daily Brief

Synthesize everything that matters today into a brief the user can read in 30 seconds and act on immediately. This is an operator's brief, not a status report — it tells them what to *do*, not just what *is*.

## When this fires

The user wants orientation: "brief me", "what's on today", "morning rundown", "catch me up", "where do things stand", "standup", "what should I know". If they want a recurring/scheduled brief, set that up as an AIOS task — but still produce today's brief now.

## Inputs to gather (in this order, stop when you have enough)

1. **Context** — read `context/strategy.md` and `context/current-data.md` for priorities and live numbers. (If a context brief is already loaded, use it — don't re-read needlessly.)
2. **Connected services** — if Gmail / Calendar / Slack / etc. are connected, pull *today's* signal only: unread that matters, today's meetings, anything assigned or flagged. Never dump inboxes — surface the 3-5 items that change the day.
3. **Workspace** — recent items in `outputs/`, `plans/`, open AIOS tasks. What's in motion.

If a service isn't connected and would materially improve the brief, note it once at the end as a one-line suggestion — don't block.

## Output shape

Keep it under ~200 words. Lead with the single most important thing. Structure:

```
**Today — <weekday, date>**

Top priority: <the one thing that matters most, and why>

Needs you:
- <decision / reply / approval that's blocking something>
- <time-sensitive item with the deadline>

In motion:
- <what's progressing, one line each>

At risk:
- <anything slipping, with the specific risk>

Suggested first move: <concrete next action they can take in the next 30 min>
```

Omit any section that's empty. Don't invent items to fill it out — a 3-line brief that's true beats a 12-line brief that's padded.

## Style

- Plain, direct, founder-to-chief-of-staff register. No corporate filler.
- Numbers where you have them ("$2,400 in receivables", "2 meetings"), not vibes.
- Every bullet implies an action or a decision. If a line is pure FYI with no action, cut it.
- Never mention how you got the data (Composio, MCP, tools). Just the facts.

## After the brief

Offer to act: "Want me to draft the reply to X / prep for the 2pm / knock out the top priority?" — then do it if they say yes.
