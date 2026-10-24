// Bridge side of pickups and tactics: new facts, vision and memory, lava, the watchdog, the shadow
// world across difficulty changes, position prediction, route waypoints and the latency probe.
import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type World } from "../load-logic.ts"
import { decide, MUST_HEAL_HP, mustHeal } from "./decide.ts"
import { fakeJev, fakePick } from "./fake-jev.ts"
import { ACTION_QUESTIONS, ACTIONS, parseAnswer, type Action, type JevAnswer, type JevFn } from "./jev.ts"
import { Bridge, type LogRecord } from "./loop.ts"
import { CMD } from "./mailbox.ts"
import { Memory, MEMORY_MS } from "./memory.ts"
import { facts, healthState, situate, waypoints } from "./observe.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { formatVariants, probeVariant, STATE, VARIANTS } from "./probe.ts"
import { passable, type Cell } from "./route.ts"
import { judge, SCENARIOS, scenarioState } from "./scenarios.ts"
import { Shadow } from "./shadow.ts"
import { levelIndex, SimConsole } from "./sim.ts"

const api = loadLogic()
const FP = 1024
const centre = (c: number) => c * FP + FP / 2

function snapshotOf(link: any, world: World, difficulty = 1): Snapshot {
    const parser = new Parser()
    let snap: Snapshot | null = null
    for (const line of api.aiSnapshot(link, world, difficulty) as string[]) {
        const msg = parser.line(line)
        if (msg?.kind === "snapshot") snap = msg.snap
    }
    assert.ok(snap)
    return snap
}

test("маршрут: до 3 точек по прямым отрезкам до 2 клеток, обрезка до 6 клеток", () => {
    const straight = Array.from({ length: 9 }, (_, i): [number, number] => [1 + i, 1])
    assert.deepEqual(waypoints(straight), [[3, 1], [5, 1], [7, 1]], "прямой коридор")
    assert.deepEqual(waypoints([[1, 1], [2, 1], [3, 1], [3, 2], [3, 3]]), [[3, 1], [3, 3]], "Г-образный поворот")
    assert.deepEqual(waypoints([[1, 1], [2, 1], [2, 2], [3, 2], [3, 3]]), [[2, 1], [2, 2], [3, 2]], "зигзаг: каждая точка поворота")
    assert.deepEqual(waypoints(straight, 2), [[3, 1]], "короткий маршрут")
    assert.deepEqual(waypoints(straight, 1), [[2, 1]])
    assert.deepEqual(waypoints([[1, 1]]), [], "уже на месте")
    const far = waypoints(straight)
    assert.ok(far.every(([x]) => x <= 7), "не дальше 6 клеток")
})

test("факты: health_state на границах, урон оружия, имп на дистанции укуса", () => {
    assert.deepEqual([39, 40, 69, 70].map(healthState), ["critical", "hurt", "hurt", "ok"])
    const world = api.createWorld(["##########", "#S.......#", "##########"], 0)
    world.enemies.push(new api.Enemy(api.ENEMY_IMP, world.x + 800, world.y))
    world.enemies.push(new api.Enemy(api.ENEMY_IMP, world.x + 2048, world.y))
    world.enemies.push(new api.Enemy(api.ENEMY_SHOOTER, world.x + 900, world.y + 100))
    const state = facts(api, world, situate(api, world), [])
    const enemies = state.enemies as Array<{ kind: string; in_bite_range: boolean; distance: number }>
    assert.equal(JSON.stringify(enemies.map((e) => [e.kind, e.in_bite_range])), JSON.stringify([["imp", true], ["shooter", false], ["imp", false]]))
    assert.equal(state.weapon, "pistol, 1 damage per shot")
    assert.equal(state.health_state, "ok")
    world.weapon = api.WEAPON_SHOTGUN
    assert.match(String(facts(api, world, situate(api, world), []).weapon), /3 pellets/)
})

