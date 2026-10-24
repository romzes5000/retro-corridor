import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type World } from "../load-logic.ts"
import { decide } from "./decide.ts"
import { fakeJev, fakePick } from "./fake-jev.ts"
import { ACTIONS, makeJev, parseAnswer, type JevAnswer, type JevFn } from "./jev.ts"
import { Bridge, type LogRecord } from "./loop.ts"
import { CMD } from "./mailbox.ts"
import { Memory } from "./memory.ts"
import { facts, situate, straightStep } from "./observe.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { sessionFor, Shadow } from "./shadow.ts"
import { levelIndex, recording, replay, SimConsole } from "./sim.ts"

const api = loadLogic()

function snapshotOf(world: World, lvl = "0", difficulty = 1): Snapshot {
    const link = new api.AiLink(77)
    link.level = lvl
    link.hash = api.mapHash(world)
    const parser = new Parser()
    let snap: Snapshot | null = null
    for (const line of api.aiSnapshot(link, world, difficulty) as string[]) {
        const msg = parser.line(line)
        if (msg?.kind === "snapshot") snap = msg.snap
    }
    assert.ok(snap)
    return snap
}

test("протокол: снимок собирается из строк, END с чужим n и битая строка роняют кадр", () => {
    const world = api.createWorld(["##########", "#S.|.H.E.#", "#..A.....#", "##########"], 256)
    world.items[0].taken = true
    world.shots.push(new api.Shot(4000, 1500, -900, 30))
    const snap = snapshotOf(world)
    assert.equal(snap.run, 77)
    assert.deepEqual([snap.x, snap.y, snap.ang, snap.hp, snap.ammo], [world.x, world.y, 256, world.health, world.ammo])
    assert.equal(snap.enemies.length, 1)
    assert.deepEqual(snap.shots, [{ x: 4000, y: 1500, vx: -900, vy: 30 }])
    assert.deepEqual(snap.doors, [0])
    assert.deepEqual(snap.taken.slice(0, 2), [true, false])
    assert.deepEqual(snap.ack, { seq: 0, result: "ok", stale: false })

    const p = new Parser()
    assert.equal(p.line("fps 30 q3 step 1"), null, "чужие строки консоли пропускаются")
    p.line("AI S n=5 t=100 run=1 lvl=0 h=9 d=1")
    p.line("AI P 1 2 3 4 5 0 0 0")
    assert.equal(p.line("AI END n=6"), null)
    p.line("AI S n=7 t=100 run=1 lvl=0 h=9 d=1")
    p.line("AI P 1 2 x 4 5 0 0 0")
    assert.equal(p.line("AI END n=7"), null, "битая P роняет кадр")
    assert.deepEqual(p.line("AI WON"), { kind: "won" })
    assert.deepEqual(p.line("AI DEAD"), { kind: "dead" })
})

test("теневой мир: тот же уровень по хешу, чужой хеш и неизвестный уровень — без мира", () => {
    const session = api.startAtLevel(api.DIFF_HARD, 1)
    const world = api.enterLevel(session)
    world.enemies[2].dead = true
    world.items[0].taken = true
    world.x += 300
    const snap = snapshotOf(world, "1", api.DIFF_HARD)
    const shadow = new Shadow(api)
    const copy = shadow.sync(snap)
    assert.ok(copy, shadow.problem)
    assert.equal(copy.x, world.x)
    assert.equal(copy.enemies.length, world.enemies.length)
    assert.equal(copy.enemies[2].dead, true)
    assert.equal(copy.enemies[0].dead, false)
    assert.equal(copy.items[0].taken, true)

    const wrong = new Shadow(api)
    assert.equal(wrong.sync({ ...snap, hash: (snap.hash + 1) & 0xffff }), null)
    assert.match(wrong.problem, /hash/)
    assert.equal(new Shadow(api).sync({ ...snap, lvl: "9" }), null)
    const endless = sessionFor(api, "D3", 1)
    assert.equal(api.levelName(endless), "DEPTH 3")
})

