// Film of AI play: recording the console stream, interpolating between snapshots, inferring
// effects, and rendering a GIF or MP4 with the game's renderer.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadGame, type World } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { ffmpegArgs, FilmPlayer, FilmRecorder, FRAME_MS, lerpAngle, makeFilm, parseFilm, renderFilm, TAIL_MS, toRgb, type FilmFrame, type FilmRecord } from "./film.ts"
import { Bridge, type LogRecord } from "./loop.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { levelIndex, SimConsole } from "./sim.ts"

const game = loadGame()
const api = game.corridor

function hangar(): { world: World; link: any } {
    const world = api.enterLevel(api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL))
    const link = new api.AiLink(7)
    api.aiEnterLevel(link, api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), world)
    return { world, link }
}

function snap(link: any, world: World, t: number): Snapshot {
    link.clock = t
    const parser = new Parser()
    for (const line of api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]) {
        const msg = parser.line(line)
        if (msg?.kind === "snapshot") return msg.snap
    }
    throw new Error("no snapshot")
}

const frameAt = (frames: FilmFrame[], t: number) => frames.find((f) => f.t === t) as FilmFrame

// Frames copy the world object, so keep what each one showed.
function collect(player: FilmPlayer, step = FRAME_MS): Array<FilmFrame & { x: number; y: number; ang: number; dead: boolean[]; deadMs: number[]; hurt: number[]; shotX: number[] }> {
    const out = []
    for (const f of player.frames(step)) {
        out.push({
            ...f,
            events: [...f.events],
            x: f.world.x,
            y: f.world.y,
            ang: f.world.ang,
            dead: f.world.enemies.map((e) => e.dead),
            deadMs: f.world.enemies.map((e) => e.deadMs),
            hurt: f.world.enemies.map((e) => e.hurt),
            shotX: f.world.shots.map((s) => s.x),
        })
    }
    return out
}

test("угол интерполируется по короткой дуге через 0", () => {
    assert.equal(lerpAngle(1000, 20, 0.5), 1022)
    assert.equal(lerpAngle(10, 1000, 0.5), 1017)
    assert.equal(lerpAngle(100, 300, 0.25), 150)
    assert.equal(lerpAngle(100, 300, 0), 100)
})

test("запись: снимок, решение со временем последнего снимка, конец уровня; мусор и не-решения пропускаются", () => {
    const { world, link } = hangar()
    const out: FilmRecord[] = []
    const rec = new FilmRecorder((r) => out.push(r))
    rec.line("console: fps 30")
    for (const line of api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]) rec.line(line)
    link.clock = 750
    for (const line of api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]) rec.line(line)
    const decision = { kind: "decision", at: 1, answer: { action: "advance", confidence: 0.834, danger: 0.7, cost: 0, latencyMs: 512, error: "" }, decision: { label: "ADVANCE" } } as unknown as LogRecord
    rec.record(decision)
    rec.record({ kind: "skip", at: 2, reason: "x" })
    rec.line("AI WON")
    assert.deepEqual(out.map((r) => r.k), ["s", "s", "j", "end"])
    assert.deepEqual(out[2], { k: "j", t: 750, label: "ADVANCE", conf: 83, latency: 512, danger: 0.7 })
    assert.deepEqual(out[3], { k: "end", t: 750, result: "won" })
    assert.deepEqual(parseFilm(out.map((r) => JSON.stringify(r)).join("\n") + "\n\n"), out)
})

test("проигрыватель: игрок, враг и шар между снимками сглажены, длинная пауза не сглаживается", () => {
    const { world, link } = hangar()
    const x0 = world.x
    const e0 = world.enemies[0].x
    world.shots.push(new api.Shot(world.x + 3000, world.y, -2000, 0))
    const s0 = snap(link, world, 1000)
    world.x += 1000
    world.ang = (world.ang + 200) & 1023
    world.enemies[0].x += 500
    world.shots[0].x -= 500
    const s1 = snap(link, world, 1250)
    world.x += 1000
    const s2 = snap(link, world, 4000)
    const frames = collect(new FilmPlayer(api, [{ k: "s", snap: s0 }, { k: "s", snap: s1 }, { k: "s", snap: s2 }]))
    assert.equal(frames[0].t, 1000)
    assert.equal(frameAt(frames, 1120).x, x0 + 480)
    assert.equal(frameAt(frames, 1120).ang, (s0.ang + 96) & 1023)
    assert.equal(frameAt(frames, 1120).world.enemies[0].x, frames.at(-1)?.world.enemies[0].x, "кадры делят мир")
    assert.equal(frameAt(frames, 1120).shotX[0], s0.shots[0].x - 240, "шар летит по своей скорости")
    assert.equal(frameAt(frames, 2000).x, x0 + 1000, "2,75 с без снимков — стоим, не ползём")
    assert.equal(frames.at(-1)?.x, x0 + 2000)
    assert.ok(e0 < world.enemies[0].x)
    assert.equal(frames.length, 76, "от 1000 до 4000 мс шагом 40")
})