test("факты: аптечка с крюком от маршрута и null при 100 HP; дробовик null после подбора и в руках", () => {
    const world = api.createWorld(["#########", "#S.....X#", "#.#######", "#H#######", "#########"], 0)
    assert.equal(facts(api, world, situate(api, world), []).medkit, null, "при 100 HP аптечку не взять")
    world.health = 30
    const medkit = facts(api, world, situate(api, world), []).medkit as Record<string, unknown>
    assert.deepEqual(medkit, { steps: 2, direction: "right", detour_steps: 4, heals: api.HEALTH_PICKUP })
    const onTheWay = api.createWorld(["#########", "#S..H..X#", "#########"], 0)
    onTheWay.health = 30
    assert.equal((facts(api, onTheWay, situate(api, onTheWay), []).medkit as Record<string, number>).detour_steps, 0)

    const gun = api.createWorld(["#########", "#S..G..X#", "#########"], 0)
    const near = facts(api, gun, situate(api, gun), [])
    assert.deepEqual(near.shotgun, { steps: 3, direction: "ahead", detour_steps: 0 })
    assert.equal(near.weapon_state, "weak, a shotgun is near")
    assert.equal(Object.keys(near).at(-1), "weapon_state", "последним полем — иначе Jev его не замечает")
    gun.hasShotgun = true
    assert.equal(facts(api, gun, situate(api, gun), []).shotgun, null, "уже в руках")
    assert.equal(facts(api, gun, situate(api, gun), []).weapon_state, "strong")
    gun.hasShotgun = false
    gun.items.find((it: { kind: number }) => it.kind === api.ITEM_SHOTGUN).taken = true
    assert.equal(facts(api, gun, situate(api, gun), []).shotgun, null, "подобран")
    assert.equal(facts(api, gun, situate(api, gun), []).weapon_state, "weak")

    const far = api.createWorld(["##############", "#S..........G#", "##############"], 0)
    assert.equal((facts(api, far, situate(api, far), []).shotgun as Record<string, number>).steps, 11)
    assert.equal(facts(api, far, situate(api, far), []).weapon_state, "weak", "дальше 10 шагов — не «рядом»")
})

test("решения: weapon ведёт к дробовику, без него — продвижение; retreat от близкого шара — шагом", () => {
    const gun = api.createWorld(["#########", "#S..G..X#", "#########"], 0)
    const d = decide(api, gun, situate(api, gun), "weapon")
    assert.deepEqual([d.action, d.cmd, d.a, d.b, d.label], ["weapon", CMD.goto, 3, 1, "SHOTGUN"])
    assert.deepEqual(d.route, [[4, 1]])
    const none = api.createWorld(["#########", "#S.....X#", "#########"], 0)
    assert.equal(decide(api, none, situate(api, none), "weapon").action, "advance")

    const world = api.createWorld(["#########", "#.......#", "#..S..E.#", "#.......#", "#########"], 0)
    world.enemies[0].sees = true
    world.shots.push(new api.Shot(world.x + 1000, world.y + 150, -2000, 0))
    const sit = situate(api, world)
    const back = decide(api, world, sit, "retreat")
    assert.equal(back.cmd, CMD.goto, "шар через 500 мс — уходить, а не пятиться под ним")
    world.shots = []
    assert.deepEqual([decide(api, world, situate(api, world), "retreat").cmd, decide(api, world, situate(api, world), "retreat").b], [CMD.attack, 1])
})

