/**
 * Речевой бит: говорящий двигается всем телом (заказчица 13.11.2026).
 *
 * Ревизия 04–13.11: первые дубли лягушки и обезьяны ломались в одном месте —
 * герой останавливался и говорил, камера стояла. Лягушка лежала на спине,
 * потом стояла и смотрела на монету; обезьяна лежала под коробкой, потом
 * сидела на ступени неподвижного эскалатора. Счётчик и критик такие биты
 * пропускали, а Gemini рисовал их стоп-кадром: худшая секунда 3,6–7,7.
 *
 * Проверка: в поле `a` каждого бита с репликой есть глагол перемещения всем
 * телом (бежит, прыгает, кувыркается, катится, плывёт, падает, карабкается…).
 * Поза покоя (лежит, сидит, стоит, смотрит, ждёт) без такого глагола — брак.
 * Езда на чём-то (rides, carried) телом не считается: эскалатор у обезьяны
 * «вёз» её, а кадр стоял.
 */

// Основы глаголов перемещения всем телом. Окончания -s/-es/-ed/-ing ловит регулярка.
const ДВИЖЕНИЕ = [
  'run', 'runn', 'ran', 'leap', 'leapt', 'jump', 'hop', 'hopp', 'bounc', 'bound',
  'swing', 'swung', 'flip', 'flipp', 'tumbl', 'roll', 'somersault', 'cartwheel', 'spin', 'spinn', 'twirl', 'twist',
  'slid', 'slide', 'skid', 'skidd', 'dive', 'div', 'dove', 'fall', 'fell', 'plung', 'drop', 'dropp', 'climb', 'scrambl',
  'clamber', 'swim', 'swimm', 'swam', 'paddl', 'wad', 'splash', 'lung', 'dash', 'sprint', 'charg', 'crawl', 'scurr',
  'scamper', 'vault', 'ski', 'surf', 'skat', 'flail', 'thrash', 'wriggl', 'squirm', 'writh',
  'kick', 'stomp', 'stamp', 'pounc', 'spring', 'sprang', 'launch', 'hurl', 'fling', 'flung', 'toss', 'yank', 'haul',
  'drag', 'dragg', 'pull', 'heav', 'shov', 'push', 'wrestl', 'grappl', 'tug', 'tugg', 'lurch',
  'stagger', 'stumbl', 'trip', 'tripp', 'flop', 'flopp', 'sway', 'shak', 'shook', 'shimm',
  'hang', 'hung', 'dangl', 'rebound', 'ricochet', 'rac', 'chas', 'flee', 'fled', 'dodg', 'duck',
  'weav', 'zigzag', 'scoot', 'waddl', 'strut', 'march', 'strid', 'stride', 'stepp', 'whirl', 'pivot',
  'grab', 'grabb', 'snatch', 'scoop', 'dig', 'digg', 'shovel', 'rummag',
  'jab', 'jabb', 'punch', 'slap', 'slapp', 'smash', 'swat', 'swip', 'fly', 'fli', 'flew',
  'glid', 'soar', 'sink', 'sank', 'sunk', 'surfac', 'emerg', 'burst', 'crash', 'slam', 'slamm',
  'tow', 'towed', 'whip', 'whipp', 'zoom', 'careen', 'hurtl', 'barrel', 'bolt', 'scrabbl', 'spiral',
];
// Поза покоя: в речевом бите это стоп-кадр, даже если до неё было движение.
// 08.11 обезьяна «flops onto his back» и лягушка «lands on his back» — глагол
// движения в бите был, но говорили они уже лёжа, и кадр стоял секунду.
// «still talking» значит «продолжая говорить», это не поза — его не ловим.
// Голое «on his back» и «flat on» не ловим: «тень на спине», «монета шлёпается
// плашмя на лоб» — это не поза героя. Ловим «упал/лёг/плюхнулся на спину».
const ПОКОЙ = /\b(lies|lying|lie (on|in|down|flat)|laid out|(lands?|landed|landing|flops?|flopped|falls?|fell|drops?|dropped|rolls?|rolled|sprawls?|sprawled) (on|onto) (his|her|its) back|belly-down|sits?|sitting|seated|squats?|squatting|crouch(es|ing)?|kneels?|kneeling|stands?( still| there| up straight)?|standing|stays? put|waits?|waiting|watch(es|ing)|stares?|staring|gazes?|gazing|looks? (at|on|down at|up at)|motionless|frozen|freezes?|(stands|sits|holds|keeps|lies) still|rests?|resting|reclin(es|ing)|lounges?|lounging|perch(es|ed)|parked|idles?|poses?|posing)\b/i;

const ГЛАГОЛ_ДВИЖЕНИЯ = new RegExp(`\\b(${ДВИЖЕНИЕ.join('|')})(s|es|ed|ing|ies|ied|e|ers?)?\\b`, 'i');

/** Беды по речевым битам: [{ t, why }]. Пустой список — все говорящие двигаются. */
export function speechBeatBodyIssues(prompt) {
  const beats = Array.isArray(prompt?.timeline) ? prompt.timeline : [];
  const issues = [];
  for (const b of beats) {
    if (!b?.line) continue;
    const a = String(b.a ?? '');
    // Поза — брак, только если после неё до конца фразы (до «;» или «.»)
    // герой больше не двигается. «Перевернулся на спину и скользит дальше» —
    // движение; «плюхнулся на спину с картой в лапах;» — стоп-кадр.
    const позы = [...a.matchAll(new RegExp(ПОКОЙ.source, 'gi'))];
    const застыл = позы.find((м) => {
      const хвост = a.slice(м.index + м[0].length).split(/[;.]/)[0];
      return !ГЛАГОЛ_ДВИЖЕНИЯ.test(хвост);
    });
    if (застыл) {
      issues.push({ t: b.t, why: `в речевом бите поза покоя («${застыл[0]}»), после неё герой не двигается: кадр встанет — пусть говорит на ходу` });
    } else if (!ГЛАГОЛ_ДВИЖЕНИЯ.test(a)) {
      issues.push({ t: b.t, why: 'у говорящего нет перемещения всем телом (бежит, прыгает, кувыркается, плывёт, падает…)' });
    }
  }
  return issues;
}