test("проигрыватель: выстрел, урон, попадание, убийство и подбор выводятся из разницы снимков", () => {
    const { world, link } = hangar()
    const s0 = snap(link, world, 0)
    world.ammo -= 1
    world.health -= 10
    world.enemies[0].hp -= 1
    const s1 = snap(link, world, 250)
    world.enemies[0].dead = true
    world.items[0].taken = true
    const s2 = snap(link, world, 500)
    world.weapon = api.WEAPON_SHOTGUN
    world.hasShotgun = true
    world.ammo -= 2
    const s3 = snap(link, world, 750)
    const s4 = snap(link, world, 1000)
    const records: FilmRecord[] = [s0, s1, s2, s3, s4].map((snap) => ({ k: "s", snap }))
    const frames = collect(new FilmPlayer(api, records))
    assert.deepEqual(frameAt(frames, 280).events, ["shoot", "hurt", "hit"])
    assert.ok(frameAt(frames, 280).hurt[0] > 0, "кадр боли у врага")
    assert.equal(frameAt(frames, 240).hurt[0], 0)
    const kind = world.items[0].kind
    const pickup = kind === api.ITEM_SHOTGUN ? "weapon" : kind === api.ITEM_HEALTH || kind === api.ITEM_AMMO ? "pickup" : "unlock"
    assert.deepEqual(frameAt(frames, 520).events, ["kill", pickup])
    assert.equal(frameAt(frames, 520).dead[0], true)
    assert.ok(frameAt(frames, 600).deadMs[0] > frameAt(frames, 520).deadMs[0], "анимация смерти идёт")
    assert.equal(frameAt(frames, 520).world.kills, 1)
    assert.deepEqual(frameAt(frames, 760).events, ["blast"])
    assert.deepEqual(frameAt(frames, 40).events, [])
})

test("проигрыватель: строка JEV из последнего решения, красная при danger от 0.6; конец уровня — табличка и хвост", () => {
    const { world, link } = hangar()
    const s0 = snap(link, world, 0)
    const s1 = snap(link, world, 500)
    const records: FilmRecord[] = [
        { k: "s", snap: s0 },
        { k: "j", t: 0, label: "ADVANCE", conf: 90, latency: 480, danger: 0.2 },
        { k: "j", t: 250, label: "ATTACK", conf: 70, latency: 510, danger: 0.8 },
        { k: "s", snap: s1 },
        { k: "end", t: 500, result: "won" },
    ]
    const player = new FilmPlayer(api, records)
    assert.equal(player.durationMs, 500 + TAIL_MS)
    const frames = collect(player)
    assert.deepEqual([frameAt(frames, 200).line, frameAt(frames, 200).alert], ["JEV ADVANCE 90% 480MS", false])
    assert.deepEqual([frameAt(frames, 280).line, frameAt(frames, 280).alert], ["JEV ATTACK 70% 510MS", true])
    assert.equal(frameAt(frames, 480).banner, "")
    assert.equal(frameAt(frames, 520).banner, "AI WON")
    assert.equal(frames.at(-1)?.t, 2000)
    const dead = collect(new FilmPlayer(api, [{ k: "s", snap: s0 }, { k: "end", t: 0, result: "dead" }]))
    assert.equal(dead.at(-1)?.banner, "AI DEAD")
    assert.equal(dead[0].line, "JEV", "решений ещё не было")
})

test("проигрыватель: после победы или на новом уровне мир строится заново, чужая карта — ошибка", () => {
    const { world, link } = hangar()
    const s0 = snap(link, world, 0)
    world.enemies[0].dead = true
    const s1 = snap(link, world, 250)
    const fresh = hangar()
    const s2 = snap(fresh.link, fresh.world, 300)
    const records: FilmRecord[] = [{ k: "s", snap: s0 }, { k: "s", snap: s1 }, { k: "end", t: 250, result: "won" }, { k: "s", snap: s2 }]
    const frames = collect(new FilmPlayer(api, records))
    assert.equal(frameAt(frames, 280).dead[0], true, "конец первой попытки")
    assert.equal(frames.at(-1)?.dead[0], false, "новая попытка — враг снова жив")
    assert.equal(frames.at(-1)?.world === frames[0].world, false)
    const broken = { ...s0, hash: (s0.hash + 1) & 0xffff }
    assert.throws(() => [...new FilmPlayer(api, [{ k: "s", snap: broken }]).frames()], /version mismatch/)
})

