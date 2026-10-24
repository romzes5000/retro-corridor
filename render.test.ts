import assert from "node:assert/strict"
import test from "node:test"
import { FakeImage } from "./fake-image.ts"
import { loadGame, type View, type World } from "./load-logic.ts"

const game = loadGame()
const c = game.corridor
const r = game.corridorRender
const art = game.corridorArt as unknown as Record<string, unknown>

const STONE = [6, 7, 8, 9, 15]
const EXIT = [4, 5, 1, 15]

function frame(world: World, tweak: (v: View) => void = () => {}): FakeImage {
    const view = new r.View()
    view.mode = r.MODE_PLAY
    tweak(view)
    const img = new FakeImage(160, 120)
    r.draw(img as never, world, view)
    return img
}

function columnColours(img: FakeImage, x: number, y0: number, y1: number): Set<number> {
    const out = new Set<number>()
    for (let y = y0; y < y1; y++) out.add(img.getPixel(x, y))
    return out
}

test("арт: строки одной ширины, текстуры стен квадратные 16x16 под blitRow", () => {
    for (const [name, rows] of Object.entries(art)) {
        if (!Array.isArray(rows) || typeof rows[0] !== "string" || name === "FONT") continue
        const w = (rows[0] as string).length
        for (const row of rows as string[]) assert.equal(row.length, w, `${name}: ${row}`)
    }
    for (const name of ["STONE", "BRICK", "EXIT"]) {
        const rows = art[name] as string[]
        assert.equal(rows.length, 16, name)
        assert.equal(rows[0].length, 16, name)
    }
    const glyphs = art.GLYPHS as string
    assert.equal((art.FONT as string[]).length, glyphs.length)
})

test("затемнение идёт по своей рампе и не светлеет", () => {
    const darker = art.DARKER as number[]
    const palette = art.PALETTE as number[]
    const lum = (rgb: number) => ((rgb >> 16) & 255) * 3 + ((rgb >> 8) & 255) * 6 + (rgb & 255)
    for (let i = 1; i < 16; i++) assert.ok(lum(palette[darker[i]]) <= lum(palette[i]), `цвет ${i}`)
    const tex = r.decode(["67", "89"])
    const dark = r.darken(tex, 1)
    assert.equal(dark.getPixel(0, 0), 7)
    assert.equal(dark.getPixel(1, 1), 15)
})

test("стена перед носом заполняет центр, сверху потолок, снизу панель", () => {
    const world = c.createWorld(["#####", "#S..#", "#####"], 0)
    const img = frame(world)
    for (const col of columnColours(img, 80, 30, 70)) assert.ok(STONE.includes(col), `цвет ${col}`)
    assert.equal(img.getPixel(80, 0), 13)
    assert.equal(img.getPixel(5, 100), 7)
})

test("жёлтая дверь видна в конце длинного коридора", () => {
    const world = c.createWorld(["################", "#S.............X", "################"], 0)
    const img = frame(world)
    const centre = columnColours(img, 80, 46, 54)
    assert.ok([...centre].some((col) => col === 4), `в центре ${[...centre]}`)
    for (const col of centre) assert.ok(EXIT.includes(col), `цвет ${col}`)
})

test("z-буфер прячет беса за стеной и показывает перед ней", () => {
    const hidden = frame(c.createWorld(["########", "#S.#..E#", "########"], 0))
    const empty = frame(c.createWorld(["########", "#S.#...#", "########"], 0))
    assert.deepEqual(hidden.pixels, empty.pixels)

    const open = frame(c.createWorld(["########", "#S...E.#", "########"], 0))
    const reds = [...columnColours(open, 80, 30, 70)].filter((col) => col === 2 || col === 3)
    assert.ok(reds.length > 0, "бес виден")
})

test("карта по B рисует игрока и стрелку взгляда", () => {
    const world = c.createWorld(c.CAMPAIGN, 0)
    const closed = frame(world)
    const open = frame(world, (v) => { v.mapOpen = true })
    assert.notDeepEqual(open.pixels, closed.pixels)
    const cell = 5
    const mx = (160 - 16 * cell) >> 1
    const my = ((100 - 16 * cell) >> 1) + 3
    const px = mx + ((world.x * cell) >> 10)
    const py = my + ((world.y * cell) >> 10)
    assert.equal(open.getPixel(px, py), 1)
    assert.equal(open.getPixel(px + 4, py), 4)
})

test("разрешение через колонку дублирует соседние столбцы", () => {
    const world = c.createWorld(c.CAMPAIGN, 0)
    const img = frame(world, (v) => { v.colStep = 2 })
    for (let x = 0; x < 160; x += 2) {
        assert.equal(img.getPixel(x, 20), img.getPixel(x + 1, 20), `столбец ${x}`)
    }
})

test("выстрел даёт вспышку и отдачу, через 200 мс эффекты гаснут", () => {
    const view = new r.View()
    r.react(view, ["shoot", "hurt"])
    assert.ok(view.flash > 0 && view.recoil > 0 && view.hurt > 0 && view.shake > 0)
    assert.equal(view.face, 1)
    r.tick(view, 250)
    assert.equal(view.flash, 0)
    assert.equal(view.recoil, 0)
    assert.equal(view.hurt, 0)
})

test("урон красит края кадра красным", () => {
    const world = c.createWorld(c.CAMPAIGN, 0)
    const img = frame(world, (v) => { v.hurt = 100 })
    assert.equal(img.getPixel(0, 50), 2)
    assert.equal(img.getPixel(159, 50), 2)
    assert.notEqual(frame(world).getPixel(0, 50), 2)
})

test("счётчик FPS считает кадры за секунду", () => {
    const view = new r.View()
    for (let i = 0; i < 25; i++) r.tick(view, 40)
    assert.equal(view.fps, 25)
})

test("титул и экран победы рисуют оверлей поверх кадра", () => {
    const world = c.createWorld(c.CAMPAIGN, 0)
    const play = frame(world)
    const title = frame(world, (v) => { v.mode = r.MODE_TITLE })
    assert.notDeepEqual(title.pixels, play.pixels)
    assert.equal(title.getPixel(13, 50), 5)
    world.won = true
    const won = frame(world)
    assert.equal(won.getPixel(13, 50), 4)
})

test("ниже 15 FPS три секунды подряд — рендер переходит на 80 лучей", () => {
    const view = new r.View()
    view.fps = 12
    r.adapt(view, 2000)
    view.fps = 30
    r.adapt(view, 100)
    view.fps = 12
    r.adapt(view, 2000)
    assert.equal(view.colStep, 1, "провал прервался — счётчик сброшен")
    r.adapt(view, 1100)
    assert.equal(view.colStep, 2)

    const fast = new r.View()
    fast.fps = 40
    r.adapt(fast, 10000)
    assert.equal(fast.colStep, 1)
})
