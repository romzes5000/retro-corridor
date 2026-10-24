import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type Input, type World } from "./load-logic.ts"
import { Pilot, fightingPilot, findPath, type Cell } from "./demo/pilot.ts"

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

    const shooter = new Pilot(api, [{ kind: "fire", imp: 0, ms: 3000 }])
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
