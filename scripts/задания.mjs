/**
 * Задания, оставленные Татьяной через бота.
 *
 * Отдельный скрипт, чтобы дежурному Claude не нужно было знать ни адреса базы,
 * ни ключей: он вызывает три понятные команды, а секреты остаются здесь.
 *
 *   node scripts/задания.mjs список          — что ждёт (задания и доделки)
 *   node scripts/задания.mjs готово <id>     — задание выполнено
 *   node scripts/задания.mjs доделано <id>   — ролик переделан, вернуть во «Входящие»
 *   node scripts/задания.mjs сказать "текст" — написать Татьяне в бота
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function бот(текст, разметка) {
  const [p] = await (await fetch(
    `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null` +
    `&select=error_notify_tg_id,error_notify_bot_id&limit=1`, { headers: h })).json();
  const [b] = await (await fetch(
    `${url}/rest/v1/bots?id=eq.${p.error_notify_bot_id}&select=token_secret_id`, { headers: h })).json();
  const token = await (await fetch(`${url}/rest/v1/rpc/get_bot_token`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_secret_id: b.token_secret_id }),
  })).json();
  const r = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: p.error_notify_tg_id, text: текст,
      ...(разметка ? { parse_mode: разметка } : {}),
    }),
  })).json();
  if (!r.ok) throw new Error(r.description);
}

const [команда, ...аргументы] = process.argv.slice(2);

/**
 * Время по-московски — то же, что видит Татьяна в Telegram.
 *
 * В базе всё лежит в UTC. Claude читал его как есть и называл ей время на три
 * часа раньше настоящего: «задание пришло в 13:25», когда на её экране 16:25.
 * Спорить о времени, которого нет у неё на экране, — пустая трата её сил.
 */
function мск(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const п = (n) => String(n).padStart(2, '0');
  return `${п(d.getUTCDate())}.${п(d.getUTCMonth() + 1)} ${п(d.getUTCHours())}:${п(d.getUTCMinutes())}`;
}