test("мало здоровья: мирный выбор Jev заменяется походом к аптечке, бой и уворот — нет", () => {
    const map = ["#########", "#S.....X#", "#.#######", "#H#######", "#########"]
    const world = api.createWorld(map, 0)
    world.health = 30
    const sit = situate(api, world)
    for (const pick of ["advance", "wait", "open", "ammo", "weapon", "retreat"] as Action[]) assert.equal(mustHeal(world, sit, pick), true, pick)
    for (const pick of ["attack", "dodge_left", "dodge_right", "heal"] as Action[]) assert.equal(mustHeal(world, sit, pick), false, pick)
    const d = decide(api, world, sit, "heal")
    assert.deepEqual([d.action, d.cmd, d.a, d.b], ["heal", CMD.goto, 1, 3])

    world.health = MUST_HEAL_HP
    assert.equal(mustHeal(world, situate(api, world), "advance"), false, "40 HP — решает Jev")
    world.health = 30
    world.enemies.push(new api.Enemy(api.ENEMY_IMP, world.x + 900, world.y))
    assert.equal(mustHeal(world, situate(api, world), "retreat"), false, "есть от кого отступать")
    assert.equal(mustHeal(world, situate(api, world), "advance"), true)
    const dry = api.createWorld(["#########", "#S.....X#", "#########"], 0)
    dry.health = 10
    assert.equal(mustHeal(dry, situate(api, dry), "advance"), false, "аптечки нет")
    const onIt = api.createWorld(["#########", "#H.....X#", "#########"], 0)
    onIt.x = centre(1)
    onIt.y = centre(1)
    onIt.health = 10
    assert.equal(mustHeal(onIt, situate(api, onIt), "advance"), false, "уже стоит на ней")
})

test("мост: при 30 HP ответ advance уходит на приставку как HEAL и считается в forcedHeal", async () => {
    const { world, link } = hangar(12)
    world.health = 30
    assert.ok(situate(api, world).medkit, "на уровне есть аптечка")
    const transport = new FakeTransport()
    const log: LogRecord[] = []
    const bridge = new Bridge(api, transport, always("advance"), (r) => log.push(r), () => link.clock, 1)
    transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
    await bridge.idle()
    const rec = log.find((r) => r.kind === "decision")
    assert.deepEqual([rec?.answer?.action, rec?.decision?.action, rec?.decision?.label], ["advance", "heal", "HEAL"])
    assert.equal(rec?.forced, true, "в логе отмечено, что лечение навязано")
    assert.equal(bridge.stats.forcedHeal, 1)
    assert.equal(bridge.stats.picks.advance, 1, "в статистике — что ответил Jev")
    world.health = 100
    const calm: LogRecord[] = []
    const t2 = new FakeTransport()
    const free = new Bridge(api, t2, always("advance"), (r) => calm.push(r), () => link.clock, 1)
    t2.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
    await free.idle()
    assert.equal("forced" in (calm.find((r) => r.kind === "decision") ?? {}), false, "при полном здоровье отметки нет")
})

test("решения: при danger от 0.6 GOTO шагает на 1 клетку, иначе маршрут до 6 клеток", () => {
    const world = api.createWorld(["##########", "#S.......X#", "##########"], 0)
    const sit = situate(api, world)
    const calm = decide(api, world, sit, "advance", 0.2)
    assert.deepEqual([calm.a, calm.b, calm.route], [3, 1, [[5, 1], [7, 1]]])
    const scared = decide(api, world, sit, "advance", 0.8)
    assert.deepEqual([scared.a, scared.b, scared.route], [2, 1, []])
    assert.deepEqual([decide(api, world, sit, "advance", null).a], [3], "без danger — как спокойно")
})

test("Jev: 10 действий с weapon, ответ без danger разбирается, критерии на каждое действие", () => {
    assert.equal(ACTIONS.length, 10)
    assert.deepEqual(Object.keys(ACTION_QUESTIONS.action.criteria).sort(), [...ACTIONS].sort())
    assert.match(ACTION_QUESTIONS.action.criteria.heal, /hurt or critical/)
    const body = { answers: { action: { type: "choice", choice: "weapon", probabilities: { weapon: 0.7 } } }, usage: { cost: 0.00003 } }
    assert.deepEqual(parseAnswer(body), { action: "weapon", confidence: 0.7, danger: null, cost: 0.00003 })
})

