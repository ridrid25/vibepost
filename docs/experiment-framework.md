# Experiment Framework

## Сравнение

Каждый ролик сравнивается на одинаковом checkpoint (`1h`, `6h`, `24h`, `72h`,
`7d`) в таком порядке:

1. control текущего experiment;
2. та же тема и формат;
3. та же тема;
4. тот же формат;
5. медиана аккаунта.

Rolling cohort по умолчанию: последние 30 сопоставимых публикаций не старше
90 дней. Медиана считается по значениям роликов, а не по сумме числителей и
знаменателей.

Для control и variant выбирается snapshot, ближайший к одному и тому же
`age_hours` checkpoint. Допуски: ±0,5h для 1h/6h, ±1h для 24h, ±3h для 72h и
±12h для 7d. Если хотя бы у одного ролика такой snapshot отсутствует, результат
`INCONCLUSIVE`; последние текущие counters вместо checkpoint не подставляются.

## Формулы

```text
like_rate       = likes / views
comment_rate    = comments / views
share_rate      = shares / views
save_rate       = saves / views
engagement_public   = (likes + comments + shares) / views
engagement_extended = (likes + comments + shares + saves) / views
average_watch_ratio = average_watch_time_seconds / duration_seconds
completion          = full_watch_percent / 100
views_velocity      = delta views / delta hours
relative_to_median  = metric / cohort median
```

Public и extended engagement — разные метрики. Average watch ratio может быть
выше 1 из-за повторных просмотров. Уменьшение cumulative counter —
`DATA_ANOMALY`, а не отрицательная эффективность.

## Стартовые data gates

Пороговые значения конфигурируемы; консервативный старт:

```text
min_views_for_rate_decision = 400
min_cohort_videos = 10
descriptive_cohort_min = 5
required_material_changes = exactly 1
```

Результат `INCONCLUSIVE`, если отсутствуют заранее заданные primary metric,
direction, checkpoint или MDE; checkpoint ещё не достигнут; выборка меньше
порогов; нет control; sources несовместимы; изменено больше одного material
parameter; render технически не реализовал prompt; были paid promotion,
private/delete/sync failure; confidence interval пересекает MDE.

## Вердикт

Для долей использовать Wilson/Newcombe 95% CI:

CI вычисляется внутри analytics core только из `successes/trials` варианта и
control; переданный извне готовый CI игнорируется. Raw effect всегда имеет знак
`variant - control`, а для гипотезы `decrease` core сам инвертирует его в
beneficial effect. И variant, и explicit control должны пройти минимальный
порог views. Требование 10 роликов относится к cohort/median, а не к явно
указанному одиночному control.

```text
PASS          lower_bound(effect_ci) >= MDE
FAIL          upper_bound(effect_ci) < MDE
INCONCLUSIVE  иначе
```

PASS означает выполнение заранее заданного критерия, а не доказанную
причинность. Один control против одного treatment даёт максимум LOW confidence.

## Promotion

```text
HYPOTHESIS → SUPPORTED: 2 независимых PASS, нет пригодного FAIL
SUPPORTED → CONFIRMED: ≥3 независимых PASS, pooled CI проходит MDE
HYPOTHESIS/SUPPORTED → REJECTED: ≥2 пригодных FAIL и pooled upper < MDE
```

Каждое evidence хранит experiment, video IDs, checkpoint, effect, два sample
sizes (`audience_sample_size`, `reference_video_count`), sources и limitations.