test("наблюдение: шаг маршрута — до 2 клеток по прямой, у выхода — в саму плитку выхода", () => {
    assert.deepEqual(straightStep([[1, 1], [2, 1], [3, 1], [4, 1]]), [3, 1])
    assert.deepEqual(straightStep([[1, 1], [2, 1], [2, 2]]), [2, 1])
    assert.equal(straightStep([[1, 1]]), null)
    const world = api.createWorld(["#######", "#S...X#", "#######"], 0)
    const sit = situate(api, world)
    assert.equal(sit.goal, "exit")
    assert.deepEqual(sit.next, [3, 1])
    world.x = 4 * 1024 + 512
    assert.deepEqual(situate(api, world).next, [5, 1])
})

test("наблюдение: ключ раньше выхода, если дверь заперта; босс, пока выход закрыт", () => {
    const world = api.createWorld(["#######", "#S.R.X#", "##.####", "##r####", "#######"], 0)
    const memory = new Memory()
    memory.observe("t", api, world, 0)
    const start = situate(api, world, memory)
    assert.equal(start.goal, "explore", "ключ в нише и выход за дверью со старта не видны")
    assert.doesNotMatch(JSON.stringify(facts(api, world, start, [])), /red key/)
    world.x = 2 * 1024 + 512
    world.ang = 256
    memory.observe("t", api, world, 500)
    const sit = situate(api, world, memory)
    assert.equal(sit.goal, "key")
    assert.deepEqual(sit.goalCell, [2, 3])
    assert.match(String(facts(api, world, sit, []).goal), /red key/)

    const boss = api.createWorld(["#########", "#S....Z.#", "#......X#", "#########"], 0)
    boss.exitLocked = true
    const bs = situate(api, boss)
    assert.equal(bs.goal, "boss")
    assert.match(String(facts(api, boss, bs, []).goal), /boss/)
})

test("наблюдение: шар спереди правее игрока — безопасная сторона левая, однозначно", () => {
    const world = api.createWorld(["#########", "#.......#", "#..S....#", "#.......#", "#########"], 0)
    world.shots.push(new api.Shot(world.x + 2000, world.y + 150, -2000, 0))
    const sit = situate(api, world)
    assert.equal(sit.fireballs.length, 1)
    assert.equal(sit.fireballs[0].from, "ahead")
    assert.equal(sit.fireballs[0].safeSide, "left", "шар правее линии — уходить влево")
    assert.equal(sit.fireballs[0].etaMs, 1000)
    world.shots[0] = new api.Shot(world.x + 2000, world.y - 150, -2000, 0)
    assert.equal(situate(api, world).fireballs[0].safeSide, "right")
    world.shots[0] = new api.Shot(world.x + 200, world.y + 1500, 0, -2000)
    assert.equal(situate(api, world).fireballs[0].safeSide, "none", "шар сбоку стрейфом не обойти")
    world.shots[0] = new api.Shot(world.x + 2000, world.y + 150, 2000, 0)
    assert.equal(situate(api, world).fireballs.length, 0, "улетающий шар не опасен")
})

test("наблюдение: факты на английском, без команд, с врагами по дальности", () => {
    const world = api.createWorld(["##########", "#S....E..#", "#......K.#", "##########"], 0)
    world.enemies[0].sees = true
    const state = facts(api, world, situate(api, world), ["advance ok"])
    assert.equal((state.enemies as unknown[]).length, 2)
    const first = (state.enemies as Array<Record<string, unknown>>)[0]
    assert.equal(first.kind, "imp")
    assert.equal(first.direction, "ahead")
    assert.equal(first.sees_you, true)
    assert.deepEqual(state.recent, ["advance ok"])
    assert.doesNotMatch(JSON.stringify(state), /[а-яё]/i)
})

