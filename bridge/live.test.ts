// Live view: frames LIVE_DELAY_MS behind the latest snapshot, segments per attempt, the banners,
// the frame encoding, and the HTTP page and SSE stream fed by a simulated run.
import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { loadGame, type World } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { FilmRecorder, GAP_MS, TAIL_MS, type FilmRecord } from "./film.ts"
import { LessonStore, type Draft } from "./lessons.ts"
import { encodeFrame, LIVE_DELAY_MS, LiveBoard, LivePlayer, NO_SIGNAL, startWatch } from "./live.ts"
import { Bridge, emptyStats, type LogRecord } from "./loop.ts"
import { LiveMap } from "./map.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { levelIndex, SimConsole } from "./sim.ts"

const game = loadGame()
const api = game.corridor

function hangar(): { world: World; link: any } {
    const session = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    const world = api.enterLevel(session)
    const link = new api.AiLink(7)
    api.aiEnterLevel(link, session, world)
    return { world, link }
}

function snap(link: any, world: World, t: number): FilmRecord {
    link.clock = t
    const parser = new Parser()
    for (const line of api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]) {
        const msg = parser.line(line)
        if (msg?.kind === "snapshot") return { k: "s", snap: msg.snap as Snapshot }
    }
    throw new Error("no snapshot")
}

test("живой кадр: до второго снимка кадра нет, дальше — на 300 мс позади, позиция сглажена, время не идёт назад", () => {
    let wall = 0
    const live = new LivePlayer(game, () => wall)
    const { world, link } = hangar()
    const x0 = world.x
    live.push(snap(link, world, 1000))
    assert.equal(live.frame(), null)
    world.x += 1000
    wall = 250
    live.push(snap(link, world, 1250))
    wall = 250 + LIVE_DELAY_MS - 125
    const mid = live.frame()
    assert.equal(mid?.t, 1125)
    assert.equal(mid?.world.x, x0 + 500)
    assert.equal(mid?.banner, "")
    wall = 250 + LIVE_DELAY_MS + 400
    assert.deepEqual([live.frame()?.t, live.frame()?.world.x], [1250, x0 + 1000], "дальше последнего снимка не уходит")
    wall = 260
    assert.equal(live.frame()?.t, 1250, "назад не идёт")
})

test("живой кадр: без снимков дольше GAP_MS — NO SIGNAL; смерть — табличка TAIL_MS, потом новая попытка", () => {
    let wall = 0
    const live = new LivePlayer(game, () => wall)
    const { world, link } = hangar()
    live.push(snap(link, world, 0))
    wall = 250
    live.push(snap(link, world, 250))
    wall = 250 + GAP_MS + 1
    assert.equal(live.frame()?.banner, NO_SIGNAL)
    live.push({ k: "end", t: 250, result: "dead" })
    assert.equal(live.frame()?.banner, "AI DEAD")
    live.push(snap(link, world, 5000))
    assert.equal(live.frame()?.banner, "AI DEAD", "табличка держится, пока новая попытка набирает снимки")
    wall += TAIL_MS
    assert.equal(live.frame(), null, "у новой попытки пока один снимок")
    wall += 250
    live.push(snap(link, world, 5250))
    assert.equal(live.frame()?.banner, "")
})

test("живой кадр: решения Jev уходят подписчику; кадр — 19 200 индексов палитры", () => {
    let wall = 0
    const live = new LivePlayer(game, () => wall)
    const seen: string[] = []
    live.onJev = (j) => seen.push(j.label)
    const { world, link } = hangar()
    live.push(snap(link, world, 0))
    live.push({ k: "j", t: 0, label: "ADVANCE", conf: 80, latency: 400, danger: 0.1 })
    wall = 250
    live.push(snap(link, world, 250))
    assert.deepEqual(seen, ["ADVANCE"])
    const frame = live.frame()
    assert.ok(frame)
    const bytes = Buffer.from(encodeFrame(frame.img), "base64")
    assert.equal(bytes.length, 160 * 120)
    assert.deepEqual([...bytes.subarray(0, 64)], [...frame.img.pixels.subarray(0, 64)])
})

