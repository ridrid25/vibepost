# Content Factory integration roadmap

Canonical direction: `content-factory-personal/CROSS_REPO_CONTENT_FACTORY_ROADMAP.md` in the Text Factory repository.

Current operational status: `content-factory-personal/CONTENT_FACTORY_CURRENT_STATE.md`. The POST-specific sections below are historical stage boundaries; phrases such as “future” or “not started” describe that stage's acceptance moment, not today's state.

POST-13C is `TERMINAL FAIL`. POST-13D is `ROLLED_BACK` before Telegram delivery. Neither produced `BOT_START`, `CANARY_LEAD_CREATED` or exact live resolution. The unresolved canary blocker is that the VibePost Vault publisher credential does not correspond to `@ContentFactoryLeads_bot`; this reconciliation does not activate, fix or rotate it. Broad rollout remains not approved.

## VibePost role

VibePost owns incoming drafts and publishing; TikTok/YouTube publication identities and metrics; the existing learning memory; market-reference storage; experiment/lesson extensions; and Telegram attribution plumbing. It does not own Text Factory authoring/source revisions, Meeting/customer PII, or Generator prompts, models, production routes and tuned media parameters.

## Priorities P1–P9

| Priority | VibePost responsibility |
|---|---|
| P1 Cross-System Creative Identity | Store platform-neutral references from POST-01 `creative_id` to idea/incoming/publication rows; resolve, never copy, existing metrics. |
| P2 TikTok Feedback-to-Idea | POST-04 `PASS/ACCEPTED`: existing lessons feed a deterministic context, one evidence-bound hypothesis and candidate ideas; explicit owner choice gates the existing prompt path. |
| P3 YouTube Own-Content Learning | POST-05 `PASS/ACCEPTED`: own `published_shorts_stats` feed the existing experiment/analysis/lesson memory through a narrow YouTube metric adapter and continue into an owner-gated idea/prompt. |
| P4 TikTok Market Intelligence | POST-08 `PASS/ACCEPTED`: accepted structural MARKET evidence now enters the existing owner-gated TikTok idea/prompt path beside separate OWN and OWNER roots; it remains only a hypothesis source and cannot create verdicts or lessons. |
| P5 Parent/Mutation Lineage | POST-09 `PASS/ACCEPTED`: immutable canonical parent/child relations bind exact one-variable platform proofs to existing experiments and expose read-only attribution/lesson traversal. |
| P6 Owner Preference Memory | Keep owner approvals/rejections/preferences separate from performance evidence. |
| P7 Platform-Aware Evaluation | Cross-cutting prerequisite for P3 verdicts: TikTok and YouTube evaluators return normalized verdict/confidence/provenance; missing metrics remain unavailable. |
| P8 Lesson Freshness | POST-10 `PASS/ACCEPTED`: derive versioned effective strength from immutable lesson history, lineage-independent support, recency, context and typed contradictions. |
| P9 Business Attribution | POST-12 implementation v1 is complete locally/test-first. POST-13C is `TERMINAL FAIL`; POST-13D is `ROLLED_BACK` after the exact-bot gate rejected a Vault credential mismatch before delivery. Live attribution proof, payment and revenue remain absent. |

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

## POST-09 P5 lineage boundary

The existing POST-03 `creative_id` is the only creative node identity. One narrow, platform-neutral and immutable `creative_mutations` relation records a canonical parent, one of five bounded mutation kinds, the declared material variable and source hypothesis. Branches and multi-generation traversal are supported; an owner-scoped transaction lock plus ancestor recheck rejects self-links, cross-owner links and cycles. Exact replay is idempotent, while a different declaration for the same child fails closed. Historical creatives are `LEGACY_UNLINKED`; no title/date/prompt inference or bulk backfill exists. Market references, owner preferences, render retries and non-material prompt edits never become parent creatives.

Existing TikTok and YouTube experiments may attach one immutable platform proof to the canonical mutation. The proof contains exact structured parent/child vectors, a computed constants snapshot, deterministic diff and contract hash. Binding requires the existing hypothesis, one changed variable and platform publications to resolve to the same parent/child creative IDs. Read-only attribution reuses the current experiment verdict, comparable checkpoint metrics and lesson stores; missing or malformed provenance remains `UNKNOWN`. No experiment, verdict, lesson, analytics or Creative Memory engine was added, and no live data, publisher or Generator interface changed.

## POST-10 P8 effective-evidence boundary

