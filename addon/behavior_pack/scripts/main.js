import { world, system } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { PHOTOS } from "./photos.js";

const PLACER = "photo:placer";
const DISPLAY = "photo:display";

// Плоскость фото в геометрии приподнята на 0.45 блока над точкой спавна,
// чтобы хитбокс сущности (растущий от точки спавна вверх) накрывал центр фото.
const PLANE_LIFT = 0.45;
const GAP = 0.03;

// Последний выбор игрока: id фото и размер (id игрока -> {id, size, glow})
const lastChoice = new Map();

const FACE_INFO = {
    Up: { normal: [0, 1, 0], face: 1 },
    Down: { normal: [0, -1, 0], face: 2 },
    North: { normal: [0, 0, -1], face: 0, yaw: 0 },
    South: { normal: [0, 0, 1], face: 0, yaw: 0 },
    East: { normal: [1, 0, 0], face: 0, yaw: 90 },
    West: { normal: [-1, 0, 0], face: 0, yaw: 90 }
};

// Форма может не открыться сразу после клика (UserBusy) — повторяем попытки.
async function forceShow(player, form, retries = 20) {
    const res = await form.show(player);
    if (res.canceled && res.cancelationReason === "UserBusy" && retries > 0) {
        return new Promise((resolve) =>
            system.runTimeout(() => resolve(forceShow(player, form, retries - 1)), 5)
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
    try {
        const ent = block.dimension.spawnEntity(DISPLAY, loc);
        ent.teleport(loc, { rotation: { x: 0, y: yaw } });
        ent.setProperty("photo:id", clampPhotoId(choice.id));
        ent.setProperty("photo:size", choice.size);
        ent.setProperty("photo:face", info.face);
        ent.setProperty("photo:glow", !!choice.glow);
        player.playSound("random.pop");
    } catch (e) {
        player.sendMessage("§cНе удалось разместить фото: " + e);
    }
}

async function openPicker(player, block, blockFace) {
    const prev = lastChoice.get(player.id) ?? { id: 0, size: 2, glow: false };
    const form = new ModalFormData()
        .title("Выбор фото")
        .dropdown("Изображение", PHOTOS.map((p) => p.name), clampPhotoId(prev.id))
        .slider("Размер (большая сторона, в блоках)", 0.5, 16, 0.5, prev.size)
        .toggle("Свечение (видно в темноте)", !!prev.glow);
    const res = await forceShow(player, form);
    if (res.canceled) return;
    const [id, size, glow] = res.formValues;
    const choice = { id, size, glow };
    lastChoice.set(player.id, choice);
    if (block) placePhoto(player, block, blockFace, choice);
}

async function openEditor(player, ent) {
    const form = new ModalFormData()
        .title("Настройка фото")
        .dropdown("Изображение", PHOTOS.map((p) => p.name), clampPhotoId(ent.getProperty("photo:id")))
        .slider("Размер (большая сторона, в блоках)", 0.5, 16, 0.5, ent.getProperty("photo:size"))
        .toggle("Свечение (видно в темноте)", ent.getProperty("photo:glow"))
        .toggle("§cУдалить фото", false);
    const res = await forceShow(player, form);
    if (res.canceled || !ent.isValid()) return;
    const [id, size, glow, remove] = res.formValues;
    if (remove) {
        ent.remove();
        player.playSound("dig.wood");
        return;
    }
    ent.setProperty("photo:id", clampPhotoId(id));
    ent.setProperty("photo:size", size);
    ent.setProperty("photo:glow", glow);
    player.playSound("random.click");
}

world.afterEvents.itemUseOn.subscribe((ev) => {
    const player = ev.source;
    if (!player || player.typeId !== "minecraft:player") return;
    if (!ev.itemStack || ev.itemStack.typeId !== PLACER) return;
    const choice = lastChoice.get(player.id);
    if (player.isSneaking || !choice) {
        openPicker(player, ev.block, ev.blockFace);
    } else {
        placePhoto(player, ev.block, ev.blockFace, choice);
    }
});

world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
    if (ev.target.typeId !== DISPLAY) return;
    ev.cancel = true;
    const { player, target } = ev;
    system.run(() => openEditor(player, target));
});

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    const player = ev.player;
    if (player.getDynamicProperty("photo:tip_shown")) return;
    player.setDynamicProperty("photo:tip_shown", true);
    player.sendMessage(
        "§b[Photo Loader]§r Скрафти §eФоторамку§r (8 бумаги + стеклянная панель) или возьми через §e/give @s photo:placer§r.\n" +
        "Нажми ей по любой поверхности — выберешь фото и размер. Обычный клик — ставит с прошлыми настройками, §eприсев§r — снова открывает выбор.\n" +
        "Клик по центру фото — настройка или удаление."
    );
});
