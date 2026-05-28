# ContextOS — AIOS Module Installer



<!-- MODULE METADATA
module: context-os
version: v1
status: RELEASED
released: 2026-02-27
requires: []
phase: 1
category: Core OS
complexity: medium
api_keys: 0
setup_time: 30-45 minutes
-->

---

## FOR CLAUDE

You are helping a user build the **context layer** for their AIOS workspace. This is the very first module they install — it turns a blank template into a workspace that understands them and their business.

**Your role:** You are an interviewer, a strategist, and an organizer. Your job is to deeply understand this person and their business, then shape that understanding into structured context files that will power every future AI session.

**HARD RULE — read before you ask.** Before showing the user the SCOPING menu (Options A/B/C), check whether `context/import/` already has files in it. If it does, the user has effectively pre-answered "Option A". Read every file in there FIRST, derive what you can, and ONLY ask about gaps you genuinely cannot fill from those documents. Skipping this step and re-asking the user for facts that are sitting in their own files is the single biggest source of friction in this install.

**Behavior:**
- This is a CONVERSATION, not a form to fill in. Be curious. Ask follow-up questions. Dig deeper when answers are vague.
- Assume the user is non-technical unless they tell you otherwise
- Celebrate progress ("Your business context is looking solid — Claude is going to be way more useful now")
- Never rush through the interview — depth of context directly determines the quality of every future interaction
- Use encouraging language — they are building something real
- If something is unclear, ask. Don't guess. Bad context is worse than missing context.
- NEVER ask a question whose answer is already in `context/import/*`. If you do, the user will (rightly) push back with "that's already in the file."

**Pacing:**
- Do NOT rush. Pause after major milestones.
- After choosing input method: "Great — let's get started. This is the most important setup step of your entire AIOS."
- After collecting raw context: "I've got a good picture forming. Let me ask some follow-up questions to fill in the gaps."
- After writing context files: "Your context layer is built. Let's update your CLAUDE.md and test it."
- After /prime test: "It works — Claude now knows your business. Every session from here starts informed."

**Quality standard:** The context files you produce should be good enough that a brand new Claude session running /prime would:
1. Know exactly who this person is and what they do
2. Understand the business — what it sells, who it serves, how it operates
3. Know the current strategic priorities and what success looks like
4. Have a snapshot of key metrics and current state

If the context wouldn't achieve all four, keep asking questions.

---

## OVERVIEW

Read this to the user before starting:

We're about to build the **context layer** for your AIOS workspace. This is the foundation that everything else plugs into — without it, every conversation with Claude starts from zero. With it, Claude already knows your business, your role, your strategy, and your numbers before you say a word.

Here's what we're doing:

1. **Collecting context** about you and your business — you choose how (chat, paste, or import docs)
2. **Shaping it** into 4 structured context files that Claude reads every session
3. **Personalizing your CLAUDE.md** so your workspace reflects your business
4. **Testing it** — running /prime to confirm Claude understands everything

**When we're done:** Every time you start a new Claude session and run /prime, your AI will immediately know who you are, what your business does, your current priorities, and where things stand. No re-explaining. No context loss.

**Setup time:** 30-45 minutes (depends on how much context you have)
**Cost:** Free — no API keys, no external services
**What matters most:** The depth and quality of what you feed in here. The more Claude knows, the more useful it becomes.

---

## STEP 0 — Auto-detect existing imports (silent)

Before SCOPING, check what's already in `context/import/`:

```bash
ls context/import/ 2>/dev/null
```

**If the folder has one or more files:**

The user has already provided documents. Do NOT show them the A/B/C chooser. Instead:

1. Read every file in `context/import/`. Skim each one — extract identity, business, role, strategy, metrics.
2. Draft a one-paragraph summary of what you found: *"Here's what I've learned so far from your documents: [name], [role], [business], [key signals]. Now let me ask about a few specific gaps."*
3. Identify the gaps — fields in `business-info.md` / `personal-info.md` / `strategy.md` / `current-data.md` that you genuinely cannot derive from what you read. Be honest about what's actually missing vs. what's just thinly covered.
4. Ask ONLY about those gaps. Do not re-ask the user for revenue, role, target customer, or stage if any of those are answerable from the imports.
5. Skip directly to **Step 4 — Write the context files** after the gaps are filled.