test("живой кадр: снимок чужой карты не ломает поток, проблема видна", () => {
    const live = new LivePlayer(game, () => 0)
    const rec = snap(hangar().link, hangar().world, 0)
    if (rec.k !== "s") throw new Error("snapshot")
    live.push({ k: "s", snap: { ...rec.snap, hash: rec.snap.hash ^ 1 } })
    assert.equal(live.frame(), null)
    assert.match(live.problem, /hash/i)
})

function boardOnHangar(store: LessonStore | null): { board: LiveBoard; key: string } {
    const live = new LivePlayer(game, () => 0)
    const { world, link } = hangar()
    const first = snap(link, world, 0)
    live.push(first)
    live.push(snap(link, world, 250))
    if (first.k !== "s") throw new Error("snapshot")
    return { board: new LiveBoard(api, live, store), key: `${first.snap.lvl}:${first.snap.hash}` }
}

const lessonDraft = (over: Partial<Draft>): Draft => ({ scope: "zone", zone: { x: 3, y: 1, r: 2 }, when: ["biter_near"], do: "retreat", why: "imp bit", ...over })

test("доска: заметки о смерти, победе, уроке, подмене, лечении, таймере, ошибке и пропуске; обычное решение молчит", () => {
    const { board } = boardOnHangar(null)
    const decision = (over: Partial<LogRecord>): LogRecord => ({
        kind: "decision", at: 0, answer: { action: "advance", confidence: 0.5, danger: null, cost: 0, latencyMs: 400, error: "" },
        decision: { action: "advance", label: "ADVANCE" } as LogRecord["decision"], ...over,
    })
    assert.equal(board.record(decision({})), null)
    assert.deepEqual(board.record(decision({ lesson: "L2", override: true, decision: { action: "heal", label: "HEAL!" } as LogRecord["decision"] })),
        { kind: "override", text: "L2 replaced advance with HEAL!" })
    assert.deepEqual(board.record(decision({ forced: true })), { kind: "heal", text: "low health: advance replaced with heal" })
    assert.deepEqual(board.record(decision({ answer: { action: "wait", confidence: 0, danger: null, cost: 0, latencyMs: 0, error: "timeout" } })), { kind: "error", text: "Jev: timeout" })
    assert.deepEqual(board.record({ kind: "watchdog", at: 0, reason: "still for 6000 ms" }), { kind: "watchdog", text: "watchdog: still for 6000 ms, advance" })
    assert.deepEqual(board.record({ kind: "dead", at: 0 }), { kind: "dead", text: "died on HANGAR" })
    assert.deepEqual(board.record({ kind: "won", at: 0 }), { kind: "won", text: "won HANGAR" })
    assert.deepEqual(board.record({ kind: "skip", at: 0, reason: "map hash 1 != 2" }), { kind: "error", text: "skipped: map hash 1 != 2" })
    const store = new LessonStore(null)
    const lesson = store.add("0:1", lessonDraft({}), "llm")
    const note = board.record({ kind: "lesson", at: 0, learned: { lesson, verdict: "new", source: "llm", failed: [], note: "" } })
    assert.equal(note?.kind, "lesson")
    assert.match(note?.text ?? "", /^lesson new by llm: L1 zone 3,1 r2: biter_near -> retreat \(imp bit\)/)
})