`LESSON_EFFECTIVE_WEIGHT_V1` is a deterministic compute-on-read policy over the existing lessons, experiments, analyses and POST-09 mutation proofs. It leaves canonical lesson status, verdicts and timestamps immutable, then derives `VERY_HIGH / HIGH / MEDIUM / LOW / WEAK / CONFLICTED / UNKNOWN` from exact mechanism evidence, lineage-independent roots, 30/90/180-day provisional freshness buckets, context match and typed direct/contextual/platform contradictions. TikTok-only evidence never promotes a YouTube lesson, and cross-platform scope requires separately valid proofs on both platforms.

The existing TikTok and YouTube feedback contexts rank current guidance by this effective state and preserve the full state plus policy version/evaluation time in their existing immutable hypothesis snapshot. Stale or conflicted historically strong evidence may yield an owner-gated `CONTROLLED_RETEST`; it never launches an experiment or production. `OWNER_PREFERENCE` does not auto-decay, `MARKET_REFERENCE` is untouched, and no lesson/experiment/Creative Memory store was added. A narrow migration only versions the accepted market-feedback persistence wrapper; its predecessor is no longer callable by the service role, replay compares the complete contract, and derived snapshots use exact fail-closed schemas.

## POST-11 P9 discovery boundary

The accepted identity graph is deterministic through TikTok and YouTube publication but currently has no click, lead, order, payment or revenue edge. Telegram posts have stable `posts.id`/`tg_message_id` and URL buttons, but are not mapped to `creative_id` and do not observe URL-button clicks. YouTube can store URL text in a Short description, but YouTube makes those URLs non-clickable; TikTok has no current per-publication conversion hook in VibePost. No CRM, active payment provider, Meta integration or canonical revenue event exists here.

Business source systems remain authoritative. The production Meeting Assistant owns `Booking.id` lead events, but its cleanup removes `BusinessEvent` rows and some non-confirmed booking statuses after 30 days; Hamon Shop owns customer/order IDs but currently uses test/manual payment and therefore supplies no provider-confirmed revenue. VibePost must not copy their PII or become a payment ledger. The recommended future slice is a narrow owner-scoped opaque token mapping from one Telegram publication to a Meeting `BOT_START`, followed by a source-owned, PII-free durable outcome record linked to `Booking.id` where retained. A publication token may bind to many distinct subject events; it is attribution-only, not authorization. Live CTA activation and Meeting Assistant changes require a separate owner-approved contract. POST-11 creates no schema, webhook, tracking link or production integration.

## POST-12 P9 implementation v1 boundary

VibePost now maps one existing Telegram `posts.id` exactly to the accepted canonical `creative_id` and owns one owner-scoped `cf1` token digest per publication/destination. The raw high-entropy token exists only in the preview deep link and transient request processing; it is not persisted or logged. Issue/replay/revoke, cross-owner checks and contradictory mappings fail closed. No Telegram post button or template is changed until a separate live-activation approval.

Meeting Assistant recognizes only the bounded `cf1_*` namespace alongside its unchanged `calendar_*` route. It records source-owned, append-only, PII-free `BOT_START`, `LEAD_CREATED` and `LEAD_CONFIRMED` evidence and binds a Booking only through the exact pending source set. Multiple conflicting token sources become `AMBIGUOUS`; no timestamp, first-touch or last-touch guess is made. VibePost reads only bounded pseudonymous outcomes and exposes them as a separate `BUSINESS_PERFORMANCE` root; content lessons and verdicts do not change. Payment and revenue remain unimplemented.

## Do not build

- no Creative Memory database;
- no second experiments or lessons store;
- no second analytics/verdict engine;
- no second TikTok collector;
- no second YouTube trend/metrics analyzer;
- no fuzzy title/date publication matching;
- no metric copying into identity rows;
- no changes to Generator prompts/settings or manual Gemini/Flow.

POST-06 source evidence is coordinated from `POST_06_TIKTOK_MARKET_INTELLIGENCE_DISCOVERY.md`; POST-07 ingest evidence is in `POST_07_TIKTOK_MARKET_REFERENCE_V1.md`; POST-08 idea-integration evidence is in `POST_08_TIKTOK_MARKET_TO_IDEA.md`; POST-09 lineage evidence is in `POST_09_CREATIVE_MUTATION_LINEAGE.md`; POST-10 effective-evidence policy is in `POST_10_LESSON_FRESHNESS_DECAY.md`; POST-11 business-attribution discovery is in `POST_11_BUSINESS_ATTRIBUTION_DISCOVERY.md`; POST-12 Telegram lead-attribution evidence is in `POST_12_TELEGRAM_LEAD_ATTRIBUTION_V1.md` in Text Factory.
