# Content Brigade v2

Content Brigade — внутренний learning loop, не отдельный аналитический
дашборд. Пользовательский результат цикла — следующий production prompt, а не
длинный отчёт.

```text
Official TikTok API + manual Studio metrics
→ snapshots
→ comparable cohort analysis
→ one Lesson or INCONCLUSIVE
→ one hypothesis or NO STRONG HYPOTHESIS
→ Hook Lab
→ short script
→ PF-vN production prompt
→ Critic
→ Human approval
→ publication
→ 24h / 7d evaluation
→ Learning Memory
```

## Разделение знаний

- `production_technical_lessons`: правила генерации из `AGENTS.md`/`JOURNAL.md`
  (JSON-таймлайн, речь, свет, физические действия). Они могут улучшать
  техническое исполнение, но не доказывают реакцию TikTok-аудитории.
- `audience_lessons`: только выводы из сопоставимых TikTok experiments.
- Live API counts подключены для 19 роликов. Studio retention пока не введён,
  experiments и Lessons ещё не накоплены, поэтому причина результата остаётся
  `UNKNOWN`, а следующий audience-вердикт — `INCONCLUSIVE`.

## FAST cycle

1. Previous Content Review: одна проблема либо `UNKNOWN`.
2. Одна гипотеза. Если данных недостаточно — `NO STRONG HYPOTHESIS`.
3. Один material experiment variable.
4. До пяти hook, один победитель после Critic.
5. Сценарий без удаляемых секунд.
6. Один production prompt по текущему STANDARD Prompt Framework.
7. Critic: `APPROVE` или точечный `REVISE`.
8. Максимум три существенные итерации после технически пригодного render.

## Prompt Framework

Начальная версия `PF-v1` основана только на технических замерах генерации.
Версии проходят:

```text
EXPERIMENTAL → SUPPORTED → STANDARD → UNDER_REVIEW → REJECTED
```

Новая версия создаётся не после каждого ролика, а после meta-review серии
пригодных experiments. У каждой правки обязательны `old_rule`, `new_rule`,
`evidence`, `expected_effect`, `confidence`.

## Persistent storage

- `studio_metrics` — только ручные значения TikTok Studio;
- `content_hypotheses`, `experiments`, `content_analysis_results`;
- `content_lessons` — Confirmed/Winning/Failed/Hypothesis memory;
- `prompt_framework_versions`, `prompt_framework_rules`;
- `video_prompt_records` — prompt version, structure, patterns и experiment variable.

`content-brigade` Edge Function выдаёт эти данные генератору через отдельный
Vault-secret. `service_role` остаётся внутри Supabase. Текущий framework `PF-v1`
имеет `STANDARD` только как стабильная техническая структура, но `LOW`
confidence и пустое audience evidence; это не TikTok Lesson.

Generator command `npm run brigade -- --cycle` сравнивает зарегистрированный
variant с explicit control на заданном checkpoint, сохраняет новый analysis и
может создать только `HYPOTHESIS` Lesson из одиночного результата. Сейчас
experiments отсутствуют, поэтому live cycle ничего не записал и корректно
вернул `NO STRONG HYPOTHESIS`.

`pg_cron` job `vibepost-content-brigade` запускает тот же server-side cycle в
минуты 2/17/32/47 — через две минуты после TikTok sync. Live pg_net proof:
HTTP 200, `evaluated=0`, `analyses_written=0`, `lessons_written=0`,
`NO STRONG HYPOTHESIS`.

Создание experiment атомарно связывает variant с `videos.experiment_id` и
записывает material annotations control/variant. Вердикт пересчитывает Edge
Function по сохранённым snapshots, Studio source и technical-valid prompt
record; присланные клиентом `PASS`, confidence или evidence игнорируются.
Lesson и его video evidence links также записываются одной транзакционной RPC.

## Stop rules

- Нет достаточных данных: `UNKNOWN`.
- Выборка мала или сравнение несопоставимо: `INCONCLUSIVE`.
- Причина правдоподобна, но не подтверждена: `HYPOTHESIS`.
- Не проверено в отведённом цикле: `NOT VERIFIED`.
- Нет сильной гипотезы: не придумывать эксперимент; применить текущий PF без
  нового audience claim.
