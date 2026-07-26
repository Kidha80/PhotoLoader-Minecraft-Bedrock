import { world, system } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { PHOTOS, BUILD } from "./photos.js";

const VERSION = "v6";
const PLACER = "photo:placer";
const DISPLAY = "photo:display";

// Плоскость фото в геометрии приподнята на 0.45 блока над точкой спавна,
// чтобы хитбокс сущности (растущий от точки спавна вверх) накрывал центр фото.
const PLANE_LIFT = 0.45;
const GAP = 0.03;

// Последний выбор игрока: id фото, размер, свечение
const lastChoice = new Map();
// Защита от двойного срабатывания itemUse + itemUseOn на один тап
const lastUseTick = new Map();

const FACE_INFO = {
    Up: { normal: [0, 1, 0], face: 1 },
    Down: { normal: [0, -1, 0], face: 2 },
    North: { normal: [0, 0, -1], face: 0, yaw: 0 },
    South: { normal: [0, 0, 1], face: 0, yaw: 0 },
    East: { normal: [1, 0, 0], face: 0, yaw: 90 },
    West: { normal: [-1, 0, 0], face: 0, yaw: 90 }
};

function actionbar(player, text) {
    try {
        player.onScreenDisplay.setActionBar(text);
    } catch {}
}

// Форма может не открыться сразу после клика (UserBusy) — повторяем попытки.
async function forceShow(player, form, retries = 40) {
    const res = await form.show(player);
    if (res.canceled && res.cancelationReason === "UserBusy" && retries > 0) {
        if (retries % 10 === 0) actionbar(player, "Открываю меню…");
        return new Promise((resolve) =>
            system.runTimeout(() => resolve(forceShow(player, form, retries - 1)), 4)
        );
    }
    return res;
}

function clampPhotoId(id) {
    return Math.max(0, Math.min(id | 0, PHOTOS.length - 1));
}

function placePhoto(player, block, blockFace, choice) {
    const info = FACE_INFO[blockFace];
    if (!info) return;
    const c = { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 };
    const loc = {
        x: c.x + info.normal[0] * (0.5 + GAP),
        y: c.y + info.normal[1] * (0.5 + GAP) - PLANE_LIFT,
        z: c.z + info.normal[2] * (0.5 + GAP)
    };
    let yaw = info.yaw ?? 0;
    if (info.face !== 0) {
        // На полу/потолке поворачиваем картинку по взгляду игрока (кратно 90°)
        yaw = Math.round(player.getRotation().y / 90) * 90;
    }
    let ent;
    try {
        ent = block.dimension.spawnEntity(DISPLAY, loc);
        ent.teleport(loc, { rotation: { x: 0, y: yaw } });
    } catch (e) {
        player.sendMessage("§c[Photo Loader] Не удалось разместить фото: " + e);
        return;
    }
    // Свойства ставим по одному: если у мира осталась старая версия пака
    // со сломанными свойствами, фото всё равно появится (с настройками
    // по умолчанию), а игрок получит подсказку, как это починить.
    let propFailed = false;
    for (const [prop, val] of [
        ["photo:id", clampPhotoId(choice.id)],
        ["photo:size", choice.size],
        ["photo:face", info.face],
        ["photo:glow", !!choice.glow],
        ["photo:mirror", !!choice.mirror]
    ]) {
        try {
            ent.setProperty(prop, val);
        } catch {
            propFailed = true;
        }
    }
    if (propFailed) {
        warnStaleOnce(player);
    } else {
        actionbar(player, "Фото размещено. Присесть+тап — меню, тап по фото — настройка");
    }
    player.playSound("random.pop");
}

let staleWarned = false;
function warnStaleOnce(player) {
    if (staleWarned) return;
    staleWarned = true;
    player.sendMessage(
        "§e[Photo Loader] В этом мире активна старая версия пака — настройки фото не применяются.\n" +
        "§eИсправление: выйди из мира → Настройки → Хранилище → удали ВСЕ версии Photo Loader BP и RP → " +
        "открой свежий PhotoLoader.mcaddon → в настройках мира включи паки заново."
    );
}

