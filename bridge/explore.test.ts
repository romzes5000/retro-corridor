// Fog of war: the bridge knows only the cells the player has seen, plans over them, explores the
// frontier when the goal is not among them, and keeps the explored map across attempts.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { loadLogic, type World } from "../load-logic.ts"
import { decide } from "./decide.ts"
import { BEYOND, KnownMap, knownWorld, nearestFrontier, STALE_MS, visibleCells } from "./explore.ts"
import { fakeJev } from "./fake-jev.ts"
import type { JevFn } from "./jev.ts"
import { Bridge, type LogRecord } from "./loop.ts"
import { CMD } from "./mailbox.ts"
import { mapOverlay, MAP_PANEL, MAP_SCRIPT, routeOf } from "./map.ts"
import { Memory } from "./memory.ts"
import { facts, situate } from "./observe.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { exitSpot, findPath, planRoute, type Cell } from "./route.ts"
import { Shadow } from "./shadow.ts"
import { levelIndex, SimConsole, simLevels } from "./sim.ts"

const api = loadLogic()
const FP = 1024
const centre = (c: number) => c * FP + FP / 2
const seenSet = (world: World) => new Set(visibleCells(api, world).map(([x, y]) => `${x},${y}`))

function place(world: World, c: Cell, ang = world.ang): void {
    world.x = centre(c[0])
    world.y = centre(c[1])
    world.ang = ang
}

function knownOf(world: World, cells: Cell[]): KnownMap {
    const known = new KnownMap()
    known.reset("t", world.w, world.h)
    for (const [x, y] of cells) known.mark(x, y)
    return known
}

class FakeTransport {
    private listener: (line: string) => void = () => {}
    onLine(l: (line: string) => void): void {
        this.listener = l
    }
    async writeBox(): Promise<void> {}
    reset(): void {}
    send(lines: string[]): void {
        for (const l of lines) this.listener(l)
    }
}

test("зрение: лучи видят коридор впереди до стены, но не за ней и не за спиной", () => {
    const world = api.createWorld(["#########", "#...S.#.#", "#########"], 0)
    const seen = seenSet(world)
    for (const c of ["5,1", "6,1"]) assert.ok(seen.has(c), c)
    assert.ok(!seen.has("7,1"), "за стеной")
    assert.ok(!seen.has("2,1") && !seen.has("1,1"), "за спиной")
    const known = new KnownMap()
    known.reset("t", world.w, world.h)
    known.see(api, world)
    assert.ok(known.knows(3, 1), "соседняя клетка сзади известна")
    assert.ok(!known.knows(2, 1))
    assert.equal(known.rows(api, world)[1], "???...#??")
})

test("зрение: закрытая дверь заслоняет; открытая на приставке открыта и в теневом мире", () => {
    const world = api.createWorld(["#########", "#S.|...X#", "#########"], 0)
    assert.ok(!seenSet(world).has("5,1"), "закрытая дверь")
    world.doors[0].state = api.DOOR_OPEN
    world.doors[0].progress = api.FP
    assert.ok(seenSet(world).has("5,1"), "открытая дверь")

    const { world: hangarWorld, link } = hangar(3)
    const door = hangarWorld.doors.findIndex((d: any) => d.cx === 2 && d.cy === 4)
    place(hangarWorld, [2, 3], 256)
    const behind = `2,${[5, 6, 7].find((y) => api.tileAt(hangarWorld, 2, y) === api.TILE_FLOOR)}`
    assert.ok(!seenSet(hangarWorld).has(behind))
    hangarWorld.doors[door].state = api.DOOR_OPEN
    const parser = new Parser()
    let snap: Snapshot | null = null
    for (const line of api.aiSnapshot(link, hangarWorld, api.DIFF_NORMAL) as string[]) {
        const msg = parser.line(line)
        if (msg?.kind === "snapshot") snap = msg.snap
    }
    assert.ok(snap)
    const copy = new Shadow(api).sync(snap)
    assert.ok(copy)
    assert.equal(copy.doors[door].progress, api.FP, "в снимке только state — progress выводится из него")
    assert.ok(seenSet(copy).has(behind), "мост видит сквозь открытую дверь")
})

