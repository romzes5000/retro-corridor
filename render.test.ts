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
    assert.equal(img.getPixel(80, 0), 14)
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

test("лестница качества: каждые 3 с ниже 20 FPS — ступень вниз, обратно не поднимается", () => {
    const view = new r.View()
    assert.equal(view.quality, r.QUALITY_FULL)
    view.fps = 18
    r.adapt(view, 2000)
    view.fps = 25
    r.adapt(view, 100)
    view.fps = 18
    r.adapt(view, 2000)
    assert.equal(view.quality, r.QUALITY_FULL, "провал прервался — счётчик сброшен")
    r.adapt(view, 1100)
    assert.equal(view.quality, r.QUALITY_HALF)
    assert.equal(view.colStep, 1)
    r.adapt(view, 2900)
    assert.equal(view.quality, r.QUALITY_HALF, "на новой ступени снова ждём 3 с")
    r.adapt(view, 200)
    assert.equal(view.quality, r.QUALITY_BANDS)
    r.adapt(view, 3100)
    assert.equal(view.quality, r.QUALITY_LOW)
    assert.equal(view.colStep, 2, "последняя ступень — 80 лучей")
    r.adapt(view, 10000)
    assert.equal(view.quality, r.QUALITY_LOW)
    view.fps = 60
    r.adapt(view, 10000)
    assert.equal(view.quality, r.QUALITY_LOW, "вверх не возвращаемся")

    const fast = new r.View()
    fast.fps = 20
    r.adapt(fast, 10000)
    assert.equal(fast.quality, r.QUALITY_FULL, "ровно 20 FPS — не провал")
})

test("таяние экрана: одинаковое при одном seed и сходит за 0,3–1,5 с", () => {
    const from = new FakeImage(160, 120)
    from.fill(4)
    const a = new r.View()
    const b = new r.View()
    r.startMelt(a, from as never, 7)
    r.startMelt(b, from as never, 7)
    assert.deepEqual(a.melt, b.melt)
    assert.equal(a.melt.length, 160)
    for (const o of a.melt) assert.ok(o <= 0 && o >= -15, `смещение ${o}`)
    assert.ok(new Set(a.melt).size > 3, "колонки сходят неровно")

    const world = c.createWorld(["#####", "#S..#", "#####"], 0)
    const img = frame(world, (v) => { r.startMelt(v, from as never, 7) })
    assert.equal(img.getPixel(80, 60), 4, "в первом кадре виден старый экран")

    let ms = 0
    while (a.meltOn && ms < 5000) {
        r.meltTick(a, 33)
        ms += 33
    }
    assert.equal(a.meltOn, false)
    assert.ok(ms >= 300 && ms <= 1500, `таяло ${ms} мс`)
})

test("красная дверь в кадре красная, ключ в кармане виден на панели", () => {
    const world = c.createWorld(["######", "#S.R.#", "######"], 0)
    const img = frame(world)
    const red = (img: FakeImage) => [...columnColours(img, 80, 30, 70)].some((col) => col === 2 || col === 3)
    assert.ok(red(img), `цвета ${[...columnColours(img, 80, 30, 70)]}`)
    assert.equal(red(frame(c.createWorld(["######", "#S.|.#", "######"], 0))), false, "жёлтая дверь без красного")
    assert.notEqual(img.getPixel(92, 100 + 7), 2)
    world.keys = c.KEY_RED
    const keyed = frame(world)
    assert.equal(keyed.getPixel(92, 100 + 7), 2)
})

test("экран итогов уровня показывает CLEAR и проценты, титул — пункты меню", () => {
    const world = c.createWorld(c.CAMPAIGN, 0)
    world.won = true
    const won = frame(world)
    const yellow = [...Array(160).keys()].filter((x) => won.getPixel(x, 28) === 4).length
    assert.ok(yellow > 10, "крупное CLEAR жёлтым")
    const title = frame(world, (v) => { v.mode = r.MODE_TITLE })
    const next = frame(world, (v) => { v.mode = r.MODE_TITLE; v.menu.index = 1 })
    assert.notDeepEqual(title.pixels, next.pixels, "курсор меню рисуется")
})

