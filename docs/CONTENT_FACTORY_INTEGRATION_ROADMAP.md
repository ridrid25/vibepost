# Content Factory integration roadmap

Canonical direction: `content-factory-personal/CROSS_REPO_CONTENT_FACTORY_ROADMAP.md` in the Text Factory repository.

## VibePost role

VibePost owns incoming drafts, platform publishing, TikTok/YouTube publication identities, both existing metric collectors and the existing learning memory: hypotheses, experiments, analysis results, lessons and prompt frameworks. It does not own Text source revisions or Generator media parameters.

## Priorities P1–P9

| Priority | VibePost responsibility |
|---|---|
| P1 Cross-System Creative Identity | Store platform-neutral references from POST-01 `creative_id` to idea/incoming/publication rows; resolve, never copy, existing metrics. |
| P2 TikTok Feedback-to-Idea | POST-04 `PASS/ACCEPTED`: existing lessons feed a deterministic context, one evidence-bound hypothesis and candidate ideas; explicit owner choice gates the existing prompt path. |
| P3 YouTube Own-Content Learning | Feed own `published_shorts` evidence through the existing experiment/verdict/lesson semantics only after P7 defines the YouTube-aware evaluator. |
| P4 TikTok Market Intelligence | Accept separate lawful market-evidence adapters only after research/approval; never mix it with own-account evidence. |
| P5 Parent/Mutation Lineage | Add explicit parent and changed-variable lineage through a separate accepted contract. |
| P6 Owner Preference Memory | Keep owner approvals/rejections/preferences separate from performance evidence. |
| P7 Platform-Aware Evaluation | Cross-cutting prerequisite for P3 verdicts: TikTok and YouTube evaluators return normalized verdict/confidence/provenance; missing metrics remain unavailable. |
| P8 Lesson Freshness | Later weight existing lessons by evidence count, confirmation date, confidence, contradictions and recency. |
| P9 Business Attribution | Later link publications to external business events; Meta/Prodamus/CRM are outside POST-03. |

## POST-04 P2 boundary

The narrow `Feedback Context Builder` reads the existing TikTok lessons, conclusive experiment analyses, current metrics and prompt framework. It produces separate `OWN_PERFORMANCE` and `OWNER_PREFERENCE` sections, one `HYPOTHESIS` with one allowed `changed_variable`, exact constants and bounded provenance. Selected and rejected lesson references follow the candidate idea into the existing owner-selection cards and then into `video_prompt_records`; no candidate starts production automatically.

TikTok sync, verdict/promotion logic, collectors and metric stores remain unchanged. YouTube, market evidence, lesson decay, business attribution and full parent lineage remain future priorities. Generator settings and production behavior remain protected.

## Do not build

- no Creative Memory database;
- no second experiments or lessons store;
- no second analytics/verdict engine;
- no second TikTok collector;
- no second YouTube trend/metrics analyzer;
- no fuzzy title/date publication matching;
- no metric copying into identity rows;
- no changes to Generator prompts/settings or manual Gemini/Flow.

Repository implementation/evidence for POST-04 is coordinated from `POST_04_TIKTOK_FEEDBACK_LOOP.md` in Text Factory.