test("известный мир: невиданные клетки — стена, предметы и лава в них не видны; клетка игрока всегда известна", () => {
    const world = api.createWorld(["#########", "#S..H..X#", "#########"], 0)
    const known = knownOf(world, [[2, 1]])
    const map = knownWorld(api, world, known)
    assert.equal(api.tileAt(map, 3, 1), api.TILE_STONE)
    assert.equal(api.tileAt(map, 7, 1), api.TILE_STONE, "выход не виден")
    assert.equal(api.tileAt(map, 1, 1), api.TILE_FLOOR, "клетка игрока")
    assert.equal(map.items.length, 0, "аптечку не видели")
    assert.equal(api.tileAt(world, 7, 1), api.TILE_EXIT, "живой мир не тронут")
})

test("планировщик: через неизвестные клетки пути нет, ни к выходу, ни за ключом", () => {
    const world = api.createWorld(["#######", "#S.R.X#", "##.####", "##r####", "#######"], 0)
    const map = knownWorld(api, world, knownOf(world, [[1, 1], [2, 1], [3, 1], [4, 1]]))
    assert.deepEqual(findPath(api, map, [1, 1], [4, 1], api.KEY_RED), [[1, 1], [2, 1], [3, 1], [4, 1]])
    assert.deepEqual(findPath(api, map, [1, 1], [2, 3], 0), [], "ключ в неизвестной нише")
    assert.equal(planRoute(api, map, [1, 1], [4, 1]), null, "за красную дверь без виденного ключа не спланировать")
    const full = knownWorld(api, world, knownOf(world, Array.from({ length: world.w * world.h }, (_, i) => [i % world.w, Math.floor(i / world.w)] as Cell)))
    assert.deepEqual(planRoute(api, full, [1, 1], [4, 1]), [[2, 3], [4, 1]], "всё видно — ключ, потом дверь")
})

test("цель: выход за поворотом неизвестен — разведка без позиции выхода в фактах; увидел — идёт к выходу", () => {
    const world = api.createWorld(["########", "#S....##", "#####.##", "#####X##", "########"], 0)
    assert.deepEqual(exitSpot(api, world).cell, [5, 2])
    const memory = new Memory()
    memory.observe("t", api, world, 0)
    const sit = situate(api, world, memory)
    assert.equal(sit.goal, "explore")
    const state = facts(api, world, sit, [])
    assert.match(String(state.goal), /^exploring: exit not found yet, unexplored area \d+ steps away$/)
    assert.doesNotMatch(JSON.stringify(state), /reach the exit|exit is right ahead|exit route/)
    assert.equal(decide(api, world, sit, "advance").cmd, CMD.goto, "разведка — шаг, не стоянка")
    place(world, [5, 1], 256)
    memory.observe("t", api, world, 1000)
    const seen = situate(api, world, memory)
    assert.equal(seen.goal, "exit")
    assert.match(String(facts(api, world, seen, []).goal), /exit/)
})

test("фронтир: ближайший с учётом поворота, удержание цели, прогноз цель не двигает, шаг за край", () => {
    const world = api.createWorld(["#########", "#.......#", "#########"], 0)
    const walls: Cell[] = Array.from({ length: world.w * 2 }, (_, i) => [i % world.w, i < world.w ? 0 : 2])
    const cells: Cell[] = [...walls, [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]]
    place(world, [4, 1], 0)
    let known = knownOf(world, cells)
    let f = nearestFrontier(api, knownWorld(api, world, known), known, [4, 1])
    assert.deepEqual(f?.cell, [6, 1], "впереди дешевле, чем разворот")
    assert.deepEqual(f?.beyond, [[7, 1]].slice(0, BEYOND), "в темноту за край")
    assert.deepEqual(known.target, [6, 1])
    place(world, [4, 1], 512)
    f = nearestFrontier(api, knownWorld(api, world, known), known, [4, 1])
    assert.deepEqual(f?.cell, [6, 1], "уже выбранную цель держит: разница не больше двух шагов")
    known = knownOf(world, cells)
    f = nearestFrontier(api, knownWorld(api, world, known), known, [4, 1], false)
    assert.deepEqual(f?.cell, [2, 1], "лицом на запад — запад")
    assert.equal(known.target, null, "без commit цель не запоминается")
    const all = knownOf(world, Array.from({ length: world.w * world.h }, (_, i) => [i % world.w, Math.floor(i / world.w)] as Cell))
    assert.equal(nearestFrontier(api, knownWorld(api, world, all), all, [4, 1]), null, "всё изучено")
})