test("список уровней рисуется вместо главного меню и показывает выбранный уровень", () => {
    const world = c.createWorld(["#####", "#S..#", "#####"], 0)
    const title = frame(world, (v) => { v.mode = r.MODE_TITLE; v.menu.index = c.MENU_LEVELS })
    const list = (level: number) => frame(world, (v) => {
        v.mode = r.MODE_TITLE
        v.menu.index = c.MENU_LEVELS
        v.menu.levels = true
        v.menu.level = level
    })
    const first = list(0)
    assert.notDeepEqual(first.pixels, title.pixels)
    assert.notDeepEqual(list(2).pixels, first.pixels, "курсор списка рисуется")
    const yellowRow = (img: FakeImage, y: number) => [...Array(160).keys()].some((x) => img.getPixel(x, y) === 4)
    assert.ok(yellowRow(first, 44), "выбранный первый уровень жёлтым")
    assert.equal(yellowRow(first, 64), false, "третий не выбран")
    assert.ok(yellowRow(list(2), 64), "выбранный третий уровень жёлтым")
    const glyphs = art.GLYPHS as string
    for (const level of c.LEVELS) {
        for (const ch of `>3${level.name}`) assert.ok(glyphs.includes(ch), `${level.name}: ${ch}`)
    }
})

test("в шрифте есть все символы экранов меню и итогов", () => {
    const glyphs = art.GLYPHS as string
    for (const text of ["KILLS 50%", "ITEMS 66%", "SECRETS 100%", "TIME 1:15", "> - NORMAL +", "A RETRY", "YOU DIED"]) {
        for (const ch of text.replace(/ /g, "")) assert.ok(glyphs.includes(ch), `нет глифа «${ch}» в «${text}»`)
    }
})

function spriteBox(img: FakeImage, base: FakeImage): { colours: Set<number>; top: number } {
    const colours = new Set<number>()
    let top = 120
    for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 160; x++) {
            if (img.getPixel(x, y) === base.getPixel(x, y)) continue
            colours.add(img.getPixel(x, y))
            top = Math.min(top, y)
        }
    }
    return { colours, top }
}

test("враги различаются: бес красный, стрелок рыже-бурый, рыцарь в сером доспехе, босс выше и шире беса", () => {
    const row = (ch: string) => c.createWorld(["#########", "#S...%..#", "#########"].map((r) => r.replace("%", ch)), 0)
    const still = (w: World) => { for (const e of w.enemies) e.awake = true; return w }
    const empty = frame(row("."), (v) => { v.mode = r.MODE_TITLE + 99 })
    const look = (ch: string) => spriteBox(frame(still(row(ch)), (v) => { v.mode = r.MODE_TITLE + 99 }), empty)
    const imp = look("E")
    const shooter = look("F")
    const knight = look("K")
    const boss = look("Z")
    assert.ok(imp.colours.has(2) || imp.colours.has(3), "бес красный")
    assert.equal(shooter.colours.has(2) || shooter.colours.has(3), false, `стрелок не красный: ${[...shooter.colours]}`)
    assert.ok(shooter.colours.has(5) || shooter.colours.has(10) || shooter.colours.has(11), `стрелок ${[...shooter.colours]}`)
    assert.ok(knight.colours.has(6) || knight.colours.has(7) || knight.colours.has(8), `рыцарь ${[...knight.colours]}`)
    assert.ok(boss.top < imp.top - 5, `босс ${boss.top}, бес ${imp.top}`)
    const sprites = art.ENEMY_ART as string[][][]
    assert.deepEqual(Array.from(sprites, (frames) => frames[0][0].length), [16, 16, 16, 24])
})