test("наблюдение: враг за стеной не попадает в факты ни списком, ни счётчиком; attack на него — продвижение", () => {
    const world = api.createWorld(["#######", "#S...X#", "#######", "#..E..#", "#######"], 0)
    world.enemies[0].awake = true
    world.enemies[0].hunting = true
    const sit = situate(api, world)
    assert.equal(sit.enemies.length, 0)
    const state = facts(api, world, sit, [])
    assert.equal((state.enemies as unknown[]).length, 0)
    assert.equal("enemies_behind_walls" in state, false)
    assert.doesNotMatch(JSON.stringify(state), /behind_walls/)
    assert.deepEqual(state.last_seen, [])
    assert.equal(decide(api, world, sit, "attack").action, "advance")
    assert.equal(sit.back, null, "от невидимого врага, которого не помним, не отступаем")
    assert.equal(decide(api, world, sit, "retreat").action, "advance", "retreat без угрозы — продвижение")
})

test("решения: каждое действие Jev даёт свою команду, невозможное откатывается на продвижение", () => {
    const world = api.createWorld(["#########", "#S....E.#", "#..H....#", "#########"], 0)
    world.enemies[0].sees = true
    world.health = 50
    const memory = new Memory()
    memory.observe("t", api, world, 0)
    assert.equal(decide(api, world, situate(api, world, memory), "advance").cmd, CMD.goto, "выхода не видно — идёт исследовать")
    for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) memory.known.mark(x, y)
    const sit = situate(api, world, memory)
    const got = (a: (typeof ACTIONS)[number]) => {
        const d = decide(api, world, sit, a)
        return [d.action, d.cmd, d.a, d.b]
    }
    assert.deepEqual(got("advance").slice(0, 2), ["wait", CMD.wait], "карта изучена, выхода нет — стоит")
    assert.deepEqual(got("attack"), ["attack", CMD.attack, 0, 0])
    assert.deepEqual(got("dodge_left"), ["dodge_left", CMD.strafe, 0, 0])
    assert.deepEqual(got("dodge_right"), ["dodge_right", CMD.strafe, 1, 0])
    const heal = decide(api, world, sit, "heal")
    assert.deepEqual([heal.action, heal.cmd, heal.a, heal.b], ["heal", CMD.goto, 3, 1], "к аптечке: до поворота")
    assert.deepEqual(heal.route, [[3, 2]], "дальше — в клетку аптечки")
    assert.equal(got("ammo")[0], "wait", "патронов нет — как advance")
    assert.equal(got("weapon")[0], "wait", "дробовика на карте нет — как advance")
    assert.deepEqual(got("open").slice(0, 2), ["open", CMD.use])
    assert.deepEqual(got("retreat"), ["retreat", CMD.attack, 0, 1], "отход спиной с огнём по видимому врагу")
    world.ammo = 0
    assert.equal(decide(api, world, sit, "attack").action, "wait", "без патронов не атакует")
    assert.deepEqual(got("retreat"), ["retreat", CMD.goto, 1, 2], "без патронов — шаг прочь от врага")
    for (const a of ACTIONS) assert.ok(decide(api, world, sit, a).label.length <= 8)
})

test("Jev: разбор ответа, таймаут и ошибка HTTP дают wait и причину, ключ уходит только в заголовок", async () => {
    const body = {
        answers: {
            action: { type: "choice", choice: "dodge_right", probabilities: { dodge_right: 0.62, advance: 0.38 }, confidence: 0.34 },
            danger: { type: "noul", noul: 0.73 },
        },
        usage: { input_tokens: 685, output_tokens: 104, cost: 0.00002877 },
    }
    assert.deepEqual(parseAnswer(body), { action: "dodge_right", confidence: 0.62, danger: 0.73, cost: 0.00002877 })
    assert.throws(() => parseAnswer({ answers: { action: { choice: "jump" } } }))

    let sent: RequestInit | undefined
    const ok = makeJev({
        key: "k-123",
        fetch: (async (_url: string, init: RequestInit) => {
            sent = init
            return new Response(JSON.stringify(body), { status: 200 })
        }) as typeof fetch,
    })
    const answer = await ok({ goal: "x" })
    assert.equal(answer.action, "dodge_right")
    assert.equal(answer.error, "")
    assert.equal((sent?.headers as Record<string, string>).Authorization, "Bearer k-123")
    assert.doesNotMatch(String(sent?.body), /k-123/)
    assert.match(String(sent?.body), /"questions"/)

    const slow = makeJev({
        key: "k",
        timeoutMs: 30,
        fetch: ((_url: string, init: RequestInit) => new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })) as typeof fetch,
    })
    const late = await slow({})
    assert.equal(late.action, "wait")
    assert.match(late.error, /timeout 30/)

    const down = makeJev({ key: "k", fetch: (async () => new Response("{}", { status: 502 })) as typeof fetch })
    assert.deepEqual([(await down({})).action, (await down({})).error], ["wait", "http 502"])
    const garbled = makeJev({ key: "k", fetch: (async () => new Response("<html>oops", { status: 200 })) as typeof fetch })
    const bad = await garbled({})
    assert.equal(bad.action, "wait")
    assert.notEqual(bad.error, "")
    const empty = makeJev({ key: "k", fetch: (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as typeof fetch })
    assert.match((await empty({})).error, /no action/)
})