test("доска: статус — уровень по имени, здоровье, оружие, убийства, счётчики Jev и правил, fps; уроки уровня первыми, действующий отмечен", () => {
    const store = new LessonStore(null)
    const { board, key } = boardOnHangar(store)
    const other = store.add("2:999", lessonDraft({ why: "elsewhere" }), "rule")
    const here = store.add(key, lessonDraft({ why: "here" }), "llm")
    const global = store.add("global", lessonDraft({ scope: "global", zone: null, when: ["health_below_40"], do: "heal", why: "everywhere" }), "llm")
    board.stats = () => ({ ...emptyStats(), decisions: 3, latencies: [100, 300, 200], cost: 0.002, won: 1, dead: 2, watchdog: 1, forcedHeal: 4, lessonActive: 5, lessonOverride: 1 })
    board.line("fps 27 q3 step 2")
    board.line("AI S 1 2 3")
    board.record({ kind: "decision", at: 0, lesson: here.id })
    const s = board.status()
    assert.deepEqual([s.level, s.hp, s.weapon, s.kills, s.enemies], ["HANGAR", 100, "pistol", 0, api.enterLevel(api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)).enemies.length])
    assert.deepEqual([s.won, s.dead, s.decisions, s.medianMs, s.cost, s.watchdog, s.forcedHeal, s.lessonActive, s.lessonOverride, s.fps], [1, 2, 3, 200, 0.002, 1, 4, 5, 1, 27])
    assert.deepEqual(s.lessons?.list.map((l) => [l.id, l.here]), [[here.id, true], [global.id, true], [other.id, false]])
    assert.equal(s.lessons?.active, here.id)
    assert.equal(s.lessons?.list[1].where, "global")
    board.record({ kind: "dead", at: 0 })
    assert.equal(board.status().lessons?.active, null, "после конца попытки урок не в силе")
    assert.equal(boardOnHangar(null).board.status().lessons, null, "уроки выключены")
})

function get(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = ""
            res.on("data", (d) => (body += d))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
        }).on("error", reject)
    })
}

