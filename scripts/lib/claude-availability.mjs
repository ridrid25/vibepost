/** Разбирает только те остановки Claude CLI, после которых повторный запуск бессмысленен. */

function следующийСброс(текст, сейчас) {
  const двенадцать = текст.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const двадцатьЧетыре = текст.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  let час;
  let минута;
  if (двенадцать) {
    час = Number(двенадцать[1]) % 12;
    if (двенадцать[3].toLowerCase() === 'pm') час += 12;
    минута = Number(двенадцать[2] ?? 0);
  } else if (двадцатьЧетыре) {
    час = Number(двадцатьЧетыре[1]);
    минута = Number(двадцатьЧетыре[2]);
  } else {
    return null;
  }

  const сброс = new Date(сейчас);
  сброс.setHours(час, минута, 0, 0);
  if (сброс.getTime() <= сейчас.getTime()) сброс.setDate(сброс.getDate() + 1);
  return сброс;
}

export function причинаОстановкиClaude(журнал, сейчас = new Date()) {
  const строки = String(журнал).split(/\r?\n/).filter(Boolean);
  const лимитСтрока = [...строки].reverse().find((строка) =>
    /You've hit your .*limit.*resets/i.test(строка));
  if (лимитСтрока) {
    const сбросТекст = лимитСтрока.match(/resets\s+(.+)$/i)?.[1]?.trim() ?? 'позже';
    const сброс = следующийСброс(сбросТекст, сейчас);
    const часы = сброс
      ? сброс.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : сбросТекст;
    return {
      reason: 'limit',
      detail: `лимит Claude; сброс ${сбросТекст}`,
      progress: `ждёт Claude до ${часы}`,
      until: сброс?.toISOString() ?? new Date(сейчас.getTime() + 60 * 60 * 1000).toISOString(),
      message: `Claude достиг лимита. Задание сохранено и продолжится после ${часы}; ` +
        'повторно запускать его до этого времени не буду.',
    };
  }

  if (/Request not allowed/i.test(журнал)) {
    return {
      reason: 'vpn',
      detail: 'связь с Anthropic закрыта, нужен v2rayN с TUN',
      progress: 'ждёт Claude: нет связи',
      until: null,
      message: 'Не могу работать: связь с Anthropic закрыта. Поднимите v2rayN и включите TUN — ' +
        'без него мои запросы отбиваются, и промт написать нечем.',
    };
  }

  if (/Failed to authenticate|OAuth session expired/i.test(журнал)) {
    return {
      reason: 'auth',
      detail: 'истёк вход в Claude, нужен файл «Войти в Claude» на рабочем столе',
      progress: 'ждёт входа в Claude',
      until: null,
      message: 'Не могу работать: истёк вход в Claude на компьютере. Откройте окно Claude ' +
        'и войдите заново — задания копятся, но взять их некому.',
    };
  }

  return null;
}