if (команда === 'список') {
  const t = await (await fetch(
    `${url}/rest/v1/claude_tasks?status=in.(new,processing)` +
    `&select=id,text,created_at,video_id,idea_id,` +
    `incoming_videos(name,measure_avg,measure_worst,video_url,target_platform,causal_pattern),` +
    `video_ideas(slug,target_platform,reference_source_id,causal_pattern,payoff_class,fidelity_constraints)` +
    `&order=created_at`, { headers: h })).json();
  // Ролики, возвращённые кнопкой «↩︎ На доделку», — такое же задание, только
  // пришло из приложения, а не из бота. Разбираются в том же проходе.
  const все = await (await fetch(
    `${url}/rest/v1/incoming_videos?status=eq.rework` +
    `&select=id,name,rework_note,rework_at,rework_ack_at,polished_at&order=rework_at`,
    { headers: h })).json();
  // Разобранная доделка уходит из списка по одному признаку: на неё ответили
  // (rework_ack_at свежее rework_at). Раньше требовались ещё и титры — но по
  // доделке «переделай промт» титров не будет никогда: Татьяна снимет НОВЫЙ
  // ролик. Замечание про лобстера так и висело бы вечно, топя под собой всё
  // свежее. Пометку во «Входящих» при этом не трогаем: снять её может только она.
  const r = все.filter((v) => !(
    v.rework_ack_at && new Date(v.rework_ack_at) > new Date(v.rework_at)
  ));

  if (!t.length && !r.length) {
    console.log('НЕТ ЗАДАНИЙ');
  } else {
    for (const z of t) {
      console.log(['ЗАДАНИЕ', z.id, `${мск(z.created_at)} МСК`, z.text].join('	'));
      // Задание почти всегда про ролик, присланный минуту назад. Без этой
      // строчки «Переделываем» читается как задание ни о чём — так и вышло
      // 4 августа со скатом.
      const в = z.incoming_videos;
      if (в) {
        console.log(['        ↳ ролик', z.video_id, в.name,
          `замер ${в.measure_avg ?? '—'}/${в.measure_worst ?? '—'}`, в.video_url].join('	'));
        if (в.target_platform === 'youtube_shorts' && в.causal_pattern) {
          console.log(`        ↳ TRUSTED youtube_shorts causal_pattern=${JSON.stringify(в.causal_pattern)}`);
        }
      }
    }
    for (const v of r) {
      console.log(['ДОДЕЛКА', v.id, `${мск(v.rework_at)} МСК`, v.name,
        v.rework_note ?? 'без пояснения'].join('	'));
    }
  }
} else if (команда === 'взять') {
  // Атомарный захват. Раньше дежурные просто читали список, и когда их
  // оказывалось двое — планировщик поднял одного, приёмник другого, — они
  // брали одно и то же задание и писали два промта на один ролик.
  const r = await fetch(`${url}/rest/v1/rpc/claim_task`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ p_worker: аргументы[0] || 'дежурный' }),
  });
  const задача = r.ok ? await r.json() : null;
  if (!задача?.id) {
    console.log('НЕТ СВОБОДНЫХ ЗАДАНИЙ');
  } else {
    console.log(`${задача.id}\t${задача.text}`);
  }

} else if (команда === 'сбой') {
  // Упавшую задачу нельзя закрывать как выполненную: 9 августа промты писались,
  // падали на отправке и всё равно уходили в «done» — работа пропадала молча.
  const [id, ...причина] = аргументы;
  if (!id) throw new Error('нужен id задания');
  await fetch(`${url}/rest/v1/claude_tasks?id=eq.${id}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({
      status: 'failed', done_at: new Date().toISOString(),
      error: причина.join(' ').slice(0, 500) || 'без пояснения',
    }),
  });
  console.log('помечено сбоем — сторож увидит');

} else if (команда === 'готово') {
  const id = аргументы[0];
  if (!id) throw new Error('нужен id задания');
  await fetch(`${url}/rest/v1/claude_tasks?id=eq.${id}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ status: 'done', done_at: new Date().toISOString() }),
  });
  console.log('отмечено выполненным');
} else if (команда === 'доделано') {
  const id = аргументы[0];
  if (!id) throw new Error('нужен id ролика');
  await fetch(`${url}/rest/v1/incoming_videos?id=eq.${id}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ status: 'new', rework_note: null, rework_at: null }),
  });
  console.log('ролик возвращён во «Входящие»');
} else if (команда === 'ролик') {
  // Готовый файл обратно в бота. Починенный звук, титры, любой результат —
  // Татьяна работает с телефона, и присылать ей путь к файлу на компьютере
  // бессмысленно: открыть его она сможет только сев за компьютер.
  const { readFileSync: читать, statSync } = await import('node:fs');
  const { basename } = await import('node:path');
  const [файл, ...остальное] = аргументы;
  if (!файл) throw new Error('нужен путь к ролику');
  // Если среди аргументов есть id ролика — под видео появятся те же кнопки,
  // что и под карточкой замера. Без них Татьяне некуда нажать: присланный
  // мной готовый файл оказывался тупиком, и ей приходилось искать старую
  // карточку выше по переписке.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idРолика = остальное.find((a) => uuid.test(a)) ?? null;
  const подпись = остальное.filter((a) => a !== idРолика);
  const размер = statSync(файл).size;
  if (размер > 50 * 1024 * 1024) {
    throw new Error(`ролик ${(размер / 1048576).toFixed(1)} МБ — бот отдаёт до 50 МБ`);
  }

  const [p] = await (await fetch(
    `${url}/rest/v1/profiles?error_notify_tg_id=not.is.null` +
    `&select=error_notify_tg_id,error_notify_bot_id&limit=1`, { headers: h })).json();
  const [b] = await (await fetch(
    `${url}/rest/v1/bots?id=eq.${p.error_notify_bot_id}&select=token_secret_id`, { headers: h })).json();
  const token = await (await fetch(`${url}/rest/v1/rpc/get_bot_token`, {
    method: 'POST', headers: h, body: JSON.stringify({ p_secret_id: b.token_secret_id }),
  })).json();

  const форма = new FormData();
  форма.append('chat_id', String(p.error_notify_tg_id));
  форма.append('caption', подпись.join(' ').trim().slice(0, 1024));
  форма.append('supports_streaming', 'true');
  if (idРолика) {
    форма.append('reply_markup', JSON.stringify({
      inline_keyboard: [
        [{ text: '✅ Годится', callback_data: `vid:ok:${idРолика}` }],
        [{ text: '🔊 Поправь звук', callback_data: `vid:snd:${idРолика}` }],
        [{ text: '✏️ Не годится', callback_data: `vid:no:${idРолика}` }],
      ],
    }));
  }
  форма.append('video', new Blob([читать(файл)], { type: 'video/mp4' }), basename(файл));

  const r = await (await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST', body: форма,
  })).json();
  if (!r.ok) throw new Error(r.description);
  console.log(`ролик отправлен, ${(размер / 1048576).toFixed(1)} МБ`);

} else if (команда === 'сказать') {
  const текст = аргументы.join(' ').trim();
  if (!текст) throw new Error('нечего говорить');
  await бот(текст);
  console.log('отправлено в бота');
} else if (команда === 'блок') {
  // Любой текст одним блоком с кнопкой копирования: промпты для Lovable,
  // куски конфигов. Отличается от «промпт» тем, что не разбирает JSON.
  const { readFileSync } = await import('node:fs');
  const [файл, ...подпись] = аргументы;
  if (!файл) throw new Error('нужен путь к файлу');
  const экран = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const шапка = подпись.join(' ').trim() || 'Вставить одним куском:';
  const сообщение = `${экран(шапка)}\n\n<pre>${экран(readFileSync(файл, 'utf8').trim())}</pre>`;
  if (сообщение.length > 4096) {
    throw new Error(`сообщение ${сообщение.length} знаков — предел 4096`);
  }
  await бот(сообщение, 'HTML');
  console.log(`отправлено, ${сообщение.length} знаков`);
} else if (команда === 'промпт') {
  // Промпт уходит одним блоком <pre> — по нему в Telegram есть кнопка
  // «копировать», и Татьяна вставляет его в Gemini одним касанием.
  // Лимит сообщения — 4096 знаков, поэтому JSON шлём без отступов.
  const { readFileSync } = await import('node:fs');
  const taskFlag = аргументы.indexOf('--task');
  const taskId = taskFlag >= 0 ? аргументы[taskFlag + 1] : null;
  if (taskFlag >= 0 && !/^[0-9a-f-]{36}$/i.test(taskId ?? '')) {
    throw new Error('после --task нужен UUID задания');
  }
  const чистые = taskFlag >= 0
    ? аргументы.filter((_, index) => index !== taskFlag && index !== taskFlag + 1)
    : аргументы;
  const [файл, ...подпись] = чистые;
  if (!файл) throw new Error('нужен путь к json-промпту');
  // 25.10.2026, заказчица: «Как я могу тебе доверять, что все правила у всех в
  // бригаде критик и ты проверяете?» Слова «проверено» больше не принимаются:
  // промт не уйдёт, пока рядом нет письменного вердикта критика «годен» с
  // таблицей по принципам, без строк БРАК, и с ответом, зачем смотреть второй раз.
  {
    const { existsSync } = await import('node:fs');
    const вердиктФайл = файл.replace(/\.json$/i, '.critic.md');
    if (!existsSync(вердиктФайл)) {
      throw new Error(`нет вердикта критика ${вердиктФайл} — промт не отправлен`);
    }
    const в = readFileSync(вердиктФайл, 'utf8');
    if (!/ВЕРДИКТ:\s*годен/i.test(в)) throw new Error('критик не дал «ВЕРДИКТ: годен» — промт не отправлен');
    if (/\|\s*БРАК\s*\|/.test(в)) throw new Error('в таблице критика есть БРАК — промт не отправлен');
    if ((в.match(/^\|\s*\d/gm) ?? []).length < 20) throw new Error('в таблице критика меньше 20 пунктов принципов — промт не отправлен');
    if (!/ПЕРЕСМОТР|второй раз/i.test(в)) throw new Error('критик не ответил, зачем смотреть второй раз — промт не отправлен');
  }
  const компакт = JSON.stringify(JSON.parse(readFileSync(файл, 'utf8')));
  const экран = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const шапка = подпись.join(' ').trim() || 'Промпт. Новый чат в Gemini, вставить одним куском:';
  // Шапка уходит отдельным сообщением, а не над блоком. Предел Telegram —
  // 4096 знаков на сообщение, и каждый знак шапки раньше отнимался у промпта.
  // 8 августа промт не влез из-за одиннадцати знаков тегов <pre>. Теперь всё
  // окно принадлежит блоку, а промт остаётся копируемым одним касанием.
  // Считаем сам промт, а не промт с тегами: Telegram меряет видимый текст,
  // разметка <pre> в 4096 не входит. Проверено живой отправкой: 4096 проходит,
  // 4097 отклоняется.
  if (компакт.length > 4096) {
    throw new Error(`промпт ${компакт.length} знаков — предел 4096, сокращать.`);
  }
  const блок = `<pre>${экран(компакт)}</pre>`;
  if (taskId) {
    const taskResponse = await fetch(
      `${url}/rest/v1/claude_tasks?id=eq.${taskId}` +
      `&select=idea_id,video_ideas(target_platform)&limit=1`,
      { headers: h },
    );
    if (!taskResponse.ok) throw new Error('не удалось найти idea_id задания');
    const [task] = await taskResponse.json();
    if (task?.idea_id) {
      const targetPlatform = task.video_ideas?.target_platform ?? 'tiktok';
      if (!['tiktok', 'youtube_shorts'].includes(targetPlatform)) {
        throw new Error('неподдерживаемая площадка prompt provenance');
      }
      // POST-05 extends the accepted POST-04 RPC in place. YouTube now gets
      // the same owner-gated, hash-checked, idempotent provenance boundary;
      // direct PATCH can no longer bypass the creative/evidence chain.
      const saveResponse = await fetch(`${url}/rest/v1/rpc/persist_tiktok_prompt_provenance_v2`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          p_mode: 'CLAUDE_TASK',
          p_video_idea_id: task.idea_id,
          p_claude_task_id: taskId,
          p_prompt: компакт,
          p_prompt_hash: createHash('sha256').update(компакт, 'utf8').digest('hex'),
        }),
      });
      if (!saveResponse.ok) throw new Error('prompt provenance не сохранился; отправка заблокирована');
    }
  }
  // A selected-task prompt is delivered only after its canonical provenance
  // has committed. Standalone operator blocks (without --task) keep the old flow.
  await бот(экран(шапка), 'HTML');
  await бот(блок, 'HTML');
  console.log(`отправлено, ${компакт.length} знаков`);
} else {
  console.log('команды: список | взять [кто] | ролик <файл> [id-ролика] \"подпись\" | готово <id> | сбой <id> "причина" | доделано <id> | сказать "текст" | промпт <файл.json> [--task <id>] [подпись]');
}
