// Map for the live page: the level grid with doors, items, lava and exit; the overlay with the
// player, the route the bridge follows, and only the enemies the player sees or saw lately.
import assert from "node:assert/strict"
import test from "node:test"
import { loadGame, type World } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { LivePlayer } from "./live.ts"
import { Bridge } from "./loop.ts"
import { levelMap, LiveMap, mapOverlay, routeOf, type Route } from "./map.ts"
import { inSight, MEMORY_MS, Memory } from "./memory.ts"
import { situate, type Situation } from "./observe.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { findPath, type Cell } from "./route.ts"
import { levelIndex, SimConsole } from "./sim.ts"

const game = loadGame()
const api = game.corridor
const RUN = 7

function level(index: number): World {
    return api.enterLevel(api.startAtLevel(api.DIFF_NORMAL, index))
}

const keyOf = (world: World, lvl = "0") => `${RUN}:${lvl}:${api.mapHash(world)}`
const snapAt = (world: World, t: number, lvl = "0") => ({ run: RUN, lvl, hash: api.mapHash(world), t }) as Snapshot
const centre = (c: Cell) => [c[0] * api.FP + api.FP / 2, c[1] * api.FP + api.FP / 2]
const place = (o: { x: number; y: number }, c: Cell) => ([o.x, o.y] = centre(c))

test("карта: HANGAR — стены, обычные двери, выход, предметы по клеткам", () => {
    const world = level(0)
    const map = levelMap(api, world, 3, "HANGAR")
    assert.deepEqual([map.seg, map.level, map.w, map.h, map.rows.length], [3, "HANGAR", 16, 16, 16])
    assert.equal(map.rows[0], "################")
    assert.equal(map.rows[1], "#...#..........#", "старт и аптечка — пол")
    assert.equal(map.rows[14][15], "E")
    assert.equal(map.rows[4][2], "D")
    assert.equal(map.rows[10][10], "#", "секретная стена не выдаёт себя")
    assert.deepEqual(map.doors.map((d) => [d.x, d.y, d.key]), [[2, 4, "plain"], [9, 8, "plain"]])
    assert.equal(map.items.length, world.items.length)
    assert.ok(map.items.some((it) => it.x === 9 && it.y === 1 && it.kind === "medkit"))
    assert.ok(map.items.some((it) => it.x === 2 && it.y === 3 && it.kind === "ammo"))
})

test("карта: цветные двери и ключи WAREHOUSE, лава ARENA", () => {
    const world = level(1)
    const map = levelMap(api, world, 1, "WAREHOUSE")
    assert.ok(map.doors.some((d) => d.x === 6 && d.y === 7 && d.key === "red"))
    assert.ok(map.doors.some((d) => d.x === 16 && d.y === 5 && d.key === "blue"))
    assert.ok(map.items.some((it) => it.x === 18 && it.y === 1 && it.kind === "red key"))
    assert.ok(map.items.some((it) => it.x === 10 && it.y === 8 && it.kind === "blue key"))
    assert.ok(map.items.some((it) => it.x === 4 && it.y === 1 && it.kind === "shotgun"))
    assert.equal(map.rows[13][19], "E")
    const arena = level(2)
    let lava = 0
    for (let y = 0; y < arena.h; y++) for (let x = 0; x < arena.w; x++) if (api.lavaAt(arena, x, y)) lava++
    const rows = levelMap(api, arena, 1, "ARENA").rows.join("")
    assert.ok(lava > 0)
    assert.equal([...rows].filter((c) => c === "~").length, lava)
})

// The bridge's own pick of goal and path lives in observe.ts; here a known situation is mapped.
function heading(world: World, memory: Memory, over: Record<string, unknown>): Situation {
    return { ...situate(api, world, memory), ...over } as Situation
}