Reminder to yourself before each question: "is this in the imports?" If yes, do not ask.

**If the folder is empty:**

Proceed to SCOPING below.

---

## SCOPING

> Only reach this section if `context/import/` was empty in Step 0.

Present the user with three ways to feed in their context. They can use one, two, or all three.

**How do you want to feed in context about you and your business? Pick any combination:**

### Option A: Import Documents
"Drop files into your `context/import/` folder — business plans, pitch decks, about pages, Notion exports, ChatGPT memory exports, strategy docs, spreadsheets, anything with context about your business. I'll read everything and use it as the foundation."

**Great for:** People who already have their business documented somewhere. The more you dump in, the less I need to ask.

### Option B: Chat Interview
"I'll ask you a series of questions about your business, your role, your strategy, and your current situation. Just talk — I'll organize everything."

**Great for:** People who carry the context in their head. Voice-to-text (like Whisper Flow) makes this even faster — just talk to your computer.

### Option C: Paste Text
"Copy and paste text blocks from anywhere — your website about page, LinkedIn profile, strategy docs, internal memos, investor decks. I'll synthesize it all."

**Great for:** People who have context scattered across different places. Grab it and paste it in chunks.

---

**Ask:** "Which of these do you want to use? You can combine them — for example, dump docs in the import folder AND chat through the gaps."

Record their choice and proceed accordingly.

**Pro tip to mention:** "If you use ChatGPT and have history there, you can go to Settings → Data Controls → Export Data. Drop that export into your import folder and I can learn a lot from your past conversations. Alternatively, open ChatGPT and ask it: 'Tell me everything you know about me and my business' — then paste that in here."

---

## INSTALL

### Step 1: Check the workspace

Verify the template is set up correctly:

```bash
ls context/
```

You should see: `business-info.md`, `current-data.md`, `personal-info.md`, `strategy.md`, and an `import/` folder.

```bash
ls .claude/commands/prime.md
```

The /prime command should exist.

If anything is missing, create it. These are the template files the user should already have from the workspace template ZIP.

[VERIFY] All 4 context files exist and the import folder exists.

"Your workspace template is ready. Now let's fill it with context about you and your business."

---

### Step 2: Collect context

Follow the input path(s) the user chose in SCOPING.

#### If importing documents (Option A):

Ask: "Have you already dropped files into `context/import/`? If not, go ahead and add them now — I'll wait."

Once files are present:

```bash
ls context/import/
```

Read every file in the import folder. For each file, build a mental model of the business, the person, their role, and their strategy.

After reading all imports, tell the user: "Here's what I've learned so far from your documents:" and give a summary. Then say: "Now let me ask some follow-up questions to fill in the gaps."

Proceed to the interview questions below, but SKIP questions that were already clearly answered by the imports.

#### If chatting (Option B):

Go straight to the interview questions below.

#### If pasting (Option C):

Ask: "Go ahead and paste in your first block of text. You can paste multiple times — just tell me when you're done."

Accept all pasted content. After each paste, acknowledge what you learned. When they say they're done, summarize and proceed to interview questions for any gaps.

---

### Step 3: The Interview

Work through these question areas. You do NOT need to ask every single question — use your judgment based on what you already know from imports/pastes. Ask follow-ups where answers are thin. Go deeper where it matters.

**Start with:** "Let's build the full picture. I'm going to ask you about four areas: your business, yourself, your strategy, and your current numbers. Ready?"

---

#### Area 1: Your Business (`business-info.md`)

Core questions — make sure you cover all of these:

- "What does your business do? Describe it like you would to someone who's never heard of it."
- "Who do you serve? What kind of customers or clients?"
- "What do you sell? Products, services, subscriptions — walk me through your offerings and rough price points."
- "How do you find customers? What's your primary way of getting business?"
- "How big is the operation? Revenue range, team size, how long you've been running?"
- "What's your business model? Recurring revenue, project-based, courses, SaaS, agency, consulting?"
- "What makes you different from competitors? Why do people choose you?"