async function openPicker(player, block, blockFace) {
    try {
        const prev = lastChoice.get(player.id) ?? { id: 0, size: 2, glow: false, mirror: false };
        const form = new ModalFormData()
            .title("Выбор фото")
            .dropdown("Изображение", PHOTOS.map((p) => p.name), clampPhotoId(prev.id))
            .slider("Размер (большая сторона, в блоках)", 0.5, 16, 0.5, prev.size)
            .toggle("Свечение (видно в темноте)", !!prev.glow)
            .toggle("Зеркально", !!prev.mirror);
        const res = await forceShow(player, form);
        if (res.canceled) {
            if (res.cancelationReason === "UserBusy") {
                player.sendMessage("§e[Photo Loader] Меню не открылось. Закрой все окна и попробуй ещё раз.");
            }
            return;
        }
        const [id, size, glow, mirror] = res.formValues;
        const choice = { id, size, glow, mirror };
        lastChoice.set(player.id, choice);
        if (block) placePhoto(player, block, blockFace, choice);
    } catch (e) {
        player.sendMessage("§c[Photo Loader] Ошибка меню: " + e);
    }
}

// --- камера для скриншота ---
// Ставит камеру напротив центра фото на дистанции, при которой фото при
// FOV 60° и экране 16:9 вписывается в кадр целиком, без срезания краёв.
const cameraLocked = new Set();

function screenshotCamera(player, ent) {
    const info = PHOTOS[clampPhotoId(ent.getProperty("photo:id"))];
    const size = ent.getProperty("photo:size");
    const m = Math.max(info.w, info.h);
    const W = size * info.w / m;
    const H = size * info.h / m;
    const face = ent.getProperty("photo:face");
    const pos = ent.location;
    const center = { x: pos.x, y: pos.y + PLANE_LIFT, z: pos.z };
    let n;
    if (face === 1) {
        n = { x: 0, y: 1, z: 0 };
    } else if (face === 2) {
        n = { x: 0, y: -1, z: 0 };
    } else {
        // Стена: нормаль ±Z при yaw 0, ±X при yaw 90 — берём сторону игрока
        const yaw = Math.round(ent.getRotation().y / 90) * 90;
        const alongX = Math.abs(yaw) === 90;
        if (alongX) {
            n = { x: Math.sign(player.location.x - center.x) || 1, y: 0, z: 0 };
        } else {
            n = { x: 0, y: 0, z: Math.sign(player.location.z - center.z) || 1 };
        }
    }
    const TAN_V = Math.tan(Math.PI / 6);      // половина вертикального FOV 60°
    const TAN_H = TAN_V * 16 / 9;             // половина горизонтального FOV при 16:9
    const d = Math.max((H / 2) / TAN_V, (W / 2) / TAN_H);
    const cam = { x: center.x + n.x * d, y: center.y + n.y * d, z: center.z + n.z * d };
    try {
        player.runCommand(
            `camera @s set minecraft:free pos ${cam.x.toFixed(4)} ${cam.y.toFixed(4)} ${cam.z.toFixed(4)} ` +
            `facing ${center.x.toFixed(4)} ${center.y.toFixed(4)} ${center.z.toFixed(4)}`
        );
        cameraLocked.add(player.id);
        player.sendMessage(
            "§b[Photo Loader]§r Камера зафиксирована под скриншот 1920×1080.\n" +
            "§7Важно: FOV должен быть §f60°§7 (значение по умолчанию, Настройки → Видео → Поле зрения), " +
            "интерфейс скрой там же (Скрыть HUD).\n" +
            "§7Сделай скриншот и §fприсядь§7, чтобы вернуть камеру."
        );
    } catch (e) {
        player.sendMessage("§c[Photo Loader] Не удалось зафиксировать камеру: " + e);
    }
}

// Возврат камеры по приседанию
system.runInterval(() => {
    if (cameraLocked.size === 0) return;
    for (const p of world.getAllPlayers()) {
        if (!cameraLocked.has(p.id)) continue;
        if (p.isSneaking) {
            cameraLocked.delete(p.id);
            try {
                p.runCommand("camera @s clear");
            } catch {}
            actionbar(p, "Камера возвращена");
        }
    }
}, 4);

