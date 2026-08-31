# Content Factory integration roadmap

Canonical direction: `content-factory-personal/CROSS_REPO_CONTENT_FACTORY_ROADMAP.md` in the Text Factory repository.

## VibePost role

VibePost owns incoming drafts, platform publishing, TikTok/YouTube publication identities, both existing metric collectors and the existing learning memory: hypotheses, experiments, analysis results, lessons and prompt frameworks. It does not own Text source revisions or Generator media parameters.

## Priorities P1–P9

| Priority | VibePost responsibility |
|---|---|
| P1 Cross-System Creative Identity | Store platform-neutral references from POST-01 `creative_id` to idea/incoming/publication rows; resolve, never copy, existing metrics. |
| P2 TikTok Feedback-to-Idea | POST-04 `PASS/ACCEPTED`: existing lessons feed a deterministic context, one evidence-bound hypothesis and candidate ideas; explicit owner choice gates the existing prompt path. |
| P3 YouTube Own-Content Learning | POST-05 `PASS/ACCEPTED`: own `published_shorts_stats` feed the existing experiment/analysis/lesson memory through a narrow YouTube metric adapter and continue into an owner-gated idea/prompt. |
| P4 TikTok Market Intelligence | POST-08 `PASS/ACCEPTED`: accepted structural MARKET evidence now enters the existing owner-gated TikTok idea/prompt path beside separate OWN and OWNER roots; it remains only a hypothesis source and cannot create verdicts or lessons. |
| P5 Parent/Mutation Lineage | Add explicit parent and changed-variable lineage through a separate accepted contract. |
| P6 Owner Preference Memory | Keep owner approvals/rejections/preferences separate from performance evidence. |
| P7 Platform-Aware Evaluation | Cross-cutting prerequisite for P3 verdicts: TikTok and YouTube evaluators return normalized verdict/confidence/provenance; missing metrics remain unavailable. |
| P8 Lesson Freshness | Later weight existing lessons by evidence count, confirmation date, confidence, contradictions and recency. |
| P9 Business Attribution | Later link publications to external business events; Meta/Prodamus/CRM are outside POST-03. |

## POST-04 P2 boundary

The narrow `Feedback Context Builder` reads the existing TikTok lessons, conclusive experiment analyses, current metrics and prompt framework. It produces separate `OWN_PERFORMANCE` and `OWNER_PREFERENCE` sections, one `HYPOTHESIS` with one allowed `changed_variable`, exact constants and bounded provenance. Selected and rejected lesson references follow the candidate idea into the existing owner-selection cards and then into `video_prompt_records`; no candidate starts production automatically.

TikTok sync, verdict/promotion logic, collectors and metric stores remain unchanged. YouTube, market evidence, lesson decay, business attribution and full parent lineage remain future priorities. Generator settings and production behavior remain protected.

## POST-05 P3 boundary

The existing learning tables now accept an additive YouTube publication subject without fake TikTok rows. `published_shorts_stats` remains the sole owner-metrics snapshot store; the adapter preserves absent supported metrics as `UNKNOWN`, marks unavailable metrics `UNSUPPORTED`, selects deterministic checkpoints without interpolation and returns the shared `PASS / FAIL / INCONCLUSIVE` verdict semantics. A conclusive result writes the existing `content_analysis_results` and `content_lessons`; one experiment remains only `HYPOTHESIS/LOW` under the unchanged promotion rules.

The next YouTube feedback context keeps `MARKET_REFERENCE` (Reference DNA), `OWN_PERFORMANCE` (own publications, experiments and lessons) and `OWNER_PREFERENCE` as distinct provenance roots. Exact market-vs-own pattern conflicts are retained and lower confidence. Candidate cards still require the owner's explicit choice, and the selected prompt is committed through the existing provenance RPC before delivery or any paid start. Generator, OAuth/upload/scheduling/retry and live collectors are unchanged. P4 is not started.

## POST-06 P4 discovery boundary

No broad public-organic TikTok API is available to the current commercial personal use case: Display API is consented-user/OWN only, Research API is non-commercial/qualified-researcher only, and Commercial Content API is an approved-access EU ads/commercial subset. The selected source direction is therefore hybrid and semi-manual: discover candidates in official Creative Center/TikTok One or accept deliberate owner URLs, then validate only the submitted URL through TikTok's official oEmbed contract. Public-page scraping, browser collection, feed crawling and media downloading are prohibited.

Future storage should be two narrow platform-neutral entities inside the existing VibePost DB: market-reference identity/workflow plus append-only typed FACT/DNA evidence. A selected reference enters the existing POST-04 Feedback Context Builder only through a separate `MARKET_REFERENCE` root. It cannot create an experiment verdict, lesson or confirmed own-account pattern. Owner dispositions remain `OWNER_PREFERENCE`; no production migration or code was created in POST-06.

## POST-07 P4 implementation v1 boundary

VibePost now owns two narrow additive entities: owner-scoped `market_references` and append-only `market_reference_evidence`. The only resolver is one bounded official TikTok oEmbed request for each deliberate, strictly validated URL. It persists normalized identity facts with explicit `OBSERVED / UNKNOWN / UNSUPPORTED`; provider HTML, thumbnails and media never persist. Owner dispositions remain `OWNER_PREFERENCE`. Only `TAKE` or `INTERESTING_MECHANIC` references may receive bounded `HUMAN_REVIEW` DNA, and only an immutable `ACCEPTED` DNA version enters preview.

The preview wraps the accepted POST-04 builder without changing it and exposes independent `OWN_PERFORMANCE`, `OWNER_PREFERENCE` and `MARKET_REFERENCE` roots for exactly one selected reference. It creates no hypothesis, idea, prompt, experiment result or lesson and cannot start production/publishing. There is no crawling, scraping, media download, live collector change or Generator interface change.

## POST-08 P4 idea-integration boundary

The existing POST-04 Feedback Context Builder remains authoritative for `OWN_PERFORMANCE` and `OWNER_PREFERENCE`; POST-08 adds the accepted POST-07 evidence as a third, structurally separate `MARKET_REFERENCE` root. Only `TAKE` or `INTERESTING_MECHANIC` references with accepted human DNA are eligible. `SKIP` is excluded, while `NOT_MY_STYLE` is an owner avoidance constraint rather than a performance result. OWN confirmed/supported evidence outranks a market signal, and market-vs-own or owner-vs-market conflicts are persisted explicitly instead of silently resolved.

Market mechanics are reduced to an abstract, anti-copy context. Source URLs, creator identity, captions, scripts and source identifiers cannot reach the idea model or production prompt. A market-only proposal remains a LOW-confidence `HYPOTHESIS`, changes one material variable, preserves constants and requires explicit owner selection. Candidate and prompt records retain internal evidence IDs and conflict provenance; the existing Generator interface, tuned settings, collectors, verdict/lesson logic and publishing gate remain unchanged. Market evidence cannot create a verdict or lesson, and no candidate starts production automatically.

## Do not build

- no Creative Memory database;
- no second experiments or lessons store;
- no second analytics/verdict engine;
- no second TikTok collector;
- no second YouTube trend/metrics analyzer;
- no fuzzy title/date publication matching;
- no metric copying into identity rows;
- no changes to Generator prompts/settings or manual Gemini/Flow.

POST-06 source evidence is coordinated from `POST_06_TIKTOK_MARKET_INTELLIGENCE_DISCOVERY.md`; POST-07 ingest evidence is in `POST_07_TIKTOK_MARKET_REFERENCE_V1.md`; POST-08 idea-integration evidence is in `POST_08_TIKTOK_MARKET_TO_IDEA.md` in Text Factory.