test("зрение: шар за стеной не попадает в факты, увернуться от шара в лаву не предлагается", () => {
    const walled = api.createWorld(["#########", "#..S....#", "#########", "#.......#", "#########"], 0)
    walled.shots.push(new api.Shot(walled.x + 1500, walled.y + 2048, -1500, -1500))
    assert.equal(situate(api, walled).fireballs.length, 0)

    const world = api.createWorld(["#########", "#...L...#", "#...S...#", "#.......#", "#########"], 0)
    world.shots.push(new api.Shot(world.x + 2000, world.y + 150, -2000, 0))
    assert.equal(situate(api, world).fireballs[0].safeSide, "right", "слева лава — уворот вправо")
})

test("лава: факт под игроком, рядом и нет; маршрут в обход лавы пояснён", () => {
    const world = api.createWorld(["#######", "#S.L.X#", "#.....#", "#######"], 0)
    const state = facts(api, world, situate(api, world), [])
    assert.deepEqual(state.lava, { under_you: false, nearest_cells: 2, direction: "ahead" })
    assert.match(String(state.route), /^route goes around lava, next waypoint is/)
    world.x = centre(3)
    assert.deepEqual(facts(api, world, situate(api, world), []).lava, { under_you: true, nearest_cells: 0, direction: "under you" })
    const dry = api.createWorld(["#######", "#S...X#", "#######"], 0)
    const plain = facts(api, dry, situate(api, dry), [])
    assert.equal(plain.lava, null)
    assert.doesNotMatch(String(plain.route), /lava/)
})

test("память: ушедший за угол враг в last_seen 5 с, потом пропадает; убитый — сразу; новый уровень — чисто", () => {
    const world = api.createWorld(["#######", "#S....#", "#.###.#", "#.....#", "#######"], 0)
    world.enemies.push(new api.Enemy(api.ENEMY_IMP, centre(5), centre(1)))
    const memory = new Memory()
    memory.observe("1:0:0", api, world, 0)
    assert.equal(memory.recent(api, world).length, 0, "в поле зрения — не в памяти, а в enemies")
    world.enemies[0].x = centre(3)
    world.enemies[0].y = centre(3)
    memory.observe("1:0:0", api, world, 1000)
    const sit = situate(api, world, memory)
    assert.equal(sit.enemies.length, 0)
    const seen = facts(api, world, sit, []).last_seen as Array<Record<string, unknown>>
    assert.deepEqual(seen, [{ kind: "imp", seconds_ago: 1, direction: "ahead", distance: 4 }], "где видели, а не где он сейчас")
    assert.notEqual(sit.back, null, "от запомненного врага отступить можно")
    memory.observe("1:0:0", api, world, MEMORY_MS + 1)
    assert.equal(memory.recent(api, world).length, 0, "старше 5 с")

    world.enemies[0].x = centre(5)
    world.enemies[0].y = centre(1)
    memory.observe("1:0:0", api, world, 7000)
    world.enemies[0].x = centre(3)
    world.enemies[0].y = centre(3)
    memory.observe("1:0:0", api, world, 7500)
    assert.equal(memory.recent(api, world).length, 1)
    memory.observe("1:1:0", api, world, 7600)
    assert.equal(memory.recent(api, world).length, 0, "смена уровня")
    memory.observe("1:1:0", api, world, 7700)
    world.enemies[0].dead = true
    memory.observe("1:1:0", api, world, 7800)
    assert.equal(memory.last.size, 0, "убитый")
})