class FakeTransport {
    writes: Array<{ offset: number; data: number[] }> = []
    resets = 0
    private listener: (line: string) => void = () => {}
    onLine(l: (line: string) => void): void {
        this.listener = l
    }
    async writeBox(writes: Array<{ offset: number; data: Uint8Array }>): Promise<void> {
        for (const w of writes) this.writes.push({ offset: w.offset, data: [...w.data] })
    }
    reset(): void {
        this.resets++
    }
    send(lines: string[]): void {
        for (const l of lines) this.listener(l)
    }
}

test("мост: тело ящика пишется раньше seq, новый run сбрасывает адрес ящика, один снимок — одно решение", async () => {
    const world = api.enterLevel(api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL))
    const link = new api.AiLink(500)
    api.aiEnterLevel(link, api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), world)
    const transport = new FakeTransport()
    const bridge = new Bridge(api, transport, fakeJev, () => {}, Date.now, 41)
    const frame = () => api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]
    const first = frame()
    transport.send(first)
    transport.send(first)
    await bridge.idle()
    assert.equal(bridge.stats.decisions, 1, "повтор того же снимка не спрашивает Jev ещё раз")
    assert.deepEqual(transport.writes.map((w) => [w.offset, w.data.length]), [[12, 20], [8, 4]])
    assert.deepEqual(transport.writes[1].data.slice(0, 2), [42, 0], "seq после стартового 41")
    assert.equal(transport.writes[1].data[2], link.obs, "obs — номер снимка, на который ответ")
    assert.equal(transport.resets, 0)

    link.ackSeq = 42
    link.exec.result = api.AI_BLOCKED
    const states: Array<Record<string, unknown>> = []
    const side = new FakeTransport()
    const watching = new Bridge(api, side, async (state) => {
        states.push(state)
        return fakeJev(state)
    }, () => {}, Date.now, 41)
    side.send(frame())
    await watching.idle()
    side.send(frame())
    await watching.idle()
    link.ackSeq = 43
    side.send(frame())
    await watching.idle()
    assert.deepEqual(states[1].recent, ["advance blocked"], "итог прошлой команды из ACK в снимке")
    assert.deepEqual(states[2].recent, ["advance blocked", "advance blocked"])

    const rebooted = new api.AiLink(501)
    api.aiEnterLevel(rebooted, api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), world)
    transport.send(api.aiSnapshot(rebooted, world, api.DIFF_NORMAL) as string[])
    await bridge.idle()
    assert.equal(transport.resets, 1, "Reset приставки — искать ящик заново")
    assert.equal(bridge.stats.decisions, 2)
})