test("босс не найден и всё изучено: стоит, пока клетки свежие; через STALE_MS идёт осмотреть давно не виденное", () => {
    const world = api.createWorld(["#########", "#S......#", "###|#####", "#...Z...#", "#########"], 0)
    world.exitLocked = true
    const memory = new Memory()
    memory.observe("t", api, world, 0)
    for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) memory.known.mark(x, y)
    memory.observe("t", api, world, 5000)
    let sit = situate(api, world, memory)
    assert.deepEqual([sit.goal, sit.bossSeen], ["none", false])
    assert.equal(facts(api, world, sit, []).goal, "boss not found, nothing left to explore")
    memory.observe("t", api, world, 5000 + STALE_MS)
    sit = situate(api, world, memory)
    assert.equal(sit.goal, "explore")
    assert.ok(sit.recheckMs >= STALE_MS)
    assert.match(String(facts(api, world, sit, []).goal), /^boss not in sight and the map is explored: look again at an area last seen \d+ s ago, \d+ steps away$/)
    assert.equal(routeOf(api, world, sit, memory, "k").what, "area to look again")
    assert.notEqual(decide(api, world, sit, "advance").cmd, CMD.wait)
})

test("карта: часы приставки пошли назад — виденное считается давним; JSON сохраняет клетки и босса", () => {
    const world = api.createWorld(["#####", "#S..#", "#####"], 0)
    const known = new KnownMap()
    known.reset("1:7", world.w, world.h)
    known.see(api, world, 100000)
    known.boss = [2, 1]
    assert.equal(known.ageMs(2, 1, 100000), 0)
    world.ang = 512
    known.see(api, world, 50)
    assert.ok(known.ageMs(3, 1, 50) > STALE_MS, "после перезагрузки приставки")
    assert.equal(known.ageMs(3, 3, 50), Infinity, "вне карты — никогда")
    const copy = KnownMap.fromJSON(JSON.parse(JSON.stringify(known)))
    assert.deepEqual([copy.key, copy.count(), copy.boss], ["1:7", known.count(), [2, 1]])
})

// HANGAR as the console runs it.
function hangar(run: number): { world: World; link: any } {
    const session = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    const world = api.enterLevel(session)
    for (const e of world.enemies) e.dead = true
    const link = new api.AiLink(run)
    api.aiEnterLevel(link, api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), world)
    return { world, link }
}

async function attempts(mapMemory: boolean | undefined): Promise<number[]> {
    const { world, link } = hangar(31)
    const transport = new FakeTransport()
    const wait: JevFn = async () => ({ action: "wait", confidence: 1, danger: null, cost: 0, latencyMs: 0, error: "" })
    const bridge = new Bridge(api, transport, wait, () => {}, () => link.clock, 1, mapMemory === undefined ? {} : { mapMemory })
    const counts: number[] = []
    const look = async (c: Cell, ang: number) => {
        place(world, c, ang)
        link.clock += 250
        transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
        await bridge.idle()
    }
    await look([1, 1], 0)
    await look([5, 1], 0)
    counts.push(bridge.known.count())
    transport.send(["AI DEAD"])
    await look([1, 1], 0)
    counts.push(bridge.known.count())
    return counts
}

test("память карты: по умолчанию изученное остаётся на следующую попытку, с mapMemory: false — заново", async () => {
    const [explored, kept] = await attempts(undefined)
    assert.ok(kept >= explored, `${explored} -> ${kept}`)
    const [explored2, fresh] = await attempts(false)
    assert.equal(explored2, explored)
    assert.ok(fresh < explored2, `после смерти карта с нуля: ${explored2} -> ${fresh}`)
})

test("перехват: клетки, которые видел только человек, в карту ИИ не попадают", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    const bridge = new Bridge(sim.api, sim, fakeJev, () => {}, () => sim.clock, 100)
    const run = async (ms: number, each?: () => void) => {
        for (let t = 0; t < ms && !sim.result; t += 20) {
            sim.step()
            each?.()
            await bridge.idle()
        }
    }
    await run(2000)
    const before = new Set(bridge.known.toJSON().seen.split("").flatMap((v, i) => (v === "1" ? [i] : [])))
    const walk = new sim.api.Input()
    walk.turn = 1
    sim.takeOver(walk)
    const human = new Set<number>()
    await run(1500, () => {
        for (const [x, y] of visibleCells(api, sim.world)) human.add(y * sim.world.w + x)
    })
    assert.equal(bridge.known.count(), before.size, "пока играет человек, карта не растёт")
    sim.handBack()
    await run(60)
    const now = new Set(visibleCells(api, sim.world).map(([x, y]) => y * sim.world.w + x))
    const onlyHuman = [...human].filter((i) => !before.has(i) && !now.has(i))
    assert.ok(onlyHuman.length > 0, "человек видел что-то своё")
    const leaked = onlyHuman.filter((i) => {
        const x = i % sim.world.w
        const y = Math.floor(i / sim.world.w)
        return bridge.known.knows(x, y) && Math.abs(x - (sim.world.x >> 10)) + Math.abs(y - (sim.world.y >> 10)) > 1
    })
    assert.deepEqual(leaked, [])
})

