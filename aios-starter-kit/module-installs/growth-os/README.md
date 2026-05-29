# Growth OS

A **module** — a bundle of model-invoked skills for getting customers. It's a Claude Code plugin: when enabled, AIOS loads it with `--plugin-dir`, and Claude reaches for the right skill based on what you ask. No slash commands to memorize.

## Skills

| Skill | Fires when you ask for… |
|---|---|
| **cold-outreach** | a cold email or DM to a prospect/investor/partner ("reach out to X", "draft a cold email") |
| **content-calendar** | a content plan / posting schedule ("what should I post", "plan my week") |
| **lead-magnet** | a freebie/opt-in to grow your list ("make a lead magnet", "a checklist to capture leads") |

## How it works

This folder is a plugin (`.claude-plugin/plugin.json` + `skills/`). AIOS passes `--plugin-dir` for it on every chat spawn while the module is enabled, so the skills auto-invoke by intent. Disabling the module just stops passing the flag — instantly reversible, no file changes.

This is the template for all AIOS modules going forward: a module is a bundle of skills (a mini-OS for a domain). See `plans/2026-05-29-modules-as-plugins.md` in the workspace.