async function openEditor(player, ent) {
    try {
        const form = new ModalFormData()
            .title("Настройка фото")
            .dropdown("Изображение", PHOTOS.map((p) => p.name), clampPhotoId(ent.getProperty("photo:id")))
            .slider("Размер (большая сторона, в блоках)", 0.5, 16, 0.5, ent.getProperty("photo:size"))
            .toggle("Свечение (видно в темноте)", ent.getProperty("photo:glow"))
            .toggle("Зеркально", ent.getProperty("photo:mirror"))
            .toggle("📷 Камера для скриншота 1920×1080 (нужен FOV 60°)", false)
            .toggle("§cУдалить фото", false);
        const res = await forceShow(player, form);
        if (res.canceled || !ent.isValid()) return;
        const [id, size, glow, mirror, camera, remove] = res.formValues;
        if (remove) {
            ent.remove();
            player.playSound("dig.wood");
            return;
        }
        let propFailed = false;
        for (const [prop, val] of [
            ["photo:id", clampPhotoId(id)],
            ["photo:size", size],
            ["photo:glow", glow],
            ["photo:mirror", mirror]
        ]) {
            try {
                ent.setProperty(prop, val);
            } catch {
                propFailed = true;
            }
        }
        if (propFailed) warnStaleOnce(player);
        player.playSound("random.click");
        if (camera) {
            // Даём свойствам примениться (размер влияет на дистанцию камеры)
            system.runTimeout(() => {
                if (ent.isValid()) screenshotCamera(player, ent);
            }, 2);
        }
    } catch (e) {
        player.sendMessage("§c[Photo Loader] Ошибка меню: " + e);
    }
}

function handleUse(player, block, blockFace) {
    // itemUse и itemUseOn могут прийти на один и тот же тап
    const tick = system.currentTick;
    const prev = lastUseTick.get(player.id);
    if (prev !== undefined && tick - prev < 4) return;
    lastUseTick.set(player.id, tick);

    if (player.isSneaking) {
        openPicker(player, block, blockFace);
        return;
    }
    // Обычный тап ставит фото сразу, без меню — форма не нужна для основного действия
    const choice = lastChoice.get(player.id) ?? { id: 0, size: 2, glow: false };
    lastChoice.set(player.id, choice);
    placePhoto(player, block, blockFace, choice);
}

// Одна недоступная фича (например, на старой версии игры) не должна
// убивать весь скрипт — каждая подписка изолирована.
function safeSubscribe(signal, name, handler) {
    try {
        signal.subscribe(handler);
    } catch (e) {
        console.error(`[Photo Loader] не удалось подписаться на ${name}: ${e}`);
    }
}

safeSubscribe(world.afterEvents.itemUseOn, "itemUseOn", (ev) => {
    const player = ev.source;
    if (!player || player.typeId !== "minecraft:player") return;
    if (!ev.itemStack || ev.itemStack.typeId !== PLACER) return;
    handleUse(player, ev.block, ev.blockFace);
});

// Запасной путь: если itemUseOn на устройстве не сработал, ловим общий
// itemUse и находим блок лучом из камеры.
safeSubscribe(world.afterEvents.itemUse, "itemUse", (ev) => {
    const player = ev.source;
    if (!player || player.typeId !== "minecraft:player") return;
    if (!ev.itemStack || ev.itemStack.typeId !== PLACER) return;
    const hit = player.getBlockFromViewDirection({ maxDistance: 8 });
    if (!hit || !hit.face) {
        actionbar(player, "Наведись на блок не дальше 8 блоков");
        return;
    }
    handleUse(player, hit.block, hit.face);
});

safeSubscribe(world.beforeEvents.playerInteractWithEntity, "playerInteractWithEntity", (ev) => {
    if (ev.target.typeId !== DISPLAY) return;
    ev.cancel = true;
    const { player, target } = ev;
    system.run(() => openEditor(player, target));
});

const greeted = new Set();
safeSubscribe(world.afterEvents.playerSpawn, "playerSpawn", (ev) => {
    if (!ev.initialSpawn) return;
    const player = ev.player;
    if (greeted.has(player.id)) return;
    greeted.add(player.id);
    // Короткая строка при каждом входе — по ней видно, что скрипты работают
    // и какая именно сборка пака активна в этом мире
    player.sendMessage(`§b[Photo Loader]§r ${VERSION} (сборка ${BUILD ?? "?"}), фото в паке: ${PHOTOS.length}`);
    if (player.getDynamicProperty("photo:tip_shown")) return;
    player.setDynamicProperty("photo:tip_shown", true);
    player.sendMessage(
        "§b[Photo Loader]§r Скрафти §eФоторамку§r (8 бумаги + стеклянная панель) или возьми через §e/give @s photo:placer§r.\n" +
        "Тап по поверхности — ставит фото. §eПрисев§r + тап — меню выбора фото и размера.\n" +
        "Тап по центру размещённого фото — настройка или удаление."
    );
});
