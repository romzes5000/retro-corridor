import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type World } from "./load-logic.ts"

const api = loadLogic()
const { FP, createWorld, update } = api
const DT = 20

function run(world: World, ms: number, onTick: (t: number) => void = () => {}): Array<[string, number]> {
    const out: Array<[string, number]> = []
    for (let t = 0; t < ms && !world.lost; t += DT) {
        update(world, new api.Input(), DT)
        world.events.forEach((ev, i) => out.push([ev, world.eventDist[i]]))
        onTick(t)
    }
    return out
}

test("громкость по расстоянию: близко, средне, далеко", () => {
    assert.equal(api.soundLevel(0), 0)
    assert.equal(api.soundLevel(3 * FP - 1), 0)
    assert.equal(api.soundLevel(3 * FP), 1)
    assert.equal(api.soundLevel(7 * FP - 1), 1)
    assert.equal(api.soundLevel(7 * FP), 2)
})

test("события врагов несут расстояние до источника, выстрел игрока — ноль", () => {
    const world = createWorld(["############", "#S.......E.#", "############"], 0)
    const events = run(world, 200)
    const alert = events.find(([ev]) => ev === "alert")!
    assert.ok(Math.abs(alert[1] - 8 * FP) < 200, `дистанция alert ${alert[1]}`)
    const input = new api.Input()
    input.fire = true
    update(world, input, DT)
    const i = world.events.indexOf("shoot")
    assert.equal(world.eventDist[i], 0)
    assert.equal(world.eventDist.length, world.events.length)
})

test("бес на охоте за дверью рычит каждые 2–4 секунды, а на виду — нет", () => {
    const world = createWorld(["##########", "#S..R..E.#", "##########"], 0)
    const imp = world.enemies[0]
    imp.hunting = true
    imp.lastX = world.x
    imp.lastY = world.y
    const times: number[] = []
    run(world, 14000, (t) => { if (world.events.includes("growl")) times.push(t) })
    assert.ok(times.length >= 3 && times.length <= 7, `рыков ${times.length}`)
    for (let k = 1; k < times.length; k++) {
        const gap = times[k] - times[k - 1]
        assert.ok(gap >= 2000 - DT && gap <= 4000 + DT, `пауза ${gap}`)
    }

    const open = createWorld(["##########", "#S.....E.#", "##########"], 0)
    const seen = run(open, 6000)
    assert.equal(seen.some(([ev]) => ev === "growl"), false)
})

test("кровь и подпалины: кольцевой буфер на 24, старые следы вытесняются", () => {
    const world = createWorld(["#####", "#S.Z#", "#####"], 0)
    for (let i = 0; i < 10; i++) api.damageEnemy(world, 0, 1)
    assert.equal(world.decals.length, 10)
    assert.ok(world.decals.every((d) => d.kind === api.DECAL_BLOOD))
    const first = world.decals[0]
    for (let i = 0; i < 20; i++) api.damageEnemy(world, 0, 1)
    assert.equal(world.decals.length, api.DECALS_MAX)
    assert.equal(world.decalNext, 30 % api.DECALS_MAX)
    assert.notEqual(world.decals[0], first, "первый след перезаписан")

    const wall = createWorld(["######", "#S...#", "######"], 0)
    wall.shots.push(new api.Shot(3 * FP, FP + FP / 2, api.SHOT_SPEED, 0))
    run(wall, 800)
    assert.equal(wall.decals.length, 1)
    assert.equal(wall.decals[0].kind, api.DECAL_SCORCH)
    assert.ok(!api.solidAt(wall, wall.decals[0].x, wall.decals[0].y), "подпалина перед стеной, а не в ней")
})

test("убитый враг отсчитывает время смерти для анимации", () => {
    const world = createWorld(["#####", "#S.E#", "#####"], 0)
    api.damageEnemy(world, 0, 2)
    assert.equal(world.enemies[0].dead, true)
    assert.equal(world.enemies[0].deadMs, 0)
    run(world, 300)
    assert.equal(world.enemies[0].deadMs, 300)
})

test("долгий B без стрелок ставит паузу один раз, со стрелкой — стрейф, а не пауза", () => {
    const pad = new api.Pad()
    const input = new api.Input()
    const press = (now: number, right: boolean, b: boolean) =>
        api.readPad(pad, input, now, false, false, false, right, false, b)
    const longs: number[] = []
    for (let t = 0; t <= 1200; t += 20) {
        press(t, false, true)
        if (pad.longB) longs.push(t)
    }
    assert.deepEqual(longs, [api.PAUSE_HOLD_MS])
    press(1220, false, false)
    for (let t = 1240; t < 1700; t += 20) {
        press(t, false, false)
        assert.equal(pad.tapB, false, "после долгого B карта не открывается")
    }

    for (let t = 2000; t <= 3000; t += 20) {
        press(t, t > 2100, true)
        assert.equal(pad.longB, false)
    }
})

