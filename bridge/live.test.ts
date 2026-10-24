// Live view: frames LIVE_DELAY_MS behind the latest snapshot, segments per attempt, the banners,
// the frame encoding, and the HTTP page and SSE stream fed by a simulated run.
import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { loadGame, type World } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { FilmRecorder, GAP_MS, TAIL_MS, type FilmRecord } from "./film.ts"
import { encodeFrame, LIVE_DELAY_MS, LivePlayer, NO_SIGNAL, startWatch } from "./live.ts"
import { Bridge } from "./loop.ts"
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
    const watch = await startWatch(game, live, { port: 0, frameMs: 5 })
    try {
        const page = await get(`${watch.url}/`)
        assert.equal(page.status, 200)
        assert.match(page.body, /<canvas id="screen" width="160" height="120">/)
        assert.match(page.body, /new EventSource\("\/stream"\)/)
        assert.match(page.body, /body \{[^}]*align-items: flex-start/, "лента не растягивает кадр по высоте")
        assert.match(page.body, /#side \{[^}]*height: 480px;[^}]*overflow: hidden/, "лента не выше кадра")
        assert.match(page.body, /ol \{[^}]*overflow-y: auto/)
        assert.equal((await get(`${watch.url}/healthz`)).body, "ok\n")
        assert.equal((await get(`${watch.url}/nope`)).status, 404)

        const client = await listen(`${watch.url}/stream`)
        assert.equal(client.headers["content-type"], "text/event-stream")
        const events = client.events

        const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
        const recorder = new FilmRecorder((rec) => live.push(rec))
        sim.onLine((line) => recorder.line(line))
        new Bridge(sim.api, sim, fakeJev, (rec) => recorder.record(rec), () => sim.clock)
        for (let i = 0; i < 400; i++) {
            sim.step()
            if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 6))
        }
        await sleep(50)
        client.close()

        assert.equal(events[0].event, "palette")
        assert.equal(JSON.parse(events[0].data).length, 16)
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