test("запись и проигрыватель: AI HUMAN закрывает отрезок табличкой PLAYER, после передачи ИИ игрок не плывёт от места перехвата", () => {
    const { world, link } = hangar()
    const x0 = world.x
    const out: FilmRecord[] = []
    const rec = new FilmRecorder((r) => out.push(r))
    const send = (t: number) => {
        link.clock = t
        for (const line of api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[]) rec.line(line)
    }
    send(0)
    send(250)
    rec.line("AI HUMAN")
    world.x += 3000
    send(300)
    send(550)
    assert.deepEqual(out[2], { k: "end", t: 250, result: "human" })
    const frames = collect(new FilmPlayer(api, out))
    assert.deepEqual([frameAt(frames, 280).x, frameAt(frames, 280).banner], [x0, "PLAYER"], "хвост отрезка ИИ стоит на месте перехвата")
    assert.equal(frameAt(frames, 300).x, x0 + 3000, "новый отрезок начинается с места передачи")
    assert.equal(frameAt(frames, 300).banner, "")
})

test("кадр в rgb по палитре; ffmpeg увеличивает 160x120 в 4 раза без сглаживания", () => {
    const img = { width: 2, height: 1, pixels: new Uint8Array([0, 1]) } as never
    assert.deepEqual([...toRgb(img, [[1, 2, 3], [4, 5, 6]])], [1, 2, 3, 4, 5, 6])
    const args = ffmpegArgs("out.mp4")
    assert.equal(args.at(-1), "out.mp4")
    assert.ok(args.includes("scale=640:480:flags=neighbor"))
    assert.equal(args[args.indexOf("-s") + 1], "160x120")
    assert.equal(args[args.indexOf("-r") + 1], "25")
})

// HANGAR with the fake Jev in virtual time, recorded the way `npm run ai -- --film` does.
async function filmedHangar(): Promise<FilmRecord[]> {
    const sim = new SimConsole(levelIndex(api, "HANGAR"), api.DIFF_NORMAL, 5)
    const records: FilmRecord[] = []
    const film = new FilmRecorder((r) => records.push(r))
    sim.onLine((line) => film.line(line))
    const pending: Array<{ at: number; done: () => void }> = []
    const bridge = new Bridge(sim.api, sim, async (s) => {
        const a = await fakeJev(s)
        await new Promise<void>((done) => pending.push({ at: sim.clock + 500, done }))
        return { ...a, latencyMs: 500 }
    }, (r) => film.record(r), () => sim.clock, 1)
    while (!sim.result && sim.clock < 120000) {
        sim.step()
        for (const p of pending.filter((p) => p.at <= sim.clock)) {
            pending.splice(pending.indexOf(p), 1)
            p.done()
        }
        await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(sim.result, "won")
    assert.ok(bridge.stats.decisions > 10)
    return records
}

test("сценарий: прохождение HANGAR записывается и рендерится игровым рендером в GIF, до таблички AI WON", async () => {
    const records = await filmedHangar()
    const kinds = new Set(records.map((r) => r.k))
    assert.deepEqual([...kinds].sort(), ["end", "j", "s"])
    const shots = new Set<string>()
    let last: FilmFrame | null = null
    let count = 0
    for (const { frame, img } of renderFilm(game, records)) {
        if (count % 25 === 0) shots.add(Buffer.from(img.pixels).toString("base64"))
        last = frame
        count++
    }
    const player = new FilmPlayer(api, records)
    assert.equal(count, Math.floor(player.durationMs / FRAME_MS) + 1)
    assert.equal(last?.banner, "AI WON")
    assert.ok(shots.size > count / 25 - 3, "картинка меняется")

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "film-"))
    const input = path.join(dir, "film.jsonl")
    fs.writeFileSync(input, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const gif = path.join(dir, "clip.gif")
    const frames = await makeFilm(input, gif, 2, game)
    assert.equal(frames, Math.floor(player.durationMs / (2 * FRAME_MS)) + 1, "--speed 2 — вдвое меньше кадров")
    assert.equal(fs.readFileSync(gif).subarray(0, 6).toString(), "GIF89a")
})

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0

test("сценарий: та же запись собирается в MP4 640x480", { skip: hasFfmpeg ? false : "ffmpeg не установлен" }, async () => {
    const records = await filmedHangar()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "film-"))
    const input = path.join(dir, "film.jsonl")
    fs.writeFileSync(input, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const out = path.join(dir, "clip.mp4")
    const frames = await makeFilm(input, out, 1, game)
    const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", out], { encoding: "utf8" })
    assert.equal(probe.stdout.trim(), `640,480,${frames}`)
})
