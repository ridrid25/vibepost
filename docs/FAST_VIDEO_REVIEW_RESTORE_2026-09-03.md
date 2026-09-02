# VibePost fast video review restore — 2026-09-03

Status: `PASS`. This is a VibePost performance repair, not a new Content
Factory architecture stage.

## Change

- Kept Vertex `gemini-2.5-flash` in `us-central1`.
- Reduced the owner-facing review temperature from `1.0` to `0.5`.
- Reduced the owner-facing schema to `review`, `ok`, `speech`, `tag`, and
  `hooks`; causal instructions and output were removed from this call.
- The Telegram `Разбор ролика` / `Слышно так` message is sent before a second,
  causal-only Gemini call.
- A non-empty `causal_pattern` is checked in a Supabase
  `EdgeRuntime.waitUntil(...)` task. Empty or absent patterns make zero second
  Gemini calls.
- The causal result updates only the row matching both the captured
  `incoming_videos.id` and the captured `video_url`, so a stale rework result
  cannot overwrite a replacement.
- Added bounded telemetry: `FAST_REVIEW_MS`, `TELEGRAM_SEND_MS`,
  `CAUSAL_REVIEW_MS`, and `TOTAL_FUNCTION_MS`. Prompts, media, URLs and tokens
  are not logged.

The Telegram download and Storage upload block is byte-equivalent to v21. The
existing idea lookup, card identity and replacement message remain unchanged.
The live test exposed one pre-existing production mismatch: the generated
`last_activity_at` column rejects manual values. Removing that single invalid
assignment restored the existing-card update; database-managed activity time
continues to advance automatically.

## Rollback identity

- Tag: `video-from-bot-v21-backup-20260903`
- Commit: `011b304953354eb65b0275364b3c4c87719aad6f`
- Git blob: `42dbc505ed1daf125b7e060adeb3185f8d544665`
- Original SHA-256:
  `4568da388105f5d8d11ee613b7b0714166d118ad631841cd823c3739c5514600`
- Manifest:
  `supabase/functions/video-from-bot/video-from-bot.v21.backup.txt`

## Prompt audit

Measured with a real 611-character causal-pattern sample:

| Prompt | Approximate characters | Approximate tokens |
|---|---:|---:|
| v21 combined owner + causal | 1,805 | 452 |
| new owner-facing FAST prompt | 969 | 243 |
| separate causal-only prompt | 986 | 247 |

The owner waits only for the FAST prompt. YouTube target-platform and current
idea context remain because they are used by the owner review; learning-only
and causal-only material is background-only.

## Verification

- Deployed function: `video-from-bot`, version `23`, status `ACTIVE`.
- Deployed bundle SHA-256:
  `b8668580ea71c2cc2f728c9fb95cd2b271af967f3f0c520d489db2438c21eda5`.
- `verify_jwt=false` was preserved.
- Deterministic contract tests: 11 passed, 0 failed.
- Existing YouTube/causal regression tests: 12 passed, 0 failed, 1 external
  API test skipped by design.
- Deno type-check: passed.
- PowerShell live harness parse: passed.
- Secret scan and git diff check: passed.

Final production test used one existing owner-approved video with a non-empty
causal pattern and one existing open card:

| Event | Evidence |
|---|---|
| Function T0 | `2026-09-03 02:15:04.633 MSK` (derived from the owner log timestamp and measured primary latency) |
| Telegram owner review | `2026-09-03 02:15:19.082 MSK` |
| Time to owner review | `14,449 ms` |
| FAST Gemini portion | `12,976 ms` |
| Telegram send portion | `33 ms`, Telegram response OK |
| Causal completion | `2026-09-03 02:15:30.568 MSK` |
| Causal delay after owner review | `11,486 ms` |
| Total through background completion | `25,935 ms` |
| Causal outcome | `UPDATED`, persisted value `YES` |
| Exact incoming row | matched captured ID and replacement `video_url` |
| Open-card count | remained `1` |

The owner review therefore completed before causal work, and the final deployed
version had exactly one production test. The test restored the selected active
idea and the pre-test user-facing card fields. Two unreferenced Storage objects
created by the diagnostic/final test executions were removed through the
Storage API; the original approved media remains referenced and intact.

