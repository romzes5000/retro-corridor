// The browser build runs the same game code: the map is a separate image, A on the title
// enters a level, holding forward moves the player, and the page serves both canvases.
import assert from "node:assert/strict"
import http from "node:http"
import vm from "node:vm"
import test from "node:test"
import { fakeJev } from "../bridge/fake-jev.ts"
import type { JevFn } from "../bridge/jev.ts"
import { FakeImage } from "../fake-image.ts"
import { loadGame } from "../load-logic.ts"
import { browserBundle } from "./bundle.ts"
import { startBrowser } from "./serve.ts"

test("карта уровня рисуется на отдельном кадре", () => {
    const game = loadGame()
    const session = game.corridor.startAtLevel(game.corridor.DIFF_NORMAL, 0)
    const world = game.corridor.enterLevel(session)
    const img = new FakeImage(160, 120)
    game.corridorRender.paintMap(img, world)
    assert.ok(img.pixels.some((p) => p !== 0), "на карте есть клетки")
    const empty = new FakeImage(160, 120)
    assert.notDeepEqual(img.pixels, empty.pixels)
})

test("браузерный скрипт: A с заголовка входит в уровень, ход вперёд сдвигает игрока", () => {
    const context: Record<string, unknown> = { console }
    vm.createContext(context)
    vm.runInContext(browserBundle(), context, { filename: "play.js" })
    const play = context.corridorBrowser as {
        screen: { pixels: Uint8Array }
        map: { pixels: Uint8Array }
        tick: (now: number, up: boolean, down: boolean, left: boolean, right: boolean, a: boolean, b: boolean) => void
        place: () => { mode: number, x: number, y: number }
    }
    assert.equal(play.place().mode, 0)
    play.tick(20, false, false, false, false, true, false)
    const started = play.place()
    assert.equal(started.mode, 1, "A на пункте кампании начинает уровень")
    assert.ok(play.screen.pixels.some((p) => p !== 15), "кадр не пустой")
    assert.ok(play.map.pixels.some((p) => p !== 0), "карта уровня нарисована рядом")
    for (let i = 0; i < 30; i++) play.tick(40 + i * 20, true, false, false, false, false, false)
    const moved = play.place()
    assert.ok(moved.x !== started.x || moved.y !== started.y, `игрок остался на ${started.x},${started.y}`)
})

interface Play {
    tick: (now: number, up: boolean, down: boolean, left: boolean, right: boolean, a: boolean, b: boolean) => void
    takeLines: () => string[] | null
    setBox: (bytes: number[]) => void
    place: () => { mode: number, x: number, y: number, hp: number, ai: boolean, seq: number }
}

function boot(): Play {
    const context: Record<string, unknown> = { console }
    vm.createContext(context)
    vm.runInContext(browserBundle(), context, { filename: "play.js" })
    return context.corridorBrowser as Play
}

// Title, then enough frames for the wipe, then a level a person can pause.
function enterLevel(play: Play): number {
    play.tick(20, false, false, false, false, true, false)
    let now = 40
    for (let i = 0; i < 150; i++) {
        play.tick(now, false, false, false, false, false, false)
        now += 20
    }
    return now
}

function tap(play: Play, now: number, down: boolean, a: boolean): number {
    play.tick(now, false, down, false, false, a, false)
    play.tick(now + 20, false, false, false, false, false, false)
    return now + 40
}

// Hold B past the pause threshold, then GIVE TO AI / TAKE OVER (three downs, A).
function pilot(play: Play, now: number): number {
    const held = now
    for (; now < held + 700; now += 20) play.tick(now, false, false, false, false, false, true)
    play.tick(now, false, false, false, false, false, false)
    now += 20
    for (let i = 0; i < 3; i++) now = tap(play, now, true, false)
    return tap(play, now, false, true)
}

test("ящик не откатывается на более старую команду", () => {
    const play = boot()
    const box = (seq: number) => {
        const bytes = new Array(32).fill(0)
        bytes[8] = seq & 255
        bytes[9] = seq >> 8
        return bytes
    }
    play.setBox(box(2))
    play.setBox(box(1))
    assert.equal(play.place().seq, 2)
    play.setBox(box(4))
    assert.equal(play.place().seq, 4)
    play.setBox(box(0))
    assert.equal(play.place().seq, 4)
})