test("босс за стеной: идём к месту последней встречи, без неё — к точке появления; невидимого не атакуем", () => {
    const map = ["#########", "#S......#", "#.#####.#", "#...Z...#", "#########"]
    const world = api.createWorld(map, 0)
    world.exitLocked = true
    const spawn: [number, number] = [world.enemies[0].x >> 10, world.enemies[0].y >> 10]
    const memory = new Memory()
    memory.observe("1:2:0", api, world, 0, [spawn])
    let sit = situate(api, world, memory)
    assert.deepEqual([sit.goal, sit.bossSeen, sit.bossSource, sit.goalCell], ["boss", false, "spawn", spawn])
    assert.match(String(facts(api, world, sit, []).goal), /find the boss to unlock the exit, it appears \d+ steps away/)
    assert.notEqual(decide(api, world, sit, "advance").cmd, CMD.attack)
    assert.notEqual(decide(api, world, sit, "attack").cmd, CMD.attack, "attack по невидимому — продвижение")

    const boss = world.enemies[0]
    boss.x = centre(7)
    boss.y = centre(1)
    memory.observe("1:2:0", api, world, 1000, [spawn])
    assert.equal(situate(api, world, memory).bossSeen, true)
    boss.x = centre(7)
    boss.y = centre(3)
    memory.observe("1:2:0", api, world, 3000, [spawn])
    sit = situate(api, world, memory)
    assert.deepEqual([sit.bossSource, sit.goalCell], ["seen", [7, 1]])
    assert.match(String(facts(api, world, sit, []).goal), /last seen 2 s ago/)

    boss.x = centre(4)
    world.x = centre(7)
    memory.observe("1:2:0", api, world, 4000, [spawn])
    assert.equal(situate(api, world, memory).bossSeen, false)
    sit = situate(api, world, memory)
    assert.deepEqual([sit.bossSource, sit.goalCell], ["spawn", spawn], "дошли — босса нет, к точке появления")
})

test("теневой мир: сложность сменили в паузе посреди уровня — карта та же, пропусков нет", () => {
    const world = api.enterLevel(api.startAtLevel(api.DIFF_NORMAL, 0))
    const link = new api.AiLink(3)
    api.aiEnterLevel(link, api.startAtLevel(api.DIFF_NORMAL, 0), world)
    const shadow = new Shadow(api)
    assert.ok(shadow.sync(snapshotOf(link, world, api.DIFF_NORMAL)))
    const changed = shadow.sync(snapshotOf(link, world, api.DIFF_EASY))
    assert.ok(changed, shadow.problem)
    assert.equal(changed.enemies.length, world.enemies.length, "враги — те, с которыми вошли в уровень")
    assert.equal(changed.difficulty, api.DIFF_EASY)
    const fresh = new Shadow(api).sync(snapshotOf(link, world, api.DIFF_EASY))
    assert.ok(fresh, "мост, запущенный уже после смены сложности, тоже находит карту")
    assert.deepEqual(new Shadow(api).spawns, [])
})

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

const always = (action: Action, latencyMs = 0): JevFn => async () => ({ action, confidence: 0.5, danger: null, cost: 0, latencyMs, error: "" })

// HANGAR as the console runs it, with every enemy gone unless the test puts one back.
function hangar(run: number): { world: World; link: any } {
    const world = api.enterLevel(api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL))
    for (const e of world.enemies) e.dead = true
    const link = new api.AiLink(run)
    api.aiEnterLevel(link, api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), world)
    return { world, link }
}

async function standStill(world: World, link: any, jev: JevFn, log: (r: LogRecord) => void = () => {}): Promise<Bridge> {
    const transport = new FakeTransport()
    const bridge = new Bridge(api, transport, jev, log, () => link.clock, 1)
    for (let t = 0; t <= 7000; t += 250) {
        link.clock = t
        transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
        await bridge.idle()
    }
    return bridge
}

