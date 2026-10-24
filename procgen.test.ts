import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type Input, type World } from "./load-logic.ts"
import { exitSpot, fightingPilot, findPath, planRoute, type Cell } from "./demo/pilot.ts"

const api = loadLogic()
const SEEDS = 200
const ENEMY_MARKS = "EFKZ"

function play(world: World, drive: (dt: number) => Input, ms: number): string[] {
    const events: string[] = []
    for (let t = 0; t < ms && !world.won && !world.lost; t += 40) {
        api.update(world, drive(40), 40)
        events.push(...world.events)
    }
    return events
}

function cells(map: string[], marks: string): Cell[] {
    const out: Cell[] = []
    map.forEach((row, y) => [...row].forEach((ch, x) => marks.includes(ch) && out.push([x, y])))
    return out
}

test("генератор детерминирован: один seed — одна карта, разные seed — разные", () => {
    const a = api.generateLevel(7)
    const b = api.generateLevel(7)
    assert.deepEqual([...a.map], [...b.map])
    assert.deepEqual([...a.lights], [...b.lights])
    assert.equal(a.ang, b.ang)
    assert.notDeepEqual([...api.generateLevel(8).map], [...a.map])
    assert.equal(a.name, "DEPTH 7")
})

test("200 seed: карта 24x24 в стенах, один старт и выход, маршрут через ключи есть", () => {
    let keyed = 0
    let blue = 0
    let lava = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
        const level = api.generateLevel(seed)
        const map = [...level.map]
        assert.equal(map.length, api.GEN_SIZE, `seed ${seed}`)
        for (const row of map) assert.equal(row.length, api.GEN_SIZE, `seed ${seed}`)
        const flat = map.join("")
        assert.equal(flat.split("S").length - 1, 1, `seed ${seed}: один старт`)
        assert.equal(flat.split("X").length - 1, 1, `seed ${seed}: один выход`)
        for (let i = 0; i < api.GEN_SIZE; i++) {
            for (const ch of [map[0][i], map[api.GEN_SIZE - 1][i], map[i][0], map[i][api.GEN_SIZE - 1]]) {
                assert.ok(ch === "#" || ch === "X", `seed ${seed}: дыра в рамке «${ch}»`)
            }
        }

        const world = api.createWorld(map, level.ang)
        const start: Cell = [world.x >> 10, world.y >> 10]
        const spot = exitSpot(api, world)
        const route = planRoute(api, world, start, spot.cell)
        assert.ok(route, `seed ${seed}: маршрут до выхода есть\n${map.join("\n")}`)
        if (flat.includes("R")) {
            keyed++
            assert.ok(flat.includes("r"), `seed ${seed}: у красной двери есть ключ`)
            assert.equal(findPath(api, world, start, spot.cell, 0).length, 0, `seed ${seed}: без ключа не пройти`)
        }
        if (flat.includes("D")) {
            blue++
            assert.ok(flat.includes("b"), `seed ${seed}: у синей двери есть ключ`)
            assert.equal(findPath(api, world, start, spot.cell, 1).length, 0, `seed ${seed}: с одним красным не пройти`)
        }
        if (flat.includes("L")) lava++

        for (const [x, y] of cells(map, ENEMY_MARKS)) {
            assert.ok(Math.abs(x - start[0]) >= 3 || Math.abs(y - start[1]) >= 3, `seed ${seed}: враг в (${x},${y}) у старта`)
        }
    }
    assert.ok(keyed > SEEDS * 0.8, `уровней с ключом ${keyed}`)
    assert.ok(blue > SEEDS * 0.3, `уровней с синей дверью ${blue}`)
    assert.ok(lava > SEEDS * 0.5, `уровней с лавой ${lava}`)
})

test("глубина растит число врагов, босс на каждой пятой запирает выход", () => {
    const enemies = (d: number) => cells([...api.generateLevel(d).map], ENEMY_MARKS).length
    assert.ok(enemies(1) < enemies(9), `${enemies(1)} → ${enemies(9)}`)
    assert.ok(enemies(30) <= 15)
    const boss = api.createWorld([...api.generateLevel(5).map], 0)
    assert.equal(boss.exitLocked, true)
    assert.equal(api.createWorld([...api.generateLevel(4).map], 0).exitLocked, false)
    assert.ok([...api.generateLevel(2).map].join("").includes("G"), "дробовик на второй глубине")
})

test("бесконечный режим: глубина N — seed N, мир собирается со светом и запасом", () => {
    const session = api.startSession(api.RUN_ENDLESS, api.DIFF_NORMAL)
    assert.equal(api.levelCount(session), 0)
    const first = api.enterLevel(session)
    assert.deepEqual([...api.currentLevel(session).map], [...api.generateLevel(1).map])
    assert.equal(api.levelName(session), "DEPTH 1")
    assert.equal(first.health, 100)
    first.won = true
    assert.equal(api.completeLevel(session, first), true)
    assert.equal(api.levelName(session), "DEPTH 2")
    assert.deepEqual([...api.currentLevel(session).map], [...api.generateLevel(2).map])
    const lit = api.enterLevel(session)
    assert.ok(lit.light.some((v: number) => v > 0), "у комнат есть свет")
})

test("пилот проходит первые три глубины бесконечного режима подряд", () => {
    const session = api.startSession(api.RUN_ENDLESS, api.DIFF_NORMAL)
    const seen = new Set<string>()
    for (let depth = 1; depth <= 3; depth++) {
        const world = api.enterLevel(session)
        const events = play(world, fightingPilot(api, world), 300000)
        events.forEach((e) => seen.add(e))
        assert.equal(world.lost, false, `${api.levelName(session)}: погиб, здоровье ${world.health}`)
        assert.equal(world.won, true, `${api.levelName(session)}: не дошёл до выхода за ${world.time} мс`)
        assert.equal(api.completeLevel(session, world), true)
    }
    assert.equal(session.level, 3)
    assert.ok(seen.has("key") && seen.has("door"), `${[...seen]}`)
})