test("GIVE TO AI в паузе отдаёт управление и печатает снимок, TAKE OVER возвращает", () => {
    const play = boot()
    let now = enterLevel(play)
    assert.equal(play.place().ai, false)
    now = pilot(play, now)
    assert.equal(play.place().ai, true, "GIVE TO AI включает мост")
    play.tick(now, false, false, false, false, false, false)
    const lines = play.takeLines()
    assert.ok(lines, "после передачи есть строки для моста")
    assert.ok(lines.some((l) => l.startsWith("AI S ")), lines?.join(" | "))
    assert.ok(lines.some((l) => l.startsWith("AI END ")))
    now += 20
    now = pilot(play, now)
    assert.equal(play.place().ai, false, "TAKE OVER возвращает клавиатуру")
    const back = play.takeLines()
    assert.ok(back?.includes("AI HUMAN"), back?.join(" | "))
})

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

// Jev answers "advance", but only after a pause, like the real model.
function slowJev(ms: number): JevFn {
    return async () => {
        await sleep(ms)
        return { action: "advance", confidence: 0.9, danger: null, cost: 0, latencyMs: ms, error: "" }
    }
}

function post(url: string, body: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
            headers: { "content-type": "text/plain" },
        }, (res) => {
            const chunks: Buffer[] = []
            res.on("data", (c: Buffer) => chunks.push(c))
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as number[]))
        })
        req.on("error", reject)
        req.end(body)
    })
}

test("снимок из браузера возвращает команду, и игрок сдвигается", async () => {
    const play = boot()
    let now = enterLevel(play)
    now = pilot(play, now)
    play.tick(now, false, false, false, false, false, false)
    const lines = play.takeLines()
    assert.ok(lines && lines.length > 0)
    const before = play.place()
    const srv = await startBrowser(0, fakeJev)
    try {
        const posted = await post(`${srv.url}/ai/lines`, lines.join("\n"))
        assert.equal(posted[8] | (posted[9] << 8), 0, "ответ снимка не ждёт команду")
        let box: number[] = []
        for (let i = 0; i < 50; i++) {
            box = JSON.parse(await text(`${srv.url}/ai/box`)) as number[]
            if ((box[8] | (box[9] << 8)) !== 0) break
            await sleep(10)
        }
        assert.equal(box.length, 32)
        assert.notEqual(box[8] | (box[9] << 8), 0, "мост записал seq")
        assert.notEqual(box[12], 0, "команда не пустая")
        play.setBox(box)
        for (let i = 0; i < 40; i++) play.tick(now + 20 + i * 20, false, false, false, false, false, false)
        const after = play.place()
        assert.equal(after.ai, true)
        assert.ok(after.x !== before.x || after.y !== before.y, `игрок остался на ${before.x},${before.y}`)
    } finally {
        await srv.close()
    }
})

test("пока Jev думает, снимки не копятся, и следующая команда не протухает", { timeout: 20_000 }, async () => {
    const delay = 800
    const play = boot()
    let now = enterLevel(play)
    now = pilot(play, now)
    play.tick(now, false, false, false, false, false, false)
    now += 20
    const srv = await startBrowser(0, slowJev(delay))
    const acks: string[] = []
    let sending = false
    let posted: Promise<unknown> = Promise.resolve()
    const wall0 = Date.now()
    let wall = wall0
    try {
        while (Date.now() - wall0 < 2500) {
            const w = Date.now()
            now += w - wall
            wall = w
            play.tick(now, false, false, false, false, false, false)
            if (!sending) {
                const lines = play.takeLines()
                if (lines) {
                    for (const line of lines) if (line.startsWith("AI A ")) acks.push(line)
                    sending = true
                    posted = post(`${srv.url}/ai/lines`, lines.join("\n")).then(() => { sending = false })
                }
            }
            const box = JSON.parse(await text(`${srv.url}/ai/box`)) as number[]
            if ((box[8] | (box[9] << 8)) !== 0) play.setBox(box)
            await sleep(40)
        }
        const last = acks[acks.length - 1] ?? ""
        assert.ok(acks.some((l) => /AI A [1-9]/.test(l) && !l.includes("stale")), acks.join(" | "))
        assert.ok(!last.includes("stale"), last)
    } finally {
        await posted.catch(() => {})
        await srv.close()
    }
})