test("кадр боли со своего листа отличается от ходьбы", () => {
    const world = c.createWorld(["#######", "#S..E.#", "#######"], 0)
    const enemy = world.enemies[0]
    const shot = () => frame(world, (v) => { v.mode = r.MODE_TITLE + 99 }).pixels.join(",")
    const walking = shot()
    enemy.hurt = 100
    const hurt = shot()
    assert.notEqual(hurt, walking)
    assert.equal((art.ENEMY_ART as string[][][])[0].length, 8, "восемь кадров на вид")
})

test("огненный шар анимируется двумя кадрами по времени", () => {
    const world = c.createWorld(["#########", "#S......#", "#########"], 0)
    world.shots.push(new c.Shot(4 * 1024, 1024 + 512, -3000, 0))
    const shot = () => frame(world, (v) => { v.mode = r.MODE_TITLE + 99 }).pixels.join(",")
    world.time = 0
    const a = shot()
    world.time = 128
    const b = shot()
    world.time = 256
    assert.notEqual(a, b)
    assert.equal(shot(), a, "через два шага — снова первый кадр")
})

test("огненный шар виден в кадре на уровне груди", () => {
    const world = c.createWorld(["#########", "#S......#", "#########"], 0)
    const base = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    world.shots.push(new c.Shot(4 * 1024, 1024 + 512, -3000, 0))
    const img = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    const box = spriteBox(img, base)
    assert.ok(box.colours.has(1) && box.colours.has(4), `цвета ${[...box.colours]}`)
    assert.ok(box.top > 35 && box.top < 55, `верх шара ${box.top}`)
})

test("дробовик в руках рисуется шире пистолета", () => {
    const world = c.createWorld(["#####", "#S..#", "#####"], 0)
    const bare = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    const span = (img: FakeImage) => {
        let lo = 160
        let hi = -1
        for (let y = 60; y < 100; y++) {
            for (let x = 0; x < 160; x++) {
                if (img.getPixel(x, y) === bare.getPixel(x, y)) continue
                lo = Math.min(lo, x)
                hi = Math.max(hi, x)
            }
        }
        return hi - lo
    }
    const pistol = span(frame(world))
    world.weapon = c.WEAPON_SHOTGUN
    const shotgun = span(frame(world))
    assert.ok(shotgun > pistol + 8, `пистолет ${pistol}, дробовик ${shotgun}`)
})

test("смерть в четыре кадра: оседает и остаётся трупом", () => {
    const world = c.createWorld(["#######", "#S..E.#", "#######"], 0)
    const enemy = world.enemies[0]
    enemy.dead = true
    const shots = [0, 1, 2, 3, 10].map((k) => {
        enemy.deadMs = k * c.DIE_FRAME_MS
        return frame(world, (v) => { v.mode = r.MODE_TITLE + 99 }).pixels.join(",")
    })
    assert.equal(new Set(shots.slice(0, 4)).size, 4, "четыре разных кадра")
    assert.equal(shots[3], shots[4], "после анимации — неподвижный труп")
})

test("след крови виден на полу перед игроком", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const base = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    c.addDecal(world, 3 * 1024, 1024 + 512, c.DECAL_BLOOD)
    const img = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    const box = spriteBox(img, base)
    assert.ok(box.colours.has(2) || box.colours.has(3), `цвета ${[...box.colours]}`)
    assert.ok(box.top > 50, `след на полу, верх ${box.top}`)
})

test("пауза рисует своё меню поверх игры", () => {
    const world = c.createWorld(c.CAMPAIGN, 0)
    const play = frame(world)
    const paused = frame(world, (v) => { v.pause = new c.Pause(true, c.DIFF_NORMAL) })
    const moved = frame(world, (v) => { v.pause = new c.Pause(true, c.DIFF_NORMAL); v.pause.index = 3 })
    assert.notDeepEqual(paused.pixels, play.pixels)
    assert.notDeepEqual(paused.pixels, moved.pixels, "курсор паузы рисуется")
    assert.equal(paused.getPixel(13, 50), 6)
})

