import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic } from "./load-logic.ts"
import { findPath } from "./bridge/route.ts"

const api = loadLogic()
const { createWorld, update } = api

function stand(world: ReturnType<typeof createWorld>, ms: number): string[] {
    const events: string[] = []
    for (let t = 0; t < ms && !world.lost; t += 20) {
        update(world, new api.Input(), 20)
        events.push(...world.events)
    }
    return events
}

test("лава жжёт 5 HP в секунду, первый ожог сразу после шага, вне лавы — ничего", () => {
    const world = createWorld(["#####", "#SL.#", "#####"], 0)
    assert.equal(api.lavaAt(world, 2, 1), true)
    assert.equal(api.tileAt(world, 2, 1), api.TILE_FLOOR, "по лаве можно ходить")
    stand(world, 2000)
    assert.equal(world.health, 100)

    world.x = 2 * 1024 + 512
    stand(world, api.LAVA_FIRST_MS + 20)
    assert.equal(world.health, 100 - api.LAVA_DAMAGE)
    stand(world, 2000)
    assert.equal(world.health, 100 - 3 * api.LAVA_DAMAGE)

    world.x = 3 * 1024 + 512
    stand(world, 2000)
    assert.equal(world.health, 100 - 3 * api.LAVA_DAMAGE, "сошёл с лавы — не жжёт")
})

test("уровни: у каждого есть слой света, на арене лава, пилот её обходит", () => {
    for (const level of api.LEVELS) {
        assert.ok(level.lights.length >= 10 && level.lights.length % 5 === 0, level.name)
        const world = api.enterLevel(Object.assign(api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), { level: api.LEVELS.indexOf(level) }))
        assert.ok(world.light.some((l: number) => l > 0), `${level.name}: есть тёмные клетки`)
        assert.ok(world.light.includes(api.LIGHT_FLICKER), `${level.name}: есть мигающая лампа`)
    }
    const arena = createWorld(api.LEVELS[2].map, 0)
    assert.ok(arena.lava.filter((v: number) => v === 1).length >= 4)

    const world = createWorld(["#####", "#SLX#", "#...#", "#####"], 0)
    const path = findPath(api, world, [1, 1], [3, 2])
    assert.ok(path.length > 0)
    assert.ok(!path.some(([x, y]) => api.lavaAt(world, x, y)), "путь мимо лавы")
})