// SSE client: collects events until closed.
async function listen(url: string): Promise<{ events: Array<{ event: string; data: string }>; close: () => void; headers: http.IncomingHttpHeaders }> {
    const events: Array<{ event: string; data: string }> = []
    const req = http.get(url)
    const res = await new Promise<http.IncomingMessage>((resolve) => req.on("response", resolve))
    let buf = ""
    res.on("data", (d) => {
        buf += d
        let end
        while ((end = buf.indexOf("\n\n")) >= 0) {
            const [e, data] = buf.slice(0, end).split("\n")
            events.push({ event: e.replace("event: ", ""), data: data.replace("data: ", "") })
            buf = buf.slice(end + 2)
        }
    })
    return { events, close: () => req.destroy(), headers: res.headers }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("поток: новый клиент получает текущий кадр, а не тот, что видел прошлый", async () => {
    let wall = 0
    const live = new LivePlayer(game, () => wall)
    const { world, link } = hangar()
    live.push(snap(link, world, 0))
    wall = 250
    live.push(snap(link, world, 250))
    const watch = await startWatch(game, live, { port: 0, frameMs: 5 })
    try {
        const first = await listen(`${watch.url}/stream`)
        await sleep(40)
        assert.equal(watch.clients(), 1)
        first.close()
        while (watch.clients() > 0) await sleep(2)
        assert.ok(first.events.some((e) => e.event === "frame"))
        live.push({ k: "end", t: 250, result: "dead" })
        await sleep(20)
        const second = await listen(`${watch.url}/stream`)
        await sleep(40)
        second.close()
        const next = second.events.filter((e) => e.event === "frame").map((e) => e.data)
        assert.ok(next.length > 0)
        const now = live.frame()
        assert.equal(now?.banner, "AI DEAD")
        assert.equal(next[0], encodeFrame(now.img), "первый кадр второго клиента — текущий, с табличкой")
    } finally {
        await watch.close()
    }
})

test("сценарий: страница и поток — палитра, кадры и решения Jev с прохождения HANGAR; отключение клиента не роняет сервер", async () => {
    const live = new LivePlayer(game)
    const board = new LiveBoard(api, live, null)
    const watch = await startWatch(game, live, { port: 0, frameMs: 5, status: () => board.status(), statusMs: 20 })
    try {
        const page = await get(`${watch.url}/`)
        assert.equal(page.status, 200)
        assert.match(page.body, /<canvas id="screen" width="160" height="120">/)
        assert.match(page.body, /new EventSource\("\/stream"\)/)
        assert.match(page.body, /body \{[^}]*align-items: flex-start/, "лента не растягивает кадр по высоте")
        assert.match(page.body, /#side \{[^}]*height: 480px;[^}]*overflow: hidden/, "лента не выше кадра")
        assert.match(page.body, /#feed \{[^}]*overflow-y: auto/)
        assert.match(page.body, /#lessons \{[^}]*max-height: \d+px;[^}]*overflow-y: auto/, "уроки не вытесняют ленту")
        assert.equal((await get(`${watch.url}/healthz`)).body, "ok\n")
        assert.equal((await get(`${watch.url}/nope`)).status, 404)

        const client = await listen(`${watch.url}/stream`)
        assert.equal(client.headers["content-type"], "text/event-stream")
        const events = client.events

        const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
        const recorder = new FilmRecorder((rec) => live.push(rec))
        sim.onLine((line) => recorder.line(line))
        const bridge = new Bridge(sim.api, sim, fakeJev, (rec) => {
            recorder.record(rec)
            const note = board.record(rec)
            if (note) watch.publish("note", note)
        }, () => sim.clock)
        board.stats = () => bridge.stats
        for (let i = 0; i < 400; i++) {
            sim.step()
            if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 6))
        }
        watch.publish("note", { kind: "won", text: "won HANGAR" })
        await sleep(50)
        client.close()

        assert.equal(events[0].event, "palette")
        assert.equal(JSON.parse(events[0].data).length, 16)
        assert.equal(events[1].event, "status", "статус сразу при подключении")
        const statuses = events.filter((e) => e.event === "status").map((e) => JSON.parse(e.data))
        assert.ok(statuses.length > 2, "статус идёт и дальше")
        const lastStatus = statuses[statuses.length - 1]
        assert.equal(lastStatus.level, "HANGAR")
        assert.ok(lastStatus.decisions > 0)
        assert.equal(lastStatus.lessons, null)
        assert.deepEqual(events.filter((e) => e.event === "note").map((e) => JSON.parse(e.data)).at(-1), { kind: "won", text: "won HANGAR" })
        assert.match(page.body, /id="lessons"/)
        assert.match(page.body, /addEventListener\("status"/)
        assert.match(page.body, /addEventListener\("note"/)
        const frames = events.filter((e) => e.event === "frame")
        assert.ok(frames.length >= 10, `кадров ${frames.length}`)
        assert.ok(frames.every((f) => Buffer.from(f.data, "base64").length === 160 * 120))
        const jev = events.filter((e) => e.event === "jev").map((e) => JSON.parse(e.data))
        assert.ok(jev.length > 0 && jev.every((j) => typeof j.label === "string" && typeof j.conf === "number"))

        await sleep(20)
        assert.equal((await get(`${watch.url}/healthz`)).body, "ok\n", "сервер жив после ухода клиента")
    } finally {
        await watch.close()
    }
})

test("сценарий: карта и маршрут с прохождения HANGAR — холст карты на странице, карта раз на попытку, оверлей с путём от игрока до цели; /map получает только карту", async () => {
    const live = new LivePlayer(game)
    const map = new LiveMap(api, live)
    const watch = await startWatch(game, live, { port: 0, frameMs: 5, map: () => map.map(), overlay: () => map.overlay(), overlayMs: 10 })
    try {
        const page = await get(`${watch.url}/`)
        assert.match(page.body, /<canvas id="screen" width="160" height="120">/)
        assert.match(page.body, /<canvas id="map" /)
        assert.match(page.body, /mapView\(stream\)/)
        assert.match(page.body, /addEventListener\("overlay"/)
        assert.match(page.body, /#side \{[^}]*height: 480px;[^}]*overflow: hidden/, "панель справа не растёт из-за карты")
        const alone = await get(`${watch.url}/map`)
        assert.equal(alone.status, 200)
        assert.match(alone.body, /<canvas id="map" /)
        assert.match(alone.body, /new EventSource\("\/stream\?only=map"\)/)
        assert.doesNotMatch(alone.body, /id="screen"/)

        const client = await listen(`${watch.url}/stream`)
        const mapClient = await listen(`${watch.url}/stream?only=map`)
        const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
        const recorder = new FilmRecorder((rec) => live.push(rec))
        sim.onLine((line) => recorder.line(line))
        const bridge = new Bridge(sim.api, sim, fakeJev, (rec) => recorder.record(rec), () => sim.clock)
        map.route = () => bridge.route
        const play = async (steps: number) => {
            for (let i = 0; i < steps; i++) {
                sim.step()
                if (i % 10 === 0) await sleep(6)
            }
        }
        await play(300)
        live.push({ k: "end", t: sim.clock, result: "dead" })
        await play(40)
        await sleep(40)
        const late = await listen(`${watch.url}/stream`)
        await sleep(5)
        client.close()
        mapClient.close()
        late.close()
        assert.deepEqual(late.events.slice(0, 3).map((e) => e.event), ["palette", "map", "overlay"], "новый клиент сразу получает карту и оверлей")
        assert.equal(JSON.parse(late.events[1].data).seg, 2)

        const maps = client.events.filter((e) => e.event === "map").map((e) => JSON.parse(e.data))
        assert.deepEqual(maps.map((m) => m.seg), [1, 2], "карта — раз на попытку; повтор той же карты — новая попытка")
        assert.deepEqual([maps[0].level, maps[0].w, maps[0].h, maps[0].rows[14][15], maps[0].doors.length], ["HANGAR", 16, 16, "E", 2])
        const overlays = client.events.filter((e) => e.event === "overlay").map((e) => JSON.parse(e.data))
        assert.ok(overlays.length > 5, `оверлеев ${overlays.length}`)
        assert.ok(overlays.every((o) => maps.some((m) => m.seg === o.seg)), "оверлей не опережает свою карту")
        const routed = overlays.filter((o) => o.goal && o.path.length > 1)
        assert.ok(routed.length > 0)
        const ends = (o: any) => JSON.stringify(o.goal.kind === "exit" ? o.path.at(-2) : o.path.at(-1)) === JSON.stringify(o.goal.cell)
        assert.ok(routed.every((o) => typeof o.goal.what === "string" && ends(o)), "путь ведёт в клетку цели")
        assert.ok(routed.some((o) => o.path[0][0] === Math.floor(o.player.x) && o.path[0][1] === Math.floor(o.player.y)), "путь начинается с клетки игрока")
        assert.deepEqual([...new Set(mapClient.events.map((e) => e.event))].sort(), ["map", "overlay"], "/map не тянет кадры")
    } finally {
        await watch.close()
    }
})

test("поток: первый оверлей нового клиента — там, где игрок сейчас, а не где был, когда никто не смотрел", async () => {
    let wall = 0
    const live = new LivePlayer(game, () => wall)
    const map = new LiveMap(api, live)
    const { world, link } = hangar()
    const x0 = world.x
    live.push(snap(link, world, 0))
    world.x += 1000
    wall = 250
    live.push(snap(link, world, 250))
    wall = 250 + LIVE_DELAY_MS + 400
    const watch = await startWatch(game, live, { port: 0, frameMs: 60000, map: () => map.map(), overlay: () => map.overlay(), overlayMs: 60000 })
    try {
        const client = await listen(`${watch.url}/stream?only=map`)
        await sleep(20)
        client.close()
        const first = client.events.find((e) => e.event === "overlay")
        assert.ok(first)
        assert.equal(JSON.parse(first.data).player.x, Math.round(((x0 + 1000) / api.FP) * 100) / 100)
    } finally {
        await watch.close()
    }
})