test("сторожевой таймер: 3 с без движения вне боя — факт stalled, 6 с — один раз advance вместо wait; в бою молчит", async () => {
    const { world, link } = hangar(9)
    const states: Array<Record<string, unknown>> = []
    const log: LogRecord[] = []
    const bridge = await standStill(world, link, async (s) => { states.push(s); return always("wait")(s) }, (r) => log.push(r))
    const stalledAt = states.findIndex((s) => typeof s.stalled === "string")
    assert.equal(stalledAt * 250, 3000, "факт stalled с 3 с")
    assert.equal(states.slice(0, stalledAt).some((s) => "stalled" in s), false)
    assert.equal(states.at(-1)?.stalled, "standing still for 7.0 s")
    const forced = log.filter((r) => r.kind === "decision" && r.decision?.action === "advance")
    assert.equal(forced.length, 1, "подмена один раз на одну стоянку")
    assert.equal(forced[0].at, 6000)
    assert.equal(bridge.stats.watchdog, 1)
    assert.ok(log.some((r) => r.kind === "watchdog"))

    const fight = hangar(10)
    const imp = fight.world.enemies[0]
    imp.dead = false
    imp.x = fight.world.x + ((api.cos(fight.world.ang) * 600) >> 10)
    imp.y = fight.world.y + ((api.sin(fight.world.ang) * 600) >> 10)
    const seen: Array<Record<string, unknown>> = []
    const calm = await standStill(fight.world, fight.link, async (s) => { seen.push(s); return always("wait")(s) })
    assert.ok((seen[0].enemies as unknown[]).length > 0)
    assert.equal(seen.some((s) => "stalled" in s), false, "враг в поле зрения — это бой, не стоянка")
    assert.equal(calm.stats.watchdog, 0)
})

test("прогноз: факты описывают момент прихода ответа; игрок не на маршруте — берётся снимок", async () => {
    const run = async (predict: boolean, moveOff: boolean) => {
        const { world, link } = hangar(11)
        const start: [number, number] = [world.x, world.y]
        const transport = new FakeTransport()
        const states: Array<Record<string, unknown>> = []
        const bridge = new Bridge(api, transport, async (s) => { states.push(s); return always("advance", 500)(s) }, () => {}, () => link.clock, 1, { predict })
        transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
        await bridge.idle()
        if (moveOff) {
            const far = farCell(world, start)
            world.x = centre(far[0])
            world.y = centre(far[1])
        }
        link.clock = 250
        transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
        await bridge.idle()
        return { steps: Number(String(states[1].goal).match(/(\d+) steps/)?.[1]), predicted: bridge.stats.predicted }
    }
    const plain = await run(false, false)
    const ahead = await run(true, false)
    assert.equal(plain.predicted, 0)
    assert.equal(ahead.predicted, 1)
    assert.ok(plain.steps - ahead.steps >= 1, `за 500 мс GOTO продвигает на клетку и больше: ${plain.steps} -> ${ahead.steps}`)
    const off = await run(true, true)
    assert.equal(off.predicted, 0, "старый маршрут не ложится на клетку игрока — без прогноза")
})

// A floor cell at least 4 cells from `from`, off any short route out of it.
function farCell(world: World, from: [number, number]): Cell {
    for (let y = 1; y < world.h - 1; y++) {
        for (let x = 1; x < world.w - 1; x++) {
            const d = Math.abs(x - (from[0] >> 10)) + Math.abs(y - (from[1] >> 10))
            if (d >= 4 && passable(api, world, x, y, 0) && !api.lavaAt(world, x, y)) return [x, y]
        }
    }
    throw new Error("no far cell")
}

test("probe --variants: три варианта запроса, сводка по задержке и вкладу danger, без сети", async () => {
    let t = 0
    const bodies: string[] = []
    const fakeFetch = (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        const withDanger = String(init.body).includes('"danger"')
        t += withDanger ? 600 : 500
        return new Response(JSON.stringify({ answers: { action: { choice: "advance" } }, usage: { cost: 0.00001 } }), {
            status: 200,
            headers: { "x-processing-time": "420" },
        })
    }) as typeof fetch
    const results = []
    for (const v of VARIANTS) results.push(await probeVariant(v, 2, { key: "k", fetch: fakeFetch, now: () => t, model: "m" }))
    assert.deepEqual(results.map((r) => r.name), ["action only", "action + danger", "trimmed state"])
    assert.deepEqual(results.map((r) => r.latencies), [[500, 500], [600, 600], [600, 600]])
    assert.equal(results[0].timings["x-processing-time"], "420")
    assert.ok(!bodies[4].includes('"recent"') && !bodies[4].includes('"route"'), "урезанное состояние без recent и route")
    assert.ok(bodies.every((b) => !b.includes('"k"')), "ключ не в теле")
    const lines = formatVariants(results)
    assert.match(lines[0], /^action only: median 500 ms p90 500 ms, errors 0, cost 0\.000020 USD/)
    assert.equal(lines.at(-1), "danger adds 100 ms to the median")
    assert.ok("medkit" in STATE && !("nearest_medkit" in STATE), "проба на новом формате фактов")
})

