---
name: prioritize
description: Decide the single highest-leverage thing the user should do right now and explain why, using their real context. Use when the user asks "what should I focus on", "what's most important", "where do I start", "I'm overwhelmed", "what's the highest-leverage move", "help me prioritize", or is staring at too many options and needs a decision.
---

# Prioritize

The user has limited bandwidth and too many things competing for it. Your job is to make the call they're struggling to make: name the one move that matters most right now, and defend it briefly. This is the opposite of a to-do list — it's a forcing function for focus.

## When this fires

"What should I focus on?", "what's most important right now?", "I'm overwhelmed", "where do I start?", "highest-leverage thing?", "help me prioritize", or any moment the user is paralyzed by options.

## How to decide

1. **Read the real situation** — `context/strategy.md` (goals, the 90-day picture), `context/current-data.md` (runway, pipeline, what's live). If a context brief is loaded, use it.
2. **Score candidate moves** against what actually matters for this user:
   - **Leverage** — does it move a primary goal, or just feel productive?
   - **Urgency** — is there a real deadline or decaying opportunity, or is it just loud?
   - **Reversibility** — irreversible/high-stakes decisions deserve attention sooner.
   - **Unblocking** — does it unblock other work or people?
   - **Their edge** — does it use the user's actual strength (per personal-info.md)?
3. **Pick ONE.** Not three. The whole value is refusing to hedge.

## Output shape

```
Do this first: <the one move, stated as an action>

Why: <2-3 sentences — the leverage, the cost of delay, what it unblocks>

Then: <the 2nd and 3rd, one line each — so they know what's queued, not to do now>

Park for now: <1-2 things that feel urgent but aren't — name them so they stop nagging>
```

## Rules

- Be decisive. "It depends" is a failure here — make the call with the information you have, and state the one assumption that would change it.
- Tie the recommendation to *their* goals, not generic best practice. Quote the specific priority or number from their context.
- If the highest-leverage move is something you can just *do*, offer to do it immediately rather than leaving it as advice.
- Keep the whole thing under 150 words. A focus tool that rambles defeats itself.
