r"""Запасной художник обложек «новости часа»: FLUX.2 dev в Cloudflare (бесплатно).

Решения заказчицы:
  20.10.2026 — «обложки делает только Кодекс»;
  21.10.2026 — «FLUX.2 dev как запасной: если Кодекс не отвечает столько-то или
  нет лимитов — автоматом переходим на FLUX.2».

Порядок (Планировщик Windows запускает 4 раза в час: :47, :50, :53, :56, без окон):
  * новость появляется в :36, её рисует Кодекс;
  * за 13 минут до выхода (обычно :47) обложки всё нет — рисуем сами:
    описание сцены (Cloudflare, бесплатная Llama 3.3) → картинка FLUX.2 dev
    (запасной — FLUX.2 klein) → deliver Контент-завода (v7 + одобренная музыка);
  * если Кодекс держит бронь, но за 8 минут до выхода (обычно :52) так и не
    прислал — бронь снимаем и рисуем сами. Опоздавшая обложка Кодекса получит
    «повтор» — второго поста не будет;
  * не вышло — VibePost в :10 выпустит новость текстом.

Файлы Контент-завода не меняются — только его команды need/claim/deliver.
Ключ Cloudflare — в cloudflare.env рядом (в git не попадает), в журнал не пишется.
Журнал: oblozhki.log — только id, время, результат.

Запуск: <Контент-завод>\.venv\Scripts\python.exe oblozhki-avto.py
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ЗАВОД = Path(r"C:\Users\rid-s\Downloads\Обучение\Проекты CODEX\Контент-завод")
ПИТОН = ЗАВОД / ".venv" / "Scripts" / "python.exe"
ЗДЕСЬ = Path(__file__).resolve().parent.parent
ЖУРНАЛ = ЗДЕСЬ / "oblozhki.log"
ЗАМОК = ЗДЕСЬ / "oblozhki.lock"
ПАПКА = ЗАВОД / "data" / "covers-flux-tmp"

ЖДАТЬ_КОДЕКС = timedelta(minutes=13)       # до выхода: рисуем сами, если обложки нет
СНЯТЬ_БРОНЬ = timedelta(minutes=8)          # до выхода: бронь Кодекса больше не ждём


def журнал(строка: str) -> None:
    with ЖУРНАЛ.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now():%d.%m %H:%M:%S} {строка}\n")


def настройки() -> dict[str, str]:
    знач: dict[str, str] = {}
    for s in (ЗДЕСЬ / "cloudflare.env").read_text(encoding="utf-8-sig").splitlines():
        if "=" in s and not s.lstrip().startswith("#"):
            k, v = s.split("=", 1)
            знач[k.strip()] = v.strip().strip('"').strip("'")
    if not знач.get("CLOUDFLARE_ACCOUNT_ID") or not знач.get("CLOUDFLARE_AI_TOKEN"):
        raise RuntimeError("нет ключа Cloudflare в cloudflare.env")
    return знач


def завод(*арг: str, срок: int = 300) -> tuple[int, str, str]:
    r = subprocess.run(
        [str(ПИТОН), "-m", "content_factory.integrations.vibepost_digest_cli", *арг],
        cwd=ЗАВОД, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=срок,
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        # без чёрных окон консоли на экране (её замечание 21.10)
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def облако(к: dict[str, str], модель: str, *, json_тело: dict | None = None,
           форма: dict | None = None, срок: int = 120) -> dict:
    адрес = f"https://api.cloudflare.com/client/v4/accounts/{к['CLOUDFLARE_ACCOUNT_ID']}/ai/run/{модель}"
    заголовки = {"Authorization": "Bearer " + к["CLOUDFLARE_AI_TOKEN"]}
    if форма is not None:
        граница = uuid.uuid4().hex
        тело = b"".join(
            f'--{граница}\r\nContent-Disposition: form-data; name="{имя}"\r\n\r\n{знач}\r\n'.encode()
            for имя, знач in форма.items()
        ) + f"--{граница}--\r\n".encode()
        заголовки["Content-Type"] = f"multipart/form-data; boundary={граница}"
    else:
        тело = json.dumps(json_тело).encode()
        заголовки["Content-Type"] = "application/json"
    запрос = urllib.request.Request(адрес, data=тело, headers=заголовки, method="POST")
    return json.load(urllib.request.urlopen(запрос, timeout=срок))


def сцена(к: dict[str, str], текст: str) -> str:
    указание = (
        "Write ONE English image prompt (max 45 words) for a cinematic editorial illustration "
        "for this finance news. Only concrete objects, setting and light; the scene is BRIGHT and well lit, "
        "vivid colors, never dark or gloomy (it is a small cover in a phone feed); people only from behind "
        "or far away. No arrows, no charts, no numbers, no text, no letters, no logos, no flags, "
        "no faces of real people. Output only the prompt.\n\nNews: " + текст.replace("**", "")[:700]
    )
    try:
        о = облако(к, "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                   json_тело={"messages": [{"role": "user", "content": указание}], "max_tokens": 160}, срок=60)
        s = str(о.get("result", {}).get("response", "")).strip().strip('"')
        if 20 < len(s) < 700:
            return s
    except Exception as e:
        журнал(f"  сцена: {type(e).__name__}")
    return ("cinematic editorial illustration about money and the economy: a city at dusk, "
            "office towers, banknotes and coins on a desk, dramatic warm light")


def картинка(к: dict[str, str], описание: str, куда: Path) -> str | None:
    хвост = (", bright vivid lighting, rich detail, wide 16:9 composition, "
             "no text, no letters, no numbers, no arrows, no logos, no watermark")
    # 24.10: FLUX.2 dev ≈ 7 400 нейронов за картинку при бесплатных 10 000 в сутки —
    # одна обложка в день, дальше 429. Теперь klein 1024×576 (≈ 900, ~10 в день),
    # за ним schnell (≈ 330) — он без размеров, квадрат 1024; deliver обрежет под 16:9.
    for модель in ("@cf/black-forest-labs/flux-2-klein-9b", "@cf/black-forest-labs/flux-1-schnell"):
        try:
            if модель.endswith("schnell"):
                о = облако(к, модель, json_тело={"prompt": описание + хвост, "steps": 8})
            else:
                о = облако(к, модель, форма={"prompt": описание + хвост, "width": 1024, "height": 576})
            данные = base64.b64decode(о["result"]["image"])
            if len(данные) < 20_000:
                raise ValueError("мала")
            куда.write_bytes(данные)
            return модель.rsplit("/", 1)[-1]
        except Exception as e:
            журнал(f"  {модель.rsplit('/', 1)[-1]}: {type(e).__name__} {getattr(e, 'code', '')}")
    return None


def бронь(ид: str) -> Path:
    return ЗАВОД / "data" / "covers" / ("vp-" + ид.replace("-", "")) / ".generation-claim.json"


def занять(ид: str) -> str:
    код, вывод, ошибка = завод("claim", "--publication-id", ид, срок=120)
    return json.loads(вывод).get("result") if код == 0 and вывод else ошибка[:60]


def главное() -> int:
    if ЗАМОК.exists() and time.time() - ЗАМОК.stat().st_mtime < 15 * 60:
        return 0  # прошлый запуск ещё работает
    ЗАМОК.write_text(str(os.getpid()))
    try:
        код, вывод, ошибка = завод("need", срок=120)
        if код != 0:
            журнал(f"need: {ошибка[:80]}")
            return 1
        сейчас = datetime.now(timezone.utc)
        к: dict[str, str] | None = None
        for п in json.loads(вывод or "[]"):
            ид = п["publication_id"]
            if п.get("dry_run") or п.get("source_ready"):
                continue
            выход = datetime.fromisoformat(str(п["slot_at"]).replace("Z", "+00:00"))
            if сейчас < выход - ЖДАТЬ_КОДЕКС:
                continue  # Кодекс ещё рисует — его время
            итог = занять(ид)
            if итог == "ALREADY_IN_PROGRESS":
                if сейчас < выход - СНЯТЬ_БРОНЬ:
                    continue  # бронь Кодекса — ещё ждём
                бронь(ид).unlink(missing_ok=True)
                журнал(f"{ид[:8]} Кодекс держит бронь и молчит — снимаю, рисую FLUX.2")
                итог = занять(ид)
            if итог != "CLAIMED":
                журнал(f"{ид[:8]} claim: {итог}")
                continue
            начало = time.time()
            журнал(f"{ид[:8]} от Кодекса обложки нет — рисую FLUX.2")
            к = к or настройки()
            ПАПКА.mkdir(parents=True, exist_ok=True)
            источник = ПАПКА / f"{ид}.jpg"
            модель = картинка(к, сцена(к, п["text"]), источник)
            if not модель:
                бронь(ид).unlink(missing_ok=True)
                журнал(f"{ид[:8]} картинка не вышла — повтор через минуту, в :10 VibePost выпустит текстом")
                continue
            код, вывод, ошибка = завод("deliver", "--publication-id", ид, "--source", str(источник), срок=600)
            итог = json.loads(вывод).get("result") if код == 0 and вывод else ошибка[:60]
            журнал(f"{ид[:8]} {модель} → deliver: {итог} за {time.time() - начало:.0f} с")
            источник.unlink(missing_ok=True)
        return 0
    finally:
        ЗАМОК.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        sys.exit(главное())
    except SystemExit:
        raise
    except BaseException as e:
        журнал(f"СБОЙ {type(e).__name__}: {str(e)[:120]}")
        ЗАМОК.unlink(missing_ok=True)
        sys.exit(1)