test("контрольные ситуации: фейковый Jev проходит все", () => {
    for (const sc of SCENARIOS) assert.ok(judge(sc, fakePick(scenarioState(api, sc))), sc.name)
})

// Virtual-time driver: answers land `latency` ms of sim time after the request.
async function drive(sim: SimConsole, pick: JevFn, latency: number, limitMs: number, log: LogRecord[] = []): Promise<Bridge> {
    const pending: Array<{ at: number; done: () => void }> = []
    const jev: JevFn = async (state) => {
        const answer: JevAnswer = await pick(state)
        await new Promise<void>((done) => pending.push({ at: sim.clock + latency, done }))
        return { ...answer, latencyMs: latency }
    }
    const bridge = new Bridge(sim.api, sim, jev, (rec) => log.push(rec), () => sim.clock, 100)
    while (!sim.result && sim.clock < limitMs) {
        sim.step()
        for (const p of pending.filter((p) => p.at <= sim.clock)) {
            pending.splice(pending.indexOf(p), 1)
            p.done()
        }
        await new Promise((resolve) => setImmediate(resolve))
    }
    return bridge
}

test("сценарий: WAREHOUSE EASY — фейковый Jev берёт дробовик до выхода", async () => {
    const sim = new SimConsole(levelIndex(api, "WAREHOUSE"), api.DIFF_EASY, 5)
    const log: LogRecord[] = []
    const bridge = await drive(sim, fakeJev, 500, 240000, log)
    assert.equal(sim.result, "won")
    assert.equal(bridge.stats.pickups.shotgun, 1)
    assert.ok((bridge.stats.picks.weapon ?? 0) > 0)
    assert.ok(log.some((r) => r.kind === "decision" && r.decision?.label === "SHOTGUN"))
})

test("сценарий: HANGAR с 30 HP — аптечка подобрана выбором heal", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    sim.world.health = 30
    const bridge = await drive(sim, fakeJev, 500, 120000)
    assert.ok((bridge.stats.picks.heal ?? 0) > 0)
    assert.ok((bridge.stats.pickups.medkit ?? 0) >= 1)
})

test("сценарий: HANGAR с 30 HP, Jev всегда отвечает advance — мост всё равно ведёт к аптечке", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    sim.world.health = 30
    const bridge = await drive(sim, always("advance"), 500, 120000)
    assert.ok(bridge.stats.forcedHeal > 0)
    assert.ok((bridge.stats.pickups.medkit ?? 0) >= 1, JSON.stringify(bridge.stats.pickups))
    assert.ok(sim.world.health > 30)
})

test("сценарий: HANGAR NORMAL с задержкой Jev 500 мс — простой вне боя меньше 15%, пауз дольше 600 мс нет", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    await drive(sim, fakeJev, 500, 120000)
    assert.equal(sim.result, "won")
    const idle = sim.idleMs / sim.playMs
    assert.ok(idle < 0.15, `простой ${(idle * 100).toFixed(1)}%`)
    assert.ok(sim.longestIdleMs <= 600, `пауза ${sim.longestIdleMs} мс`)
})

test("сценарий: ARENA EASY — фейковый Jev находит босса и проходит", async () => {
    const sim = new SimConsole(levelIndex(api, "ARENA"), api.DIFF_EASY, 5)
    await drive(sim, fakeJev, 500, 240000)
    assert.equal(sim.result, "won", `hp ${sim.world.health}`)
})