test("мост: AI HUMAN — ответ Jev в полёте не пишется в ящик, после передачи ИИ решение на свежий снимок", async () => {
    const session = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    const world = api.enterLevel(session)
    const link = new api.AiLink(600)
    api.aiEnterLevel(link, session, world)
    const transport = new FakeTransport()
    const log: LogRecord[] = []
    const asked: number[] = []
    let release: () => void = () => {}
    const jev: JevFn = async (state) => {
        asked.push(asked.length)
        if (asked.length === 1) await new Promise<void>((done) => { release = done })
        return fakeJev(state)
    }
    const bridge = new Bridge(api, transport, jev, (r) => log.push(r), Date.now, 41)
    assert.deepEqual(new Parser().line("AI HUMAN"), { kind: "human" })

    transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
    transport.send([api.AI_HUMAN])
    release()
    await bridge.idle()
    assert.equal(transport.writes.length, 0, "команда на снимок до перехвата не уходит")
    assert.equal(bridge.stats.decisions, 0)
    assert.equal(bridge.stats.dead + bridge.stats.won, 0, "перехват — не смерть и не победа")
    assert.deepEqual(log.map((r) => r.kind), ["human"])

    world.x += 2048
    api.aiHandBack(link, session)
    const resumed = api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]
    transport.send(resumed)
    await bridge.idle()
    assert.equal(asked.length, 2)
    assert.equal(bridge.stats.decisions, 1)
    assert.equal(transport.writes[1].data[2], link.obs, "ответ на первый снимок после передачи")
    const decision = log.find((r) => r.kind === "decision")
    assert.equal(decision?.n, link.obs)
})

test("фейковый Jev: уворот на безопасную сторону раньше атаки, иначе вперёд", () => {
    const base = { health: 100, health_state: "ok", ammo: 10, enemies: [], fireballs: [], door_ahead: "none", medkit: null, ammo_pickup: null, shotgun: null }
    assert.equal(fakePick(base), "advance")
    const medkit = { steps: 3, direction: "ahead", detour_steps: 4 }
    assert.equal(fakePick({ ...base, health: 30, health_state: "critical", medkit }), "heal")
    assert.equal(fakePick({ ...base, health: 30, health_state: "critical", medkit: { ...medkit, detour_steps: 9 } }), "advance", "крюк длинный")
    assert.equal(fakePick({ ...base, shotgun: { steps: 4, direction: "left", detour_steps: 4 } }), "weapon")
    assert.equal(fakePick({ ...base, shotgun: { steps: 14, direction: "left", detour_steps: 14 } }), "advance")
    const biting = [{ distance: 0.8, sees_you: true, in_crosshair: false, in_bite_range: true }]
    assert.equal(fakePick({ ...base, health: 20, health_state: "critical", enemies: biting }), "retreat")
    assert.equal(fakePick({ ...base, enemies: biting }), "attack", "здоровья хватает — бьёт")
    assert.equal(fakePick({ ...base, enemies: [{ distance: 3, sees_you: true, in_crosshair: false }] }), "attack")
    assert.equal(fakePick({ ...base, enemies: [{ distance: 3, sees_you: true, in_crosshair: false }], fireballs: [{ hits_in_ms: 300, safe_side: "left" }] }), "dodge_left")
    assert.equal(fakePick({ ...base, door_ahead: "closed" }), "open")
})

// Virtual-time driver: the sim steps 20 ms frames; Jev answers come back after `latency` of sim time.
async function drive(sim: SimConsole, pick: (state: Record<string, unknown>) => Promise<JevAnswer>, latency: number, limitMs: number, log: LogRecord[] = []) {
    const pending: Array<{ at: number; done: () => void }> = []
    const jev: JevFn = async (state) => {
        const answer = await pick(state)
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

test("сценарий: эмулятор + мост + фейковый Jev с задержкой 500 мс проходят HANGAR на NORMAL", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL)
    const log: LogRecord[] = []
    const bridge = await drive(sim, fakeJev, 500, 120000, log)
    assert.equal(sim.result, "won", `застрял: клетка ${sim.world.x >> 10},${sim.world.y >> 10}`)
    assert.equal(bridge.stats.won, 1)
    assert.equal(bridge.stats.stale, 0, "ответ через 500 мс укладывается в 1200 мс")
    const decisions = log.filter((r) => r.kind === "decision")
    assert.ok(decisions.length > 10)
    assert.ok(decisions.every((r) => r.state && r.decision && r.seq), "каждое решение в логе с фактами и командой")
    assert.equal(sim.writes, decisions.length, "одна запись в ящик на решение")
    assert.equal(log.at(-1)?.kind, "won")

    const again = replay(JSON.parse(JSON.stringify(recording(sim))))
    assert.equal(again.won, true, "повтор по записанному вводу тоже выигрывает")
    assert.deepEqual([again.x, again.y, again.health, again.kills], [sim.world.x, sim.world.y, sim.world.health, sim.world.kills])
    assert.ok(sim.statuses.some(([, s]) => /^JEV ADVANCE 90% 500MS$/.test(s)), JSON.stringify(sim.statuses.slice(0, 5)))
})

