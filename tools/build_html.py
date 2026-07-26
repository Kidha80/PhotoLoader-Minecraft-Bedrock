#!/usr/bin/env python3
"""Собирает generator.html: встраивает файлы аддона в tools/generator_src.html.

Запускать после любого изменения статичных файлов аддона (manifest, main.js,
иконки и т.д.): python3 tools/build_html.py
"""
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "addon"

# Статичные файлы, которые generator.html кладёт в пак как есть
# (производные — геометрия, сущности, photos.js — он генерирует сам).
TEMPLATE_FILES = [
    ("BP/manifest.json", "behavior_pack/manifest.json"),
    ("BP/items/photo_placer.json", "behavior_pack/items/photo_placer.json"),
    ("BP/recipes/photo_placer.json", "behavior_pack/recipes/photo_placer.json"),
    ("BP/scripts/main.js", "behavior_pack/scripts/main.js"),
    ("BP/pack_icon.png", "behavior_pack/pack_icon.png"),
    ("RP/manifest.json", "resource_pack/manifest.json"),
    ("RP/animations/photo_display.animation.json", "resource_pack/animations/photo_display.animation.json"),
    ("RP/textures/item_texture.json", "resource_pack/textures/item_texture.json"),
    ("RP/textures/items/photo_placer.png", "resource_pack/textures/items/photo_placer.png"),
    ("RP/texts/ru_RU.lang", "resource_pack/texts/ru_RU.lang"),
    ("RP/texts/en_US.lang", "resource_pack/texts/en_US.lang"),
    ("RP/texts/languages.json", "resource_pack/texts/languages.json"),
    ("RP/pack_icon.png", "resource_pack/pack_icon.png"),
]


def main():
    files = {}
    for zip_path, src in TEMPLATE_FILES:
        data = (ADDON / src).read_bytes()
        if src.endswith(".png"):
            files[zip_path] = {"t": "b64", "d": base64.b64encode(data).decode()}
        else:
            files[zip_path] = {"t": "text", "d": data.decode("utf-8")}

    src_html = (ROOT / "tools" / "generator_src.html").read_text(encoding="utf-8")
    embed = json.dumps({"files": files}, ensure_ascii=False)
    # </script> внутри строк ломает html — экранируем
    embed = embed.replace("</", "<\\/")
    start = src_html.index("/*__EMBED__*/")
    end = src_html.index("/*__EMBED_END__*/") + len("/*__EMBED_END__*/")
    out = src_html[: start] + embed + src_html[end:]
    (ROOT / "generator.html").write_text(out, encoding="utf-8")
    size = len(out.encode("utf-8")) // 1024
    print(f"generator.html собран ({size} КБ)")


if __name__ == "__main__":
    main()
