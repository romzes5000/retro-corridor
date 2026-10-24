import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
    BLOCKED, SHEET, applyOverrides, cutCell, foreground, formatArt, importSheet, loadPalette, nearest, readSheet, shrink, type Rgba,
} from "./sprite-import.ts"

const palette = loadPalette()
const sheetPath = fileURLToPath(new URL("../art-src/demons.png", import.meta.url))

// Synthetic RGBA image: `paint(x, y)` returns [r, g, b, a] per pixel.
function image(w: number, h: number, paint: (x: number, y: number) => number[]): Rgba {
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4)
    return { width: w, height: h, data }
}

const CLEAR = [0, 0, 0, 0]
const RED = [216, 52, 42, 255]
const BONE = [242, 230, 201, 255]
const WHITE = [255, 255, 255, 255]

function topRow(rows: string[]): number {
    return rows.findIndex((r) => /[^.]/.test(r))
}

test("ближайший цвет: точные цвета палитры, синий ключей и потолок не выбираются", () => {
    assert.equal(nearest(palette, 216, 52, 42), 2)
    assert.equal(nearest(palette, 242, 230, 201), 1)
    for (const slot of BLOCKED) {
        const c = palette[slot]
        assert.notEqual(nearest(palette, (c >> 16) & 255, (c >> 8) & 255, c & 255), slot, `слот ${slot}`)
    }
    const limited = nearest(palette, 216, 52, 42, [3, 5])
    assert.ok([3, 5].includes(limited), `в наборе вида: ${limited}`)
})

test("фон заливается от краёв: белое снаружи уходит, светлое внутри силуэта остаётся", () => {
    // 10x10: transparent border, white halo ring, red body with a bone pixel in the middle.
    const img = image(10, 10, (x, y) => {
        if (x === 0 || y === 0 || x === 9 || y === 9) return CLEAR
        if (x === 1 || y === 1 || x === 8 || y === 8) return WHITE
        if (x === 5 && y === 5) return BONE
        return RED
    })
    const mask = foreground(img, { x0: 0, y0: 0, x1: 9, y1: 9 })
    assert.equal(mask[1 * 10 + 4], 0, "белый ореол — фон")
    assert.equal(mask[5 * 10 + 5], 1, "кость внутри — спрайт")
    assert.equal(mask[3 * 10 + 3], 1)
})

test("сжатие: блок ниже порога покрытия прозрачный, иначе самый частый цвет", () => {
    // 8x8 cell shrunk by 4 into 2x2: left-top block 3/16 red (transparent), right-top 12 bone + 4 red.
    const img = image(8, 8, (x, y) => {
        if (y < 4 && x < 4) return x === 0 && y < 3 ? RED : CLEAR
        if (y < 4) return x === 4 ? RED : BONE
        return RED
    })
    const cell = cutCell(img, { x0: 0, y0: 0, x1: 7, y1: 7 }, palette)
    const rows = shrink(cell, 0.25, 2, 4, 7)
    assert.deepEqual(rows, [".1", "22"])
})

test("кадр ставится по нижнему центру клетки", () => {
    const img = image(12, 12, (x, y) => (x < 2 && y < 2 ? RED : CLEAR))
    const cell = cutCell(img, { x0: 0, y0: 0, x1: 11, y1: 11 }, palette)
    const c = cell.content
    const rows = shrink(cell, 1, 6, (c.x0 + c.x1 + 1) / 2, c.y1)
    assert.deepEqual(rows, ["......", "......", "......", "......", "..22..", "..22.."])
})

test("поправки накладываются на сжатый кадр", () => {
    assert.deepEqual(applyOverrides(["...", ".2.", "..."], [[0, 0, 4], [1, 1, -1]]), ["4..", "...", "..."])
})

test("лист: 4 вида по 8 кадров нужного размера, шар 2 кадра 8x8, только палитра, пустых нет", () => {
    const art = importSheet(readSheet(sheetPath), palette)
    assert.equal(art.enemies.length, 4)
    const sizes = SHEET.filter((b) => b.name !== "fireball").map((b) => b.size)
    art.enemies.forEach((frames, kind) => {
        assert.equal(frames.length, 8)
        for (const rows of frames) {
            assert.equal(rows.length, sizes[kind])
            for (const r of rows) assert.match(r, new RegExp(`^[.0-9a-f]{${sizes[kind]}}$`))
            assert.ok(topRow(rows) >= 0, `пустой кадр у вида ${kind}`)
            assert.ok(!/[0de]/.test(rows.join("")), "запрещённые слоты")
        }
    })
    assert.equal(art.fireball.length, 2)
    for (const rows of art.fireball) assert.deepEqual(rows.map((r) => r.length), [8, 8, 8, 8, 8, 8, 8, 8])
})

test("общий масштаб на вид: труп лежит ниже ходьбы, ходьба касается пола", () => {
    const art = importSheet(readSheet(sheetPath), palette)
    for (const frames of art.enemies) {
        const walk = frames[0]
        const corpse = frames[3]
        assert.ok(topRow(corpse) > topRow(walk) + 4, `труп ${topRow(corpse)}, ходьба ${topRow(walk)}`)
        assert.match(walk[walk.length - 1], /[^.]/, "ноги на нижней строке")
        assert.equal(topRow(walk), 1, "верхняя строка свободна")
    }
})

test("art-enemies.ts совпадает с тем, что даёт лист: нет ручных правок и дрейфа", () => {
    const art = importSheet(readSheet(sheetPath), palette)
    const committed = fs.readFileSync(new URL("../art-enemies.ts", import.meta.url), "utf8")
    assert.equal(formatArt(art), committed)
})