test("сценарий: полный цикл с ключом — WAREHOUSE на EASY: ключ, его дверь, выход", async () => {
    const sim = new SimConsole(levelIndex(api, "WAREHOUSE"), api.DIFF_EASY)
    const log: LogRecord[] = []
    await drive(sim, fakeJev, 500, 240000, log)
    assert.equal(sim.result, "won", `застрял: клетка ${sim.world.x >> 10},${sim.world.y >> 10} hp ${sim.world.health}`)
    assert.notEqual(sim.world.keys, 0, "ключ подобран")
    const goals = log.filter((r) => r.kind === "decision").map((r) => String(r.state?.goal))
    assert.ok(goals.some((g) => /key/.test(g)), "сначала цель — ключ")
    assert.match(goals.at(-1) ?? "", /exit/, "в конце — выход")
})

test("сценарий: как на приставке — смерть даёт новую попытку через 2 с, победа — следующий уровень через 3 с", async () => {
    const sim = new SimConsole(0, api.DIFF_NORMAL, 9, true)
    const log: LogRecord[] = []
    const lines: string[] = []
    sim.onLine((l) => l === "AI WON" || l === "AI DEAD" ? lines.push(l) : 0)
    const bridge = new Bridge(sim.api, sim, fakeJev, (r) => log.push(r), () => sim.clock, 1)
    const run = async (ms: number, until: () => boolean = () => false) => {
        for (let t = 0; t < ms && !until(); t += 20) {
            sim.step()
            await new Promise((resolve) => setImmediate(resolve))
        }
    }
    await run(1000)
    sim.world.lost = true
    const diedAt = sim.clock
    await run(5000, () => sim.deaths > 0)
    assert.equal(sim.deaths, 1)
    assert.ok(Math.abs(sim.clock - diedAt - api.AI_RETRY_MS) <= 40, `${sim.clock - diedAt} мс`)
    assert.equal(sim.world.lost, false, "новая попытка с чистым миром")
    assert.deepEqual(lines, ["AI DEAD"])
    assert.equal(bridge.stats.dead, 1)

    await run(120000, () => sim.world.won)
    assert.ok(sim.world.won)
    const wonAt = sim.clock
    await run(5000, () => sim.cleared > 0)
    assert.ok(Math.abs(sim.clock - wonAt - api.AI_NEXT_MS) <= 40)
    assert.equal(api.aiLevelId(sim.session), "1", "дальше WAREHOUSE")
    await run(2000)
    assert.ok(log.some((r) => r.kind === "decision" && r.lvl === "1"), "мост перестроил теневой мир под новый уровень")
    assert.deepEqual(lines, ["AI DEAD", "AI WON"])
})