test("маршрут: цель, клетка цели и путь из ситуации моста; оверлей обрезает пройденное и не рисует маршрут с другой карты", () => {
    const world = level(0)
    const memory = new Memory()
    memory.observe("a", api, world, 0)
    const path: Cell[] = [...findPath(api, world, [1, 1], [14, 14]), [15, 14]]
    const sit = heading(world, memory, { goal: "exit", goalCell: [14, 14], path })
    const route = routeOf(api, world, sit, memory, keyOf(world))
    assert.deepEqual([route.goal, route.what, route.goalCell, route.path], ["exit", "exit", [14, 14], path])
    let o = mapOverlay(api, world, 1, snapAt(world, 0), route)
    assert.deepEqual(o.goal, { kind: "exit", cell: [14, 14], what: "exit" })
    assert.deepEqual(o.path, path)
    assert.deepEqual([o.player.x, o.player.y], [1.5, 1.5])
    assert.ok(Math.abs(Math.hypot(...o.player.dir) - 1) < 0.02, "направление взгляда — единичный вектор")
    place(world, path[3])
    o = mapOverlay(api, world, 1, snapAt(world, 0), route)
    assert.deepEqual(o.path[0], path[3])
    assert.equal(o.path.length, path.length - 3)
    place(world, [3, 3])
    assert.deepEqual(mapOverlay(api, world, 1, snapAt(world, 0), route).path, path, "сошёл с пути — путь целиком")
    const other = mapOverlay(api, world, 1, snapAt(world, 0, "1"), route)
    assert.deepEqual([other.goal, other.path], [null, []], "маршрут с другой карты не рисуется")
})

test("маршрут: подписи целей — цвет ключа, выход, разведка, босс виден, видели недавно, раньше, место появления, неизвестно", () => {
    const world = level(1)
    const memory = new Memory()
    const what = (over: Record<string, unknown>) => routeOf(api, world, heading(world, memory, over), memory, keyOf(world, "1")).what
    assert.equal(what({ goal: "key", goalCell: [18, 1] }), "red key")
    assert.equal(what({ goal: "key", goalCell: [10, 8] }), "blue key")
    assert.equal(what({ goal: "exit", goalCell: [18, 13] }), "exit")
    assert.equal(what({ goal: "explore", goalCell: [5, 5] }), "unexplored area")
    assert.equal(what({ goal: "none", goalCell: null }), "none")
    assert.equal(what({ goal: "boss", bossSeen: true }), "boss")
    assert.equal(what({ goal: "boss", bossSeen: false, bossSource: "seen" }), "boss, last seen")
    assert.equal(what({ goal: "boss", bossSeen: false, bossSource: "earlier" }), "boss, seen before")
    assert.equal(what({ goal: "boss", bossSeen: false, bossSource: "spawn" }), "boss spawn")
    assert.equal(what({ goal: "boss", bossSeen: false, bossSource: "" }), "boss")
})

test("враги: невидимых нет, видимый есть, недавно виденный — в памяти со своей клеткой и уходит через MEMORY_MS", () => {
    const world = level(0)
    const memory = new Memory()
    const key = keyOf(world)
    const unseen = world.enemies.map((e, i) => ({ e, i })).filter(({ e }) => !inSight(api, world, e.x, e.y))
    assert.equal(unseen.length, world.enemies.length, "со старта HANGAR не видно ни одного врага")
    memory.observe("a", api, world, 0)
    let o = mapOverlay(api, world, 1, snapAt(world, 0), routeOf(api, world, situate(api, world, memory), memory, key))
    assert.deepEqual([o.enemies, o.remembered], [[], []])

    const imp = world.enemies[0]
    const spawn: Cell = [imp.x >> 10, imp.y >> 10]
    place(imp, [3, 1])
    memory.observe("a", api, world, 1000)
    o = mapOverlay(api, world, 1, snapAt(world, 1000), routeOf(api, world, situate(api, world, memory), memory, key))
    assert.deepEqual(o.enemies, [{ i: 0, kind: "imp", x: 3.5, y: 1.5 }])
    assert.deepEqual(o.remembered, [])

    place(imp, spawn)
    assert.ok(!inSight(api, world, imp.x, imp.y))
    memory.observe("a", api, world, 2000)
    const route = routeOf(api, world, situate(api, world, memory), memory, key)
    assert.deepEqual(route.remembered, [{ i: 0, kind: "imp", x: 3.5, y: 1.5, at: 1000 }])
    o = mapOverlay(api, world, 1, snapAt(world, 2000), route)
    assert.deepEqual(o.enemies, [], "ушёл из вида — на карте не там, где он сейчас")
    assert.deepEqual(o.remembered, [{ i: 0, kind: "imp", x: 3.5, y: 1.5, ago: 1 }])
    assert.deepEqual(mapOverlay(api, world, 1, snapAt(world, 1000 + MEMORY_MS + 1), route).remembered, [])
    imp.dead = true
    assert.deepEqual(mapOverlay(api, world, 1, snapAt(world, 2000), route).remembered, [], "убитый не вспоминается")
})

