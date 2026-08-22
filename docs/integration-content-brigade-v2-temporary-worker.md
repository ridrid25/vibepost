# Integration Content Brigade v2 -> VibePost task queue

Updated: 2026-08-16
Status: rolled back; legacy Claude Code worker restored

## Rollback (2026-08-16)

The temporary prompt-writing switch is disabled. Do not claim VibePost prompt
tasks as `content-brigade-v2-codex`. New `claude_tasks` records belong to the
legacy Claude Code chain (`watch-videos.mjs` -> `dezhurny.mjs` / open Claude
window -> atomic `claim_task` -> Telegram response).

No runtime replacement had been installed, so rollback required no Edge
Function, cron, database-schema, or secret changes. At verification time the
queue was empty; the four latest tasks had been claimed by `claude-window` and
completed without v2 ownership. The Content Brigade v2 implementation remains
available for offline development only and is not a VibePost task worker.

## Goal

Temporarily let Content Brigade v2 handle one prompt-writing task from the
VibePost task queue without deleting or globally replacing the legacy Claude
worker.

## Services

### Source

- Service: Supabase `claude_tasks`
- Interface: internal PostgREST plus `claim_task` RPC
- Auth: `SUPABASE_SERVICE_ROLE_KEY` from the existing local secret store
- Trigger: manual, one task for the first live test

### Learning context

- Service: Supabase Edge Function `content-brigade`
- Auth: `VIBEPOST_BRIGADE_SECRET`
- Input: TikTok API snapshots, Studio metrics when available, Lessons,
  experiments and the current Prompt Framework

### Target

- Service: Telegram through the existing VibePost helper
- Action: send one compact JSON Gemini production prompt, then mark the claimed
  task complete only after successful delivery

## Business Decisions

- Switch scope: one claimed task, not a global cutover
- Duplicate strategy: atomic `claim_task`; the legacy worker cannot claim the
  same task later
- Prompt policy: `INCONCLUSIVE` and `NO STRONG HYPOTHESIS` when sample size or
  retention data is insufficient
- Framework: current `STANDARD` Prompt Framework only
- Rollback: leave the legacy worker installed; on delivery failure mark the
  task failed with a visible reason instead of marking it done

## Field Map

| Target field | Required | Source | Transform | Fallback |
|---|---:|---|---|---|
| objective | yes | task idea + PF-v1 | one viewer response | none |
| hook | yes | task idea | visible action in frame zero | none |
| action_timeline | yes | selected hook | second-by-second, ten seconds | none |
| constraints | yes | PF-v1 | remove contradictions and extra characters | none |
| experiment_variable | yes | live analytics | one variable or `NONE` | `NONE` |
| confidence | yes | sample size and limitations | LOW/MEDIUM/HIGH | LOW |

## Test Results

| Date | Test | Result | Notes |
|---|---|---|---|
| 2026-08-15 | Load live Brigade context | PASS | 19 API videos; Studio retention absent |
| 2026-08-15 | Small-sample protection | PASS | Returned `INCONCLUSIVE`, `UNKNOWN`, LOW confidence |
| 2026-08-15 | Atomic task claim | PASS | Claimed by the temporary v2 worker |
| 2026-08-15 | Prompt JSON validation | PASS | 3709 compact characters; required sections and UTF-8 verified |
| 2026-08-15 | Brigade unit and connector tests | PASS | 30/30 |
| 2026-08-15 | FAST Critic contract | PASS | `APPROVE`; no unsupported hypothesis promoted |
| 2026-08-15 | Telegram prompt delivery | PASS | Summary and one copyable JSON block delivered |
| 2026-08-15 | Claimed task completion | PASS | Marked done only after delivery succeeded |
| 2026-08-15 | Revision video preflight | FAIL | Motion 8.57/3.17; measured trough at 4.0-5.0 seconds |
| 2026-08-15 | Duplicate revision merge | PASS | Automatic and human tasks claimed by v2 and merged into one prompt |
| 2026-08-15 | Revision-2 Critic contract | PASS | Earlier punch block, five visual beats, `APPROVE` |
| 2026-08-15 | Revision-2 Telegram delivery | PASS | 3678-character JSON delivered; both source tasks completed |

## Open Questions

- [x] Do not connect v2 to new `claude_tasks`; the owner rolled the temporary
  test back on 2026-08-16.
- [ ] Add TikTok Studio retention data before making performance claims.

## Launch Notes

- The legacy Claude worker remains installed and unchanged.
- The temporary v2 worker is inactive and must not claim queue tasks.
- The test task was protected from duplicate processing by its processing lease
  and is now complete.
- Logs: Supabase `claude_tasks`, VibePost progress strip, and the local worker
  log.