test("меню паузы: стрелки, музыка, сложность, продолжить и выход", () => {
    const pause = new api.Pause(true, api.DIFF_NORMAL, false)
    const pad = new api.Pad()
    const step = (dirs: number, a = false, b = false) => {
        pad.tapDirs = dirs
        pad.tapA = a
        pad.tapB = b
        pad.longB = false
        return api.pauseStep(pause, pad)
    }
    assert.equal(step(0, true), api.PACT_RESUME)
    step(api.DIR_DOWN)
    assert.equal(step(0, true), api.PACT_NONE)
    assert.equal(pause.music, false)
    step(api.DIR_RIGHT)
    assert.equal(pause.music, true)
    step(api.DIR_DOWN)
    step(api.DIR_RIGHT)
    assert.equal(pause.difficulty, api.DIFF_HARD)
    step(api.DIR_LEFT)
    step(api.DIR_LEFT)
    assert.equal(pause.difficulty, api.DIFF_EASY)
    step(api.DIR_DOWN)
    assert.equal(step(api.DIR_RIGHT), api.PACT_NONE, "стрелки на пункте пилота ничего не делают")
    assert.equal(step(0, true), api.PACT_PILOT)
    step(api.DIR_DOWN)
    assert.equal(step(0, true), api.PACT_QUIT)
    step(api.DIR_DOWN)
    assert.equal(pause.index, api.PAUSE_RESUME, "курсор по кругу")
    assert.equal(step(0, false, true), api.PACT_RESUME, "B закрывает паузу")
})

test("рекорды: лучшее время кампании по сложности, глубина и очки, запись в хранилище", () => {
    const store = new Map<string, number>([["rc_time_normal", 300000], ["rc_score", 500]])
    const rec = api.loadRecords((k) => store.get(k) ?? 0)
    assert.deepEqual([...rec.time], [0, 300000, 0])

    const run1 = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    run1.level = 2
    run1.time = 100000
    run1.score = 100
    assert.equal(api.noteRun(rec, run1), false, "кампания не пройдена — время не пишется")

    run1.level = 3
    assert.equal(api.noteRun(rec, run1), true)
    assert.equal(rec.time[api.DIFF_NORMAL], 100000)
    run1.time = 200000
    assert.equal(api.noteRun(rec, run1), false, "медленнее — не рекорд")

    const hard = api.startSession(api.RUN_CAMPAIGN, api.DIFF_HARD)
    hard.level = 3
    hard.time = 400000
    hard.score = 900
    assert.equal(api.noteRun(rec, hard), true)
    assert.equal(rec.time[api.DIFF_HARD], 400000)
    assert.equal(rec.score, 900)

    const shortcut = api.startAtLevel(api.DIFF_NORMAL, 2)
    shortcut.level = 3
    shortcut.time = 30000
    assert.equal(api.noteRun(rec, shortcut), false, "старт с арены — не полная кампания")
    assert.equal(rec.time[api.DIFF_NORMAL], 100000)

    const endless = api.startSession(api.RUN_ENDLESS, api.DIFF_NORMAL)
    endless.level = 5
    assert.equal(api.noteRun(rec, endless), true)
    assert.equal(rec.depth, 5)

    api.saveRecords(rec, (k, v) => store.set(k, v))
    assert.equal(store.get("rc_time_normal"), 100000)
    assert.equal(store.get("rc_time_hard"), 400000)
    assert.equal(store.get("rc_depth"), 5)
    assert.deepEqual([...api.recordLines(rec)], ["EASY -", "NORMAL 1:40", "HARD 6:40", "DEPTH 5", "SCORE 900"])
})

test("сложность: лёгкая — меньше врагов и урона, тяжёлая — больше, босс и старт не трогаются", () => {
    const level = api.LEVELS[2]
    const count = (d: number) => {
        const w = createWorld(level.map, level.ang)
        api.applyDifficulty(w, d)
        return w
    }
    const easy = count(api.DIFF_EASY)
    const normal = count(api.DIFF_NORMAL)
    const hard = count(api.DIFF_HARD)
    assert.ok(easy.total < normal.total && normal.total < hard.total, `${easy.total} < ${normal.total} < ${hard.total}`)
    assert.equal(easy.total, easy.enemies.length)
    for (const w of [easy, normal, hard]) assert.equal(w.enemies.filter((e) => e.kind === api.ENEMY_BOSS).length, 1)
    for (const e of hard.enemies) {
        const far = Math.abs((e.x >> 10) - (hard.x >> 10)) >= 3 || Math.abs((e.y >> 10) - (hard.y >> 10)) >= 3
        assert.ok(far, "никого в 3 клетках от старта")
        assert.notEqual(api.tileAt(hard, e.x >> 10, e.y >> 10), api.TILE_STONE)
    }

    const bite = (d: number) => {
        const w = createWorld(["#####", "#SE.#", "#####"], 0)
        api.applyDifficulty(w, d)
        run(w, 300)
        return 100 - w.health
    }
    assert.equal(bite(api.DIFF_EASY), 6)
    assert.equal(bite(api.DIFF_NORMAL), 12)
    assert.equal(bite(api.DIFF_HARD), 18)

    const s = api.startSession(api.RUN_CAMPAIGN, api.DIFF_EASY)
    assert.equal(api.enterLevel(s).difficulty, api.DIFF_EASY, "сессия передаёт сложность уровню")
})