test("оверлей: двери закрыта, заперта, открыта, в движении; подобранные предметы; огненный шар только в зоне видимости", () => {
    const world = level(1)
    const red = world.doors.findIndex((d: any) => d.cx === 6 && d.cy === 7)
    const snap = snapAt(world, 0, "1")
    assert.equal(mapOverlay(api, world, 1, snap, null).doors[red], "locked")
    world.keys = 1
    assert.equal(mapOverlay(api, world, 1, snap, null).doors[red], "closed")
    world.doors[red].state = api.DOOR_OPENING
    assert.equal(mapOverlay(api, world, 1, snap, null).doors[red], "moving")
    world.doors[red].state = api.DOOR_OPEN
    assert.equal(mapOverlay(api, world, 1, snap, null).doors[red], "open")
    world.items[2].taken = true
    assert.deepEqual(mapOverlay(api, world, 1, snap, null).taken.map((t, i) => t && i), Array.from(world.items, (_, i) => i === 2 && 2))
    const [nx, ny] = centre([4, 2])
    const [fx, fy] = centre([10, 8])
    world.shots = [new api.Shot(nx, ny, 0, 0), new api.Shot(fx, fy, 0, 0)]
    assert.ok(inSight(api, world, nx, ny) && !inSight(api, world, fx, fy))
    assert.deepEqual(mapOverlay(api, world, 1, snap, null).shots, [{ x: 4.5, y: 2.5 }])
})

function snapshots(sim: SimConsole): Snapshot[] {
    const parser = new Parser()
    const out: Snapshot[] = []
    sim.onLine((line) => {
        const msg = parser.line(line)
        if (msg?.kind === "snapshot") out.push(msg.snap)
    })
    return out
}

test("живая карта: одна карта на попытку, новая — после конца попытки даже на той же карте; оверлей с её номером", () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, RUN)
    const snaps = snapshots(sim)
    while (snaps.length < 3) sim.step()
    const live = new LivePlayer(game, () => 0)
    const map = new LiveMap(api, live)
    assert.equal(map.map(), null)
    live.push({ k: "s", snap: snaps[0] })
    live.push({ k: "s", snap: snaps[1] })
    const first = map.map()
    assert.equal(first?.level, "HANGAR")
    assert.equal(map.map(), first, "та же попытка — тот же объект")
    assert.equal(map.overlay()?.seg, first?.seg)
    live.push({ k: "end", t: snaps[1].t, result: "dead" })
    live.push({ k: "s", snap: snaps[2] })
    const second = map.map()
    assert.ok(second && first && second.seg === first.seg + 1)
    assert.equal(map.overlay()?.seg, second.seg)
})

test("мост: маршрут последнего решения — ключ карты, цель и связный путь от клетки игрока до цели; после смерти пусто", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, RUN)
    const snaps = snapshots(sim)
    const bridge = new Bridge(sim.api, sim, fakeJev, () => {}, () => sim.clock)
    const current = (): Route | null => bridge.route
    assert.equal(current(), null)
    while (!current()) sim.step()
    await bridge.idle()
    const route = current() as Route
    assert.equal(route.key, `${RUN}:${snaps[0].lvl}:${snaps[0].hash}`)
    assert.ok(route.goalCell && route.path.length > 1, "на старте HANGAR есть куда идти")
    assert.deepEqual(route.path[0], [snaps[0].x >> 10, snaps[0].y >> 10])
    assert.deepEqual(route.goal === "exit" ? route.path.at(-2) : route.path.at(-1), route.goalCell)
    assert.ok(route.what !== "" && route.what !== "none")
    route.path.slice(1).forEach((c, i) => assert.equal(Math.abs(c[0] - route.path[i][0]) + Math.abs(c[1] - route.path[i][1]), 1))
    bridge.line("AI DEAD")
    assert.equal(current(), null)
})