test("пол: пиксель под ногами берётся из нужного текселя по rowDist", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    world.x = 2 * 1024 + 300
    world.y = 1024 + 700
    const img = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    const floorRows = art.FLOOR as string[]
    const y = 95
    const d = Math.floor((50 * 1024) / (y - 50))
    const fx = world.x + ((d * 1024) >> 10)
    const fy = world.y
    const shade = Math.min(3, d >> 11)
    let colour = parseInt(floorRows[(fy >> 6) & 15][(fx >> 6) & 15], 16)
    for (let k = 0; k < shade; k++) colour = (art.DARKER as number[])[colour]
    assert.equal(img.getPixel(80, y), colour, `rowDist ${d}`)
})

test("горизонт пола сдвигается вместе с покачиванием", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const still = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    world.stride = c.STRIDE >> 1
    const bobbed = frame(world, (v) => { v.mode = r.MODE_TITLE + 99 })
    assert.ok(r.bobPhase(world) > 0)
    let shifted = 0
    for (let y = 60; y < 100; y++) if (still.getPixel(80, y) !== bobbed.getPixel(80, y)) shifted++
    assert.ok(shifted > 5, `сдвинулось строк ${shifted}`)
})

test("свет по клеткам: тёмная зона темнее, мигающая лампа меняется со временем", () => {
    const map = ["#########", "#S......#", "#########"]
    const bright = c.createWorld(map, 0)
    const dark = c.createWorld(map, 0)
    c.setLights(dark, [5, 0, 8, 2, 2])
    assert.equal(c.lightAt(dark, 6, 1), 2)
    assert.equal(c.lightAt(dark, 2, 1), 0)
    const a = frame(bright, (v) => { v.mode = r.MODE_TITLE + 99 })
    const b = frame(dark, (v) => { v.mode = r.MODE_TITLE + 99 })
    const lum = (img: FakeImage) => {
        let sum = 0
        for (let y = 40; y < 60; y++) {
            const rgb = (art.PALETTE as number[])[img.getPixel(80, y)]
            sum += ((rgb >> 16) & 255) + ((rgb >> 8) & 255) + (rgb & 255)
        }
        return sum
    }
    assert.ok(lum(b) < lum(a), `тёмная стена ${lum(b)} против ${lum(a)}`)

    const flick = c.createWorld(map, 0)
    c.setLights(flick, [1, 1, 7, 1, c.LIGHT_FLICKER])
    const seen = new Set<number>()
    for (let t = 0; t < 5000; t += 128) {
        flick.time = t
        seen.add(c.lightAt(flick, 4, 1))
    }
    assert.deepEqual([...seen].sort(), [0, 3])
})

test("лава светится на полу и видна даже на ступени полос", () => {
    const world = c.createWorld(["#######", "#S.LL.#", "#######"], 0)
    const plain = c.createWorld(["#######", "#S....#", "#######"], 0)
    const lavaish = (img: FakeImage) => {
        let n = 0
        for (let y = 55; y < 100; y++) for (let x = 40; x < 120; x++) if ([2, 4, 5].includes(img.getPixel(x, y))) n++
        return n
    }
    for (const q of [r.QUALITY_FULL, r.QUALITY_HALF, r.QUALITY_BANDS]) {
        const lit = frame(world, (v) => { v.mode = r.MODE_TITLE + 99; v.quality = q })
        const none = frame(plain, (v) => { v.mode = r.MODE_TITLE + 99; v.quality = q })
        assert.ok(lavaish(lit) > lavaish(none) + 50, `ступень ${q}: ${lavaish(lit)} против ${lavaish(none)}`)
    }
    const bands = frame(plain, (v) => { v.mode = r.MODE_TITLE + 99; v.quality = r.QUALITY_BANDS })
    const full = frame(plain, (v) => { v.mode = r.MODE_TITLE + 99; v.quality = r.QUALITY_FULL })
    assert.notDeepEqual(bands.pixels, full.pixels, "на полосах обычный пол не текстурируется")
})
