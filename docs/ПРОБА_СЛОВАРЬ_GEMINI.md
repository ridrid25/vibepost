# Проба 29.10.2026: промт словами генератора

Заказчица: «по новым правилам, с учётом технических нюансов Gemini, напишешь
новый промпт, и мы сразу поймём, в какой степени это работает». Это проба на
одном ролике. Агенты и счётчик пока не меняются. В задании агенту этот файл
стоит вторым, сразу после docs/ЦЕЛЬ_РОЛИКА.md. Цель ролика важнее этого файла.

## 1. Камера — термины кино, а не метафоры

В поле `c` первым идёт стандартный термин, потом куда.

| Было у нас | Писать |
|---|---|
| hurls itself / plunges at his face | fast dolly-in into extreme close-up of … |
| plunges down the facade | fast vertical tracking shot down the facade |
| rockets back up | rapid crane-up / whip tilt up |
| arcs low round … | low-angle tracking arc shot around … |
| whips round | whip pan 180° snap to … |
| flies through the window | FPV drone shot diving through the window |
| swings overhead | overhead orbit shot |
| falls with him | vertical tracking free-fall shot, face to face |
| follows the coin | fast tracking shot following the coin |

Крупный план — `dolly-in into extreme close-up`, не зум. `crash zoom` — только
один раз как удар на кульминации. `rack focus` — допустим, но крупным планом
не считается.

## 2. Кадр 0

Первый бит, поле `c`: `camera already traveling at high speed from the very
first frame, no static hold, motion blur` + термин + куда. В поле `a` действие
тоже уже идёт (in media res). Что-то проносится у самой линзы в первые 0,3 с.

## 3. Финал (крючок)

Последний бит 9.2–10.0: действие ещё идёт в последнем кадре — падает, катится,
летит; камера ещё движется (`tracking shot still moving at the last frame`).
Без стоп-кадра (`no freeze frame`). Наукообразие вроде «motion vector, zero
motion decay» не писать — генератор этих слов не знает.

## 4. Ведение взгляда

Не «камера ведёт взгляд зрителя», а глаголом слежения: `tracking shot
following the [предмет]`, `camera locks onto the [предмет] as it flies`. В
каждом бите одна вещь в фокусе — та, за которой едет камера.

## 5. Меньше битов

5–7 битов по 1,0–2,0 с вместо 10–12 мелких: генератор плохо держит длинную
цепочку. Первый бит 0,6–0,8 с, последний 0,7–0,8 с.

## 6. Облик героя

`subject` и `second_characters`: 4–5 примет (цвет одежды, фактура: `matte
fabric`, `detailed feather/fur texture`), одинаковые слова везде, где герой
назван. Порядок полей: style, subject, second_characters, props, environment,
lighting, motion_rule, audio, timeline, negative_prompt.

## 7. Стиль и свет

`style`: `high-end cinematic 3D animation, semi-realistic stylized characters,
rich tactile textures, vivid saturated colors, deadpan slapstick`. Физика
гэгов: `cartoon squash and stretch`, `rubbery`. Свет — один источник по
времени суток, без противоречий (не «полдень» и «золотой час» вместе).
В `negative_prompt` добавить `cheap plastic look, freeze frame, static first
frame`.

## 8. Что не меняется

Реплики заказчицы дословно, их столько, сколько в идее. Три крупных плана.
Ролик 10 с, 9:16. Предел 4080 знаков. Счётчик гонять: брак по механике
(размер, темп речи, реплика, `hook`) чинить; брак «нет глагола камеры из
списка» в этой пробе — ожидаемый, его не чинить словами из старого списка.
