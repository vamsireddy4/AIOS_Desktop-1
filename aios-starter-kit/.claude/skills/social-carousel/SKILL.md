---
name: social-carousel
description: Turn an idea, a rough note, a link, or a long-form piece into a ready-to-post multi-slide social carousel (LinkedIn / Instagram / X). Use when the user asks for a carousel, slides, a "swipe post", a LinkedIn/IG carousel, wants to repurpose content into slides, or says "make this into a carousel/post".
---

# Social Carousel

Turn a single idea or an existing piece of content into a scroll-stopping multi-slide carousel that's ready to post. The output is the actual slide-by-slide copy, not advice about carousels.

## When this fires

"Make a carousel", "turn this into slides", "LinkedIn carousel", "IG carousel", "swipe post", "repurpose this thread/article into a carousel", "turn my notes into a post".

## Gather (fast)

1. **The source** — the idea, note, link, or doc the carousel is about. If it's a file or URL, read it. If it's a one-liner, that's enough — build from it.
2. **Voice** — check `context/personal-info.md` / any writing-style notes for the user's tone. If a writing-style skill or reference exists, honor it. Default to the user's natural register, not generic LinkedIn-guru voice.
3. **Platform** — ask only if it matters for length/format and isn't obvious. Default: LinkedIn (7-10 slides).

Don't over-interview. One idea + their voice is enough to draft.

## Output shape

Produce the full carousel as numbered slides. For each slide: a punchy headline line + 1-2 supporting lines max (carousels are skimmed, not read).

```
**Carousel: <topic>**  ·  <platform>  ·  <N> slides

Slide 1 — HOOK
<a scroll-stopping hook; a tension, a bold claim, a surprising number>

Slide 2 — <subhead>
<one idea, 1-2 lines>

... (one idea per slide; build an arc: hook → problem → turn → payoff)

Slide N — CTA
<a clear, low-friction call to action>

---
Caption: <2-4 line post caption with a hook + 3-5 relevant hashtags>
```

## Craft rules

- **Slide 1 is 80% of the job.** If the hook doesn't stop the scroll, nothing else matters. Lead with tension, a contrarian take, a specific number, or a "you're doing X wrong" frame.
- **One idea per slide.** If a slide has two ideas, split it.
- **Concrete > abstract.** Real numbers, real examples, real steps. Cut adjectives.
- **Arc, not list.** Hook → stakes → insight → proof → payoff → CTA. The reader should feel pulled to the next slide.
- Match the user's actual voice. If they're blunt, be blunt. Don't sand it into LinkedIn pablum.

## After drafting

Offer to: save it to `outputs/` as a file, adapt it for a second platform, or tighten any slide. If the user has a design tool connected (e.g. Canva), offer to take it further.