function text(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            const chunks: Buffer[] = []
            res.on("data", (c: Buffer) => chunks.push(c))
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        }).on("error", reject)
    })
}

test("ответ Jev дольше секунды не оставляет игрока стоять", { timeout: 20_000 }, async () => {
    const play = boot()
    let now = enterLevel(play)
    now = pilot(play, now)
    play.tick(now, false, false, false, false, false, false)
    now += 20
    const srv = await startBrowser(0, slowJev(1100))
    const acks: string[] = []
    let sending = false
    let posted: Promise<unknown> = Promise.resolve()
    let seenMove = false
    let stillAt = 0
    const gaps: number[] = []
    let prev = play.place()
    const wall0 = Date.now()
    let wall = wall0
    try {
        while (Date.now() - wall0 < 5500) {
            const w = Date.now()
            now += w - wall
            wall = w
            play.tick(now, false, false, false, false, false, false)
            const p = play.place()
            const moved = p.x !== prev.x || p.y !== prev.y
            if (moved) {
                if (seenMove && stillAt && w - stillAt > 800) gaps.push(w - stillAt)
                seenMove = true
                stillAt = 0
            } else if (seenMove && !stillAt) stillAt = w
            prev = p
            if (!sending) {
                const lines = play.takeLines()
                if (lines) {
                    for (const line of lines) if (line.startsWith("AI A ")) acks.push(line)
                    sending = true
                    posted = post(`${srv.url}/ai/lines`, lines.join("\n")).then(() => { sending = false })
                }
            }
            const box = JSON.parse(await text(`${srv.url}/ai/box`)) as number[]
            if ((box[8] | (box[9] << 8)) !== 0) play.setBox(box)
            await sleep(40)
        }
        if (seenMove && stillAt && Date.now() - stillAt > 800) gaps.push(Date.now() - stillAt)
        assert.ok(seenMove, "игрок так и не пошёл")
        assert.ok(gaps.length <= 1 && gaps.every((g) => g < 1600), `стоит ${gaps.join(", ")} мс`)
        assert.ok(!acks.some((l) => l.includes("stale")), acks.slice(-6).join(" | "))
    } finally {
        await posted.catch(() => {})
        await srv.close()
    }
})

test("выстрел в браузере отдаётся странице один раз", () => {
    const context: Record<string, unknown> = { console }
    vm.createContext(context)
    vm.runInContext(browserBundle(), context, { filename: "play.js" })
    const play = context.corridorBrowser as {
        tick: (now: number, up: boolean, down: boolean, left: boolean, right: boolean, a: boolean, b: boolean) => void
        takeEvents: () => string[]
    }
    play.tick(20, false, false, false, false, true, false)
    let now = 40
    for (; now < 2000; now += 20) play.tick(now, false, false, false, false, false, false)
    play.takeEvents()
    play.tick(now, false, false, false, false, true, false)
    const heard = play.takeEvents()
    assert.ok(heard.includes("shoot") || heard.includes("empty"), heard.join(","))
    assert.equal(play.takeEvents().length, 0)
})

test("страница браузерной игры отдаёт кадр, карту и тот же код", async () => {
    const srv = await startBrowser(0)
    try {
        const page = await text(`${srv.url}/`)
        assert.match(page, /<canvas id="screen" width="160" height="120">/)
        assert.match(page, /<canvas id="map" width="160" height="120">/)
        assert.match(page, /src="\/play\.js"/)
        assert.match(page, /align-items: flex-start/)
        const js = await text(`${srv.url}/play.js`)
        assert.match(js, /var corridorBrowser/)
        assert.match(js, /paintMap/)
        assert.match(page, /corridorSfx/)
        assert.match(page, /takeEvents/)
        assert.match(page, /\/ai\/lines/)
        assert.match(page, /\/ai\/box/)
        assert.equal(await text(`${srv.url}/healthz`), "ok\n")
    } finally {
        await srv.close()
    }
})