test("сценарий: посреди HANGAR игрок перехватывает управление, ходит сам и отдаёт обратно — ИИ доигрывает с того же места, без устаревших команд и рекорда", async () => {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL)
    const lines: string[] = []
    sim.onLine((l) => lines.push(l))
    const log: LogRecord[] = []
    const pending: Array<{ at: number; done: () => void }> = []
    const jev: JevFn = async (state) => {
        const answer = await fakeJev(state)
        await new Promise<void>((done) => pending.push({ at: sim.clock + 500, done }))
        return { ...answer, latencyMs: 500 }
    }
    const bridge = new Bridge(sim.api, sim, jev, (rec) => log.push(rec), () => sim.clock, 100)
    const run = async (ms: number) => {
        for (let t = 0; t < ms && !sim.result; t += 20) {
            sim.step()
            for (const p of pending.filter((p) => p.at <= sim.clock)) {
                pending.splice(pending.indexOf(p), 1)
                p.done()
            }
            await new Promise((resolve) => setImmediate(resolve))
        }
    }
    await run(3000)
    assert.ok(bridge.stats.decisions > 0)
    const world = sim.world
    const ang = world.ang
    const clock = sim.link.clock
    const walk = new sim.api.Input()
    walk.turn = 1
    sim.takeOver(walk)
    const humanFrom = lines.length
    await run(700)
    assert.deepEqual(lines.slice(humanFrom - 1, humanFrom), ["AI HUMAN"])
    assert.equal(lines.slice(humanFrom).filter((l) => l.startsWith("AI ")).length, 0, "пока играет человек, снимков нет")
    assert.equal(sim.link.clock, clock, "часы связи стоят")
    assert.equal(sim.world, world, "уровень тот же, не перезапущен")
    assert.notEqual(world.ang, ang, "ввод человека применяется")
    const given = `AI P ${world.x} ${world.y} ${world.ang} ${world.health} ${world.ammo} `
    const writesBefore = sim.writes

    sim.handBack()
    const resumeFrom = lines.length
    await run(20)
    assert.ok(lines[resumeFrom + 1]?.startsWith(given), `ИИ продолжает с места, здоровья и патронов игрока: ${lines[resumeFrom + 1]}`)
    await run(120000)
    assert.equal(sim.result, "won", `застрял: клетка ${sim.world.x >> 10},${sim.world.y >> 10}`)
    assert.equal(bridge.stats.stale, 0, "ни одна команда не пришла на снимок до перехвата")
    assert.ok(sim.writes > writesBefore)
    const human = log.findIndex((r) => r.kind === "human")
    assert.ok(human > 0)
    assert.equal(log.filter((r) => r.kind === "human").length, 1)
    assert.ok(log.slice(human + 1).some((r) => r.kind === "decision"), "после передачи Jev снова решает")
    assert.equal(bridge.stats.won, 1)
    assert.equal(sim.session.ai, true)
    assert.equal(api.noteRun(new api.Records(), sim.session), false, "уровень с ИИ рекорд не ставит")
})

test("сценарий: Jev отвечает дольше 1200 мс — игра отбрасывает команды как stale и не идёт вслепую", async () => {
    const sim = new SimConsole(0, api.DIFF_NORMAL)
    const x0 = sim.world.x
    const y0 = sim.world.y
    const bridge = await drive(sim, async () => ({ action: "advance", confidence: 1, danger: null, cost: 0, latencyMs: 0, error: "" }), 1400, 8000)
    assert.ok(bridge.stats.stale >= 3, `stale ${bridge.stats.stale}`)
    assert.deepEqual([sim.world.x, sim.world.y], [x0, y0])
    assert.equal(api.aiStatus(sim.link), api.AI_NO_LINK, "без принятых команд — NO LINK на экране")
})

test("сценарий: Jev недоступен — мост шлёт wait, игрок стоит, мост не падает", async () => {
    const sim = new SimConsole(0, api.DIFF_NORMAL)
    const down = makeJev({ key: "k", fetch: (async () => { throw new Error("offline") }) as typeof fetch })
    const bridge = await drive(sim, down, 100, 3000)
    assert.ok(bridge.stats.errors > 3)
    assert.equal(bridge.stats.errors, bridge.stats.decisions)
    assert.equal(sim.link.exec.cmd, api.AI_WAIT)
})

test("сценарий: смена уровня на приставке (другой хеш) — мост пропускает снимки, а не играет по чужой карте", async () => {
    const sim = new SimConsole(0, api.DIFF_NORMAL)
    sim.link.hash = (sim.link.hash + 1) & 0xffff
    const log: LogRecord[] = []
    const bridge = await drive(sim, fakeJev, 100, 2000, log)
    assert.equal(bridge.stats.decisions, 0)
    assert.ok(bridge.stats.skipped >= 5)
    assert.match(String(log.find((r) => r.kind === "skip")?.reason), /hash/)
})
