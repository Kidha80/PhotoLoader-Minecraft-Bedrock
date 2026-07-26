#!/usr/bin/env python3
"""Добавляет фотографии в аддон Photo Loader и собирает .mcaddon.

Примеры:
    python3 tools/add_photos.py фото1.jpg фото2.png
    python3 tools/add_photos.py --name "Наша дача" дача.jpg
    python3 tools/add_photos.py --max 4096 фото.jpg      # хранить до 4096px
    python3 tools/add_photos.py --list                   # список фото
    python3 tools/add_photos.py --remove 2               # удалить фото с id 2
    python3 tools/add_photos.py --build-only             # только пересобрать

Для добавления изображений нужен Pillow: pip install pillow
"""
import argparse
import io
import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "addon"
RP = ADDON / "resource_pack"
BP = ADDON / "behavior_pack"
REGISTRY = ADDON / "photos.json"
DIST = ROOT / "dist"

DEFAULT_MAX = 2048


def load_registry():
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {"photos": []}


def save_registry(reg):
    REGISTRY.write_text(
        json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def add_images(reg, files, name, max_size):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        sys.exit("Нужен Pillow: pip install pillow")

    photos_dir = RP / "textures" / "photos"
    photos_dir.mkdir(parents=True, exist_ok=True)
    for f in files:
        path = Path(f)
        if not path.exists():
            sys.exit(f"Файл не найден: {path}")
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        if max(img.size) > max_size:
            img.thumbnail((max_size, max_size), Image.LANCZOS)
        idx = len(reg["photos"])
        out = photos_dir / f"photo_{idx}.png"
        img.save(out, "PNG", optimize=True)
        reg["photos"].append(
            {
                "id": idx,
                "name": name or path.stem,
                "file": out.name,
                "w": img.size[0],
                "h": img.size[1],
            }
        )
        print(f"  + [{idx}] {reg['photos'][idx]['name']} ({img.size[0]}x{img.size[1]})")


def remove_photo(reg, rid):
    photos = reg["photos"]
    if not any(p["id"] == rid for p in photos):
        sys.exit(f"Фото с id {rid} нет")
    if len(photos) == 1:
        sys.exit("Нельзя удалить последнее фото — в паке должно остаться хотя бы одно")
    photos_dir = RP / "textures" / "photos"
    removed = next(p for p in photos if p["id"] == rid)
    (photos_dir / removed["file"]).unlink(missing_ok=True)
    photos[:] = [p for p in photos if p["id"] != rid]
    # Переименовываем файлы, чтобы id снова шли подряд с нуля
    tmp = photos_dir / "_tmp"
    tmp.mkdir(exist_ok=True)
    for new_id, p in enumerate(photos):
        shutil.move(photos_dir / p["file"], tmp / f"photo_{new_id}.png")
        p["id"] = new_id
        p["file"] = f"photo_{new_id}.png"
    for f in tmp.iterdir():
        shutil.move(f, photos_dir / f.name)
    tmp.rmdir()


def geometry_for(p):
    """Плоскость: большая сторона = 16 юнитов (1 блок при размере 1).

    Центр плоскости поднят до y=7.2 (0.45 блока), чтобы хитбокс сущности
    накрывал центр фото. Масштаб и поворот идут вокруг пивота — центра.
    """
    m = max(p["w"], p["h"])
    w_units = round(16.0 * p["w"] / m, 4)
    h_units = round(16.0 * p["h"] / m, 4)
    lift = 7.2
    return {
        "description": {
            "identifier": f"geometry.photo_{p['id']}",
            "texture_width": p["w"],
            "texture_height": p["h"],
        },
        "bones": [
            {
                "name": "root",
                "pivot": [0, lift, 0],
                "cubes": [
                    {
                        "origin": [-w_units / 2, round(lift - h_units / 2, 4), 0],
                        "size": [w_units, h_units, 0],
                        "uv": {
                            "south": {"uv": [0, 0], "uv_size": [p["w"], p["h"]]},
                            "north": {"uv": [p["w"], 0], "uv_size": [-p["w"], p["h"]]},
                        },
                    }
                ],
            }
        ],
    }


def regen_derived(reg):
    photos = reg["photos"]
    if not photos:
        sys.exit("В реестре нет ни одного фото")
    n = len(photos)

    # --- RP: геометрия ---
    geo = {
        "format_version": "1.12.0",
        "minecraft:geometry": [geometry_for(p) for p in photos],
    }
    write_json(RP / "models" / "entity" / "photos.geo.json", geo)

    # --- RP: клиентская сущность ---
    client_entity = {
        "format_version": "1.10.0",
        "minecraft:client_entity": {
            "description": {
                "identifier": "photo:display",
                "materials": {
                    "default": "entity_alphatest",
                    "glow": "entity_emissive_alpha",
                },
                "textures": {
                    f"photo_{p['id']}": f"textures/photos/photo_{p['id']}"
                    for p in photos
                },
                "geometry": {
                    f"photo_{p['id']}": f"geometry.photo_{p['id']}" for p in photos
                },
                "animations": {"transform": "animation.photo_display.transform"},
                "scripts": {"animate": ["transform"]},
                "render_controllers": ["controller.render.photo_display"],
            }
        },
    }
    write_json(RP / "entity" / "photo_display.entity.json", client_entity)

    # --- RP: рендер-контроллер ---
    rc = {
        "format_version": "1.10.0",
        "render_controllers": {
            "controller.render.photo_display": {
                "arrays": {
                    "textures": {
                        "Array.photos": [f"Texture.photo_{p['id']}" for p in photos]
                    },
                    "geometries": {
                        "Array.geos": [f"Geometry.photo_{p['id']}" for p in photos]
                    },
                },
                "geometry": "Array.geos[q.property('photo:id')]",
                "materials": [
                    {"*": "q.property('photo:glow') ? Material.glow : Material.default"}
                ],
                "textures": ["Array.photos[q.property('photo:id')]"],
            }
        },
    }
    write_json(RP / "render_controllers" / "photo_display.render_controllers.json", rc)

    # --- BP: сущность (диапазон свойства photo:id зависит от числа фото) ---
    bp_entity = {
        "format_version": "1.21.0",
        "minecraft:entity": {
            "description": {
                "identifier": "photo:display",
                "is_spawnable": False,
                "is_summonable": True,
                "properties": {
                    "photo:id": {
                        "type": "int",
                        "range": [0, max(n - 1, 0)],
                        "default": 0,
                        "client_sync": True,
                    },
                    "photo:size": {
                        "type": "float",
                        "range": [0.25, 16.0],
                        "default": 2.0,
                        "client_sync": True,
                    },
                    "photo:face": {
                        "type": "int",
                        "range": [0, 2],
                        "default": 0,
                        "client_sync": True,
                    },
                    "photo:glow": {
                        "type": "bool",
                        "default": False,
                        "client_sync": True,
                    },
                },
            },
            "components": {
                "minecraft:type_family": {"family": ["photo_display", "inanimate"]},
                "minecraft:physics": {"has_gravity": False, "has_collision": False},
                "minecraft:pushable": {
                    "is_pushable": False,
                    "is_pushable_by_piston": False,
                },
                "minecraft:collision_box": {"width": 0.9, "height": 0.9},
                "minecraft:damage_sensor": {"triggers": [{"deals_damage": False}]},
                "minecraft:knockback_resistance": {"value": 1.0},
                "minecraft:fire_immune": True,
                "minecraft:persistent": {},
                "minecraft:health": {"value": 10, "max": 10},
            },
        },
    }
    write_json(BP / "entities" / "photo_display.json", bp_entity)

    # --- BP: список фото для скрипта ---
    entries = ",\n".join(
        f"    {{ name: {json.dumps(p['name'], ensure_ascii=False)}, w: {p['w']}, h: {p['h']} }}"
        for p in photos
    )
    (BP / "scripts" / "photos.js").write_text(
        "// Этот файл генерируется автоматически (tools/add_photos.py / generator.html)\n"
        f"export const PHOTOS = [\n{entries}\n];\n",
        encoding="utf-8",
    )


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def bump_versions():
    """Поднимает версию паков, чтобы Minecraft обновил кэш при переустановке."""
    minutes = int(time.time() // 60)
    version = [1, (minutes >> 16) & 0xFFFF, minutes & 0xFFFF]
    for pack in (RP, BP):
        mf = json.loads((pack / "manifest.json").read_text(encoding="utf-8"))
        mf["header"]["version"] = version
        for mod in mf["modules"]:
            mod["version"] = version
        for dep in mf.get("dependencies", []):
            if "uuid" in dep:
                dep["version"] = version
        write_json(pack / "manifest.json", mf)


def build_mcaddon():
    DIST.mkdir(exist_ok=True)
    out = DIST / "PhotoLoader.mcaddon"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for pack, prefix in ((BP, "PhotoLoader_BP"), (RP, "PhotoLoader_RP")):
            for f in sorted(pack.rglob("*")):
                if f.is_file():
                    z.write(f, f"{prefix}/{f.relative_to(pack)}")
    print(f"Готово: {out} ({out.stat().st_size // 1024} КБ)")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*", help="изображения (jpg/png/webp/...)")
    ap.add_argument("--name", help="имя для добавляемого фото (по умолчанию — имя файла)")
    ap.add_argument("--max", type=int, default=DEFAULT_MAX,
                    help=f"макс. сторона текстуры в px (по умолчанию {DEFAULT_MAX}; "
                         "4096 — максимум качества, но тяжелее для слабых устройств)")
    ap.add_argument("--list", action="store_true", help="показать список фото")
    ap.add_argument("--remove", type=int, metavar="ID", help="удалить фото по id")
    ap.add_argument("--build-only", action="store_true",
                    help="пересобрать файлы аддона и .mcaddon без изменений")
    args = ap.parse_args()

    reg = load_registry()

    if args.list:
        for p in reg["photos"]:
            print(f"  [{p['id']}] {p['name']} ({p['w']}x{p['h']})")
        return

    if args.remove is not None:
        remove_photo(reg, args.remove)
    if args.files:
        add_images(reg, args.files, args.name, args.max)
    if not (args.files or args.remove is not None or args.build_only):
        ap.print_help()
        return

    save_registry(reg)
    regen_derived(reg)
    bump_versions()
    build_mcaddon()


if __name__ == "__main__":
    main()
