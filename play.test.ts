import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type Input, type World } from "./load-logic.ts"
import { Pilot, exitSpot, fightingPilot, findPath, planRoute, type Cell } from "./demo/pilot.ts"

const api = loadLogic()
const { FP, CAMPAIGN, createWorld, update } = api
const DT = 40
const EXIT_APPROACH: Cell = [14, 14]

function play(world: World, drive: (dt: number) => Input, ms: number, check: (w: World) => void = () => {}): string[] {
    const events: string[] = []
    for (let t = 0; t < ms && !world.won && !world.lost; t += DT) {
        update(world, drive(DT), DT)
        events.push(...world.events)
        check(world)
    }
    return events
}

function insideWall(world: World): boolean {
    return !api.fits(world, world.x, world.y, api.PLAYER_RADIUS - 1)
}

test("в кампании есть путь от старта до двери выхода", () => {
    const world = createWorld(CAMPAIGN, 0)
    const path = findPath(api, world, [world.x >> 10, world.y >> 10], EXIT_APPROACH)
    assert.ok(path.length > 10, `путь ${path.length}`)
    assert.equal(api.tileAt(world, EXIT_APPROACH[0] + 1, EXIT_APPROACH[1]), api.TILE_EXIT)
})

test("нажатиями крестовины карта проходится до выхода, ни разу не встав в стену", () => {
    const world = createWorld(CAMPAIGN.map((row) => row.replace(/E/g, ".")), 0)
    const pilot = new Pilot(api)
    pilot.route(world, EXIT_APPROACH)
    pilot.tasks.push({ kind: "face", ang: 0 }, { kind: "push", ms: 3000 })
    let ticks = 0
    const events = play(world, (dt) => pilot.next(world, dt), 120000, (w) => {
        ticks++
        assert.equal(insideWall(w), false, `в стене на тике ${ticks}: ${w.x},${w.y}`)
    })
    assert.equal(world.won, true)
    assert.ok(events.includes("win"))
    assert.ok(world.time < 40000, `шёл ${world.time} мс`)
})

test("кампания с бесами проходится живым: стрелять по тем, кто заметил", () => {
    const world = createWorld(CAMPAIGN, 0)
    const events = play(world, fightingPilot(api, world, EXIT_APPROACH, 0), 180000)
    assert.equal(world.lost, false, `погиб, здоровье ${world.health}`)
    assert.equal(world.won, true)
    assert.ok(world.kills >= 1, "по пути пришлось драться")
    assert.ok(events.includes("hurt") || events.includes("kill"))
})

test("бес подходит и кусает, два выстрела его убивают, потом проход свободен", () => {
    const world = createWorld(["##########", "#S.....E.#", "##########"], 0)
    const waited = play(world, () => new api.Input(), 5000)
    assert.ok(waited.includes("alert"))
    assert.ok(waited.includes("hurt"))
    assert.ok(world.health < 100)

    const shooter = new Pilot(api, [{ kind: "fire", enemy: 0, ms: 3000 }])
    const fought = play(world, (dt) => shooter.next(world, dt), 3000)
    assert.ok(fought.includes("kill"))
    assert.equal(world.kills, 1)
    assert.equal(world.score, 100)

    const walker = new Pilot(api, [{ kind: "goto", cell: [8, 1] }])
    play(world, (dt) => walker.next(world, dt), 6000)
    assert.equal(world.x >> 10, 8, "прошёл через место, где стоял бес")
})

test("стрейф с B сдвигает вбок без поворота", () => {
    const world = createWorld(["#####", "#...#", "#.S.#", "#...#", "#####"], 0)
    const strafe = new Pilot(api, [{ kind: "strafe", dir: 1, ms: 200 }])
    play(world, (dt) => strafe.next(world, dt), 200)
    assert.equal(world.ang, 0)
    assert.equal(world.x, 2 * FP + FP / 2)
    assert.ok(world.y > 2 * FP + FP / 2 + 300)
})

test("каждый уровень решается: ключ лежит до своей двери, выход заперт без ключей", () => {
    for (const level of api.LEVELS) {
        const world = createWorld(level.map, level.ang)
        const start: Cell = [world.x >> 10, world.y >> 10]
        const spot = exitSpot(api, world)
        assert.equal(api.tileAt(world, spot.cell[0] + 1, spot.cell[1]), api.TILE_EXIT, level.name)
        const route = planRoute(api, world, start, spot.cell)
        assert.ok(route, `${level.name}: маршрут есть`)
        assert.ok(level.map.length <= 24 && level.map[0].length <= 24, `${level.name}: до 24x24`)
        if (level.map.join("").includes("R")) {
            assert.equal(findPath(api, world, start, spot.cell, 0).length, 0, `${level.name}: без ключей не пройти`)
            assert.ok(route!.length > 1, `${level.name}: маршрут заходит за ключами`)
        }
    }
})

test("пилот проходит кампанию из трёх уровней подряд, запас переносится", () => {
    const session = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    const seen = new Set<string>()
    let more = true
    while (more) {
        const world = api.enterLevel(session)
        assert.equal(world.health, session.entryHealth)
        const events = play(world, fightingPilot(api, world), 300000)
        events.forEach((e) => seen.add(e))
        assert.equal(world.lost, false, `${api.levelName(session)}: погиб, здоровье ${world.health}`)
        assert.equal(world.won, true, `${api.levelName(session)}: не дошёл до выхода за ${world.time} мс`)
        more = api.completeLevel(session, world)
    }
    assert.equal(session.level, 3)
    for (const ev of ["key", "door", "weapon", "blast", "fireball", "unlock"]) assert.ok(seen.has(ev), `нет «${ev}» среди ${[...seen]}`)
    assert.ok(session.kills >= 3)
})