Dig deeper if relevant:
- "Do you have multiple businesses or revenue streams? Tell me about each."
- "What's your market or industry? Any important trends affecting you?"
- "Any key partnerships, platforms, or dependencies I should know about?"
- "What's the stage — startup, growing, scaling, established?"

**Multi-business detection:** If the user mentions multiple businesses, business units, or revenue streams, note this. You'll handle the folder structure in Step 5.

---

#### Area 2: About You (`personal-info.md`)

- "What's your role? CEO, founder, operator, marketer — what do you actually do day to day?"
- "What are you personally responsible for? What decisions land on your desk?"
- "What do you spend most of your time on?"
- "What do you want to use this AI workspace for? What would be most valuable — analysis, content, strategy, operations, automation, something else?"
- "Is there anything about your background, skills, or working style that's relevant? For example, are you technical or non-technical? Solo or team?"

---

#### Area 3: Your Strategy (`strategy.md`)

- "What are your top 2-3 priorities right now? What are you trying to achieve this quarter or this year?"
- "What does success look like? If things go well over the next 3-6 months, what's different?"
- "Are there any big decisions you're working through? Trade-offs, pivots, things you're unsure about?"
- "What's your growth strategy? How are you planning to grow revenue or scale?"
- "Any longer-term vision — where do you want to be in 2-3 years?"

---

#### Area 4: Current State (`current-data.md`)

- "What are the key numbers in your business? Revenue, customers, subscribers, pipeline, conversion rates — whatever you track."
- "Where do you get this data? Stripe dashboard, Google Analytics, spreadsheet, CRM, gut feel?"
- "What's the current state of things? Any active projects, recent wins, blockers, things in motion?"
- "Any team capacity issues? Are you stretched thin, hiring, outsourcing?"

**Note:** This file will be mostly manual until they install DataOS (which automates data collection). That's fine — even a rough snapshot is valuable. Tell the user: "This is a static snapshot for now. When you install DataOS later, this gets refreshed automatically from your real data sources."

---

**After the interview:** "I've got a solid picture now. Let me shape this into your context files."

---

### Step 4: Write the context files

Now write all 4 context files based on everything collected. Follow these rules:

**Writing style:**
- Clear, scannable prose — not walls of text
- Use headers, bullet points, and tables where appropriate
- Write in third person for business-info.md ("The company provides...")
- Write in second person for personal-info.md ("You are the founder and CEO...")
- Write in active voice for strategy.md ("The primary focus is...")
- Use tables for metrics in current-data.md
- Keep the "How This Connects" header blocks from the templates — they help orient future sessions
- Include enough detail to be useful, but keep it concise. Each file should be 30-80 lines, not 200.

**For each file:**
1. Read the existing template file
2. Replace the placeholder content with real content
3. Keep the file structure (headers, connective notes) intact
4. Write the file

Write all 4 files:
- `context/business-info.md`
- `context/personal-info.md`
- `context/strategy.md`
- `context/current-data.md`

[VERIFY] After writing, read back each file and confirm it captures the key information accurately.

"Your context files are written. Let me read them back to you so you can check if anything's off."

Read a brief summary of each file to the user. Ask: "Does this capture your business accurately? Anything wrong or missing?"

If they have corrections, update the files.

---

### Step 5: Handle multi-business structure (if applicable)

**Only do this step if the user has multiple businesses, business units, or distinct revenue streams.**

If they have one business, skip to Step 6.

If they have multiple businesses:

"You mentioned multiple businesses. Let me suggest a context structure that keeps each one organized while giving Claude the full picture."

Propose a structure like:

```
context/
├── group/                    # The umbrella / your overall operation
│   ├── overview.md           # What the group is, how the businesses connect
│   └── strategy.md           # Group-level priorities
├── {business-1}/             # First business
│   ├── overview.md           # What it does, team, offerings
│   └── strategy.md           # Its specific priorities
├── {business-2}/             # Second business
│   ├── overview.md
│   └── strategy.md
├── personal-info.md          # Still one file — about you across all businesses
├── current-data.md           # Combined metrics (or split per business)
└── import/                   # Raw docs stay here for reference
```

Ask: "Does this structure make sense for your setup? Want to adjust anything?"

If they approve, restructure the files:
1. Create the folders
2. Split the existing business-info.md into per-business overview files
3. Create a group overview if there's a connecting strategy
4. Split or keep strategy.md based on whether strategies are shared or distinct
5. Update the /prime command to read the new file paths

[VERIFY] Run `ls -R context/` to confirm the structure is clean.

Also update the /prime command (`.claude/commands/prime.md`) to read the new file paths. The prime command should read all context files in the new structure.

---

### Step 6: Update CLAUDE.md

"Now let's update your CLAUDE.md — this is the master file Claude reads at the start of every session. I'm going to personalize it to reflect your business."

Read the existing `CLAUDE.md` template file.

Update the following sections while keeping the overall structure intact:

1. **"What This Is"** — Replace the generic description with a one-liner about their specific workspace (e.g., "This is [Name]'s strategic workspace for [Business Name] — an AI agency specializing in...")

2. **"Workspace Structure"** — Update to reflect the actual folder structure, especially if multi-business restructuring was done in Step 5. Add any new folders or files.

3. **"The Claude-User Relationship"** — Keep the general pattern but personalize the user description (e.g., "User: [Name], founder of [Business]. Defines goals around [key areas]...")

4. **"Session Workflow"** — Keep as-is unless the user requested changes

5. **Add a "Context Summary" section** (new, after Workspace Structure):
   ```
   ## Context Summary

   **Business:** [One-line description]
   **Role:** [Their role]
   **Current focus:** [Top 1-2 priorities]
   **Key metric to watch:** [Their north star metric]
   ```

**Do NOT:**
- Remove the Commands section or any existing commands
- Remove the "Critical Instruction: Maintain This File" section
- Remove the Session Workflow section
- Bloat CLAUDE.md with full business detail — that lives in context files. CLAUDE.md is the orientation layer.

[VERIFY] Read back the updated CLAUDE.md and confirm it's clean, personalized, and not bloated.

---

## TEST

### Prime Test

"Let's test your workspace. I'm going to run /prime and see if Claude understands your business."

Run /prime.

After priming, Claude should produce a summary that shows it understands:
- Who the user is
- What their business does
- Current strategic priorities
- Key metrics and state

**If the summary is accurate:** "It works — your AI now knows your business. Every new session starts here."

**If something is wrong:** Fix the relevant context file and re-test.

### Spot Check

Ask the user to test with a real question:

"Try asking me something about your business — a strategy question, an analysis request, anything you'd normally need to explain from scratch."

Demonstrate that Claude can answer intelligently because of the context layer.

"Notice how I didn't need any background? That's ContextOS working. Every session from now on starts this informed."

---

## WHAT'S NEXT

Now that your context layer is built, here are your options:

1. **Install InfraOS** — Set up version control (git), commit workflows, and documentation practices so your workspace stays organized as it grows. Free, 20-30 minutes.

2. **Install DataOS** — Connect your business data sources (Stripe, YouTube, Google Analytics, spreadsheets) so your `current-data.md` refreshes automatically. Free, 30-60 minutes.

3. **Keep refining context** — As you use the workspace, your understanding of what context matters will sharpen. Update your context files anytime. The richer they are, the more useful Claude becomes.

4. **Drop more docs in import/** — Found an old strategy doc? A pitch deck? Drop it in `context/import/` and tell Claude to incorporate the new information.

**The key habit:** After any major business change — new product, new hire, strategy shift, big win — update your context files. Stale context makes Claude stale. Current context makes Claude a strategic partner.

---

> A plug-and-play module from Magic Teams AI — the #1 AI business launch
> & AIOS program. Learn more at [magicteams.ai](https://magicteams.ai)
