r"""Обложки к «новости часа» без Кодекса и без платных сервисов (19.10.2026).

Заказчица: «ни на что платное не согласна… справься до 24-го самостоятельно;
24-го завод должен работать как приложение и не зависеть ни от каких чатов».

Что делает один запуск (Планировщик Windows запускает раз в минуту):
  1. спрашивает Контент-завод, каким новостям нужна обложка (его команда need);
  2. для каждой: claim → описание сцены по тексту новости (бесплатный текстовый
     помощник Pollinations) → картинка (бесплатный рисовальщик Pollinations,
     без ключей) → обрезка надписи pollinations.ai в углу → deliver (Контент-
     завод сам собирает ролик v7 с одобренной музыкой и отправляет в VibePost).

Файлы Контент-завода не меняются — только вызываются его команды.
Не вышло нарисовать — обложки не будет, VibePost через 10 минут после часа
выпустит новость текстом. Заглушек не шлём.
Журнал: oblozhki.log рядом с этим файлом — только id, время, результат.

Запуск: <Контент-завод>\.venv\Scripts\python.exe oblozhki-avto.py
"""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ЗАВОД = Path(r"C:\Users\rid-s\Downloads\Обучение\Проекты CODEX\Контент-завод")
ПИТОН = ЗАВОД / ".venv" / "Scripts" / "python.exe"
ЗДЕСЬ = Path(__file__).resolve().parent.parent
ЖУРНАЛ = ЗДЕСЬ / "oblozhki.log"
ЗАМОК = ЗДЕСЬ / "oblozhki.lock"
ПАПКА = ЗАВОД / "data" / "covers-free-tmp"
АГЕНТ = {"User-Agent": "Mozilla/5.0 (VibePost covers)"}


def журнал(строка: str) -> None:
    with ЖУРНАЛ.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now():%d.%m %H:%M:%S} {строка}\n")


def завод(*арг: str, срок: int = 300) -> tuple[int, str, str]:
    r = subprocess.run(
        [str(ПИТОН), "-m", "content_factory.integrations.vibepost_digest_cli", *арг],
        cwd=ЗАВОД, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=срок,
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
    )
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def сцена(текст: str) -> str:
    """Английское описание сцены по тексту новости; при сбое — общее."""
    указание = (
        "Write ONE English prompt (max 45 words) for an image generator: a cinematic editorial "
        "illustration for a finance news cover about the news below. Concrete objects and setting, "
        "dramatic light, rich color, 16:9 composition. No text, no letters, no numbers, no logos, "
        "no flags, no real faces of famous people. Output only the prompt.\n\nNews: " + текст[:600]
    )
    тело = json.dumps({"messages": [{"role": "user", "content": указание}], "model": "openai"}).encode()
    for _ in range(2):
        try:
            запрос = urllib.request.Request("https://text.pollinations.ai/openai", data=тело,
                                            headers={"Content-Type": "application/json", **АГЕНТ})
            ответ = json.load(urllib.request.urlopen(запрос, timeout=90))
            s = ответ["choices"][0]["message"]["content"].strip().strip('"')
            if 20 < len(s) < 600:
                return s
        except Exception:
            time.sleep(3)
    return ("cinematic editorial illustration about money and the economy: city skyline, "
            "banknotes and coins, charts glowing on glass, dramatic warm light, no text")


def картинка(описание: str, куда: Path) -> bool:
    from PIL import Image
    хвост = ", no text, no letters, no watermark"
    # Бесплатный Pollinations: одна картинка раз в 45 с с одного адреса,
    # сервер бывает перегружен — пауза 50 с между попытками, ожидание до 3 мин.
    for попытка in range(3):
        if попытка:
            time.sleep(50)
        семя = random.randint(1, 10_000_000)
        адрес = ("https://image.pollinations.ai/prompt/" + urllib.parse.quote(описание + хвост)
                 + f"?width=1920&height=1080&nologo=true&seed={семя}")
        try:
            данные = urllib.request.urlopen(urllib.request.Request(адрес, headers=АГЕНТ), timeout=180).read()
            сырое = куда.with_suffix(".raw.jpg")
            сырое.write_bytes(данные)
            with Image.open(сырое) as im:
                im = im.convert("RGB")
                w, h = im.size
                if w < 512 or h < 288:
                    raise ValueError("мала")
                # надпись pollinations.ai — в правом нижнем углу: срезаем низ 9 %,
                # ширину подрезаем так, чтобы осталось 16:9
                нх = int(h * 0.91)
                нш = min(w, int(нх * 16 / 9))
                слева = (w - нш) // 2
                im = im.crop((слева, 0, слева + нш, нх))
                if im.height < 512:
                    im = im.resize((int(512 * 16 / 9), 512), Image.Resampling.LANCZOS)
                im.save(куда, format="PNG")
            сырое.unlink(missing_ok=True)
            return True
        except Exception as e:
            журнал(f"  картинка попытка {попытка + 1}: {type(e).__name__} {getattr(e, 'code', '')}")
    return False


def главное() -> int:
    if ЗАМОК.exists() and time.time() - ЗАМОК.stat().st_mtime < 15 * 60:
        return 0  # прошлый запуск ещё рисует
    ЗАМОК.write_text(str(os.getpid()))
    try:
        код, вывод, ошибка = завод("need", срок=120)
        if код != 0:
            журнал(f"need: {ошибка[:80]}")
            return 1
        for п in json.loads(вывод or "[]"):
            ид = п["publication_id"]
            журнал(f"{ид[:8]} нужна обложка (готов исходник: {п.get('source_ready')})")
            if п.get("dry_run"):
                continue
            начало = time.time()
            источник = None
            if not п.get("source_ready"):
                код, вывод, ошибка = завод("claim", "--publication-id", ид, срок=120)
                итог = (json.loads(вывод).get("result") if код == 0 and вывод else ошибка[:60])
                if итог not in ("CLAIMED", "SOURCE_READY"):
                    журнал(f"{ид[:8]} claim: {итог}")
                    continue
                if итог == "CLAIMED":
                    ПАПКА.mkdir(parents=True, exist_ok=True)
                    источник = ПАПКА / f"{ид}.png"
                    описание = сцена(п["text"])
                    if not картинка(описание, источник):
                        # снимаем свою бронь, чтобы следующий запуск (через минуту) попробовал снова;
                        # к 10-й минуте часа не успеем — VibePost выпустит новость текстом
                        (ЗАВОД / "data" / "covers" / ("vp-" + ид.replace("-", "")) / ".generation-claim.json").unlink(missing_ok=True)
                        журнал(f"{ид[:8]} картинка пока не вышла — повтор при следующем запуске")
                        continue
            арг = ["deliver", "--publication-id", ид] + (["--source", str(источник)] if источник else [])
            код, вывод, ошибка = завод(*арг, срок=600)
            итог = (json.loads(вывод).get("result") if код == 0 and вывод else ошибка[:60])
            журнал(f"{ид[:8]} deliver: {итог} за {time.time() - начало:.0f} с")
            if источник:
                источник.unlink(missing_ok=True)
        return 0
    finally:
        ЗАМОК.unlink(missing_ok=True)


if __name__ == "__main__":
    # 20.10: с 15:36 до 17:40 журнал молчал — падения мимо журнала. Пишем любое.
    try:
        sys.exit(главное())
    except SystemExit:
        raise
    except BaseException as e:
        журнал(f"СБОЙ {type(e).__name__}: {str(e)[:120]}")
        ЗАМОК.unlink(missing_ok=True)
        sys.exit(1)