test("сценарий: рефлексы снижают урон от шаров на ARENA EASY", async () => {
    const hit = async (reflexes: boolean) => {
        const sim = new SimConsole(levelIndex(api, "ARENA"), api.DIFF_EASY, 5)
        sim.reflexes = reflexes
        await drive(sim, fakeJev, 500, 240000)
        return sim.damage.shot
    }
    const on = await hit(true)
    const off = await hit(false)
    assert.ok(on < off, `с рефлексами ${on}, без ${off}`)
})

test("сценарий: процедурные уровни с лавой D1-D5 EASY — ни одного урона от лавы", async () => {
    for (let depth = 0; depth < 5; depth++) {
        const sim = new SimConsole(depth, api.DIFF_EASY, 11 + depth, false, true)
        const bridge = await drive(sim, fakeJev, 500, 240000)
        assert.equal(sim.damage.lava, 0, `D${depth + 1}`)
        assert.equal(bridge.stats.skipped, 0)
        if (depth < 4) assert.equal(sim.result, "won", `D${depth + 1}`)
    }
})

test("сценарий: Jev всегда отвечает wait — сторожевой таймер сдвигает игрока с места", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    const x0 = sim.world.x
    const bridge = await drive(sim, always("wait"), 500, 9000)
    assert.ok(bridge.stats.watchdog >= 1)
    assert.notEqual(sim.world.x, x0, "пошёл")
})

test("сценарий: сложность сменили в паузе — мост не теряет теневой мир", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    const pending: Array<{ at: number; done: () => void }> = []
    const bridge = new Bridge(sim.api, sim, async (s) => {
        const a = await fakeJev(s)
        await new Promise<void>((done) => pending.push({ at: sim.clock + 500, done }))
        return { ...a, latencyMs: 500 }
    }, () => {}, () => sim.clock, 1)
    for (let t = 0; t < 6000; t += 20) {
        if (t === 2000) (sim as { difficulty: number }).difficulty = api.DIFF_EASY
        sim.step()
        for (const p of pending.filter((p) => p.at <= sim.clock)) {
            pending.splice(pending.indexOf(p), 1)
            p.done()
        }
        await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(bridge.stats.skipped, 0)
    assert.ok(bridge.stats.decisions > 8)
})

// Facts -> fake Jev -> decide -> game, straight on a live world (no shadow), for custom maps.
function localLoop(world: World, pick: (state: Record<string, unknown>) => Action, ms: number, every = 500): Action[] {
    const exec = new api.AiExec()
    const memory = new Memory()
    const picks: Action[] = []
    for (let t = 0; t < ms && !world.won && !world.lost; t += 20) {
        if (t % every === 0) {
            memory.observe("local", api, world, t)
            const sit = situate(api, world, memory)
            const action = pick(facts(api, world, sit, []))
            picks.push(action)
            const d = decide(api, world, sit, action)
            api.aiStart(exec, world, d.cmd, d.a, d.b, d.route.flat(), sit.at[0], sit.at[1])
        }
        api.update(world, api.aiStep(exec, world, 20), 20)
    }
    return picks
}

test("сценарий: имп вплотную при 25 HP — отход с огнём, игрок жив, имп убит", () => {
    const world = api.createWorld(["############", "#.....S....#", "############"], 512)
    const imp = new api.Enemy(api.ENEMY_IMP, world.x - 900, world.y)
    imp.awake = true
    imp.sees = true
    imp.hunting = true
    world.enemies.push(imp)
    world.health = 25
    const picks = localLoop(world, fakePick, 5000)
    assert.ok(picks.includes("retreat"), picks.join(","))
    assert.equal(world.lost, false)
    assert.equal(imp.dead, true)
})

test("сценарий D3: Jev отвечает только retreat, маршрут сзади, врагов не видно — игрок не стоит, доходит до выхода", () => {
    const world = api.createWorld(["##########", "#X.....S.#", "##########", "#.....E..#", "##########"], 0)
    world.health = 27
    const picks = localLoop(world, () => "retreat", 10000)
    assert.equal(world.won, true, `застрял в ${world.x >> 10},${world.y >> 10} после ${picks.length} решений`)
})