test("панель карты: маршрут и оверлей несут известные клетки, невиданное на странице тёмное", () => {
    const { world } = hangar(41)
    const memory = new Memory()
    memory.observe("a", api, world, 0)
    const route = routeOf(api, world, situate(api, world, memory), memory, "k")
    assert.equal(route.seen.length, world.w * world.h)
    assert.equal(route.seen[1 * world.w + 1], "1", "клетка игрока")
    assert.equal(route.seen[14 * world.w + 15], "0", "выход не видели")
    assert.equal(route.what, "unexplored area")
    const snap = { run: 41, lvl: "0", hash: api.mapHash(world), t: 0 } as Snapshot
    assert.equal(mapOverlay(api, world, 1, snap, { ...route, key: `41:0:${api.mapHash(world)}` }).seen, route.seen)
    assert.equal(mapOverlay(api, world, 1, snap, null).seen, "")
    assert.match(MAP_SCRIPT, /o\.seen/)
    assert.match(MAP_PANEL, /not seen yet/)
})

// Virtual-time run with fake Jev answering 500 ms later; the exit is checked to be out of sight at the start.
async function explore(level: string, difficulty: number, limitMs: number): Promise<{ sim: SimConsole; log: LogRecord[]; exitSeenAt: number }> {
    const [lvl] = simLevels(api, level)
    const sim = new SimConsole(lvl.index, difficulty, 5, false, lvl.endless)
    const exit = exitSpot(api, sim.world).cell
    const pending: Array<{ at: number; done: () => void }> = []
    const jev: JevFn = async (state) => {
        const answer = await fakeJev(state)
        await new Promise<void>((done) => pending.push({ at: sim.clock + 500, done }))
        return { ...answer, latencyMs: 500 }
    }
    const log: LogRecord[] = []
    let exitSeenAt = -1
    const bridge = new Bridge(sim.api, sim, jev, (r) => {
        if (r.kind !== "decision") return
        if (!bridge.known.knows(exit[0], exit[1])) assert.doesNotMatch(String(r.state?.goal), /exit,|the exit|exit seen/, `t=${r.at}: выход ещё не виден`)
        else if (exitSeenAt < 0) exitSeenAt = r.at
        log.push(r)
    }, () => sim.clock, 100)
    while (!sim.result && sim.clock < limitMs) {
        sim.step()
        for (const p of pending.filter((p) => p.at <= sim.clock)) {
            pending.splice(pending.indexOf(p), 1)
            p.done()
        }
        await new Promise((resolve) => setImmediate(resolve))
    }
    assert.match(String(log[0]?.state?.goal), /^exploring/, "со старта выхода не видно")
    return { sim, log, exitSeenAt }
}

test("сценарий: HANGAR, WAREHOUSE (ключи), D1 — выход со старта не виден, ИИ исследует и проходит в срок", async () => {
    for (const [level, difficulty, limit] of [["HANGAR", api.DIFF_NORMAL, 90000], ["WAREHOUSE", api.DIFF_NORMAL, 180000], ["D1", api.DIFF_NORMAL, 240000]] as const) {
        const { sim, exitSeenAt } = await explore(level, difficulty, limit)
        assert.equal(sim.result, "won", `${level}: ${sim.result ?? "timeout"} за ${sim.clock} мс`)
        assert.ok(exitSeenAt > 0, `${level}: выход сначала увидел, потом пошёл`)
    }
})

test("мост из командной строки: --no-map-memory принимается, HANGAR проходится", () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url))
    const r = spawnSync(process.execPath, ["--experimental-strip-types", main, "--sim", "HANGAR", "--fake", "--fast", "--quiet", "--no-map-memory"], { encoding: "utf8", env: { ...process.env, OPENROUTER_KEY: "" } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^HANGAR: won 1\/1/m)
})
