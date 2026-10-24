// AI gameplay film: the bridge records every console snapshot and every Jev decision, and this
// file plays them back through the game's own renderer on the Mac. Snapshots come every 250 ms,
// so motion in between is interpolated and shots, hits, kills and pickups are inferred from how
// one snapshot differs from the next. A reconstruction, not a screen capture.
//   npm run ai -- --film                   record while playing on the console
//   npm run ai:film -- bridge/out/film-X.jsonl [--out clip.mp4|clip.gif] [--speed 2]
import { spawn } from "node:child_process"
import fs from "node:fs"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { FakeImage } from "../fake-image.ts"
import { loadGame, type Game, type LogicApi, type World } from "../load-logic.ts"
import { Frame, encodeGif, paste, rgbList } from "../demo/frames.ts"
import { inBiteReach } from "./damage.ts"
import type { LogRecord } from "./loop.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { Shadow } from "./shadow.ts"

export type FilmRecord =
    | { k: "s"; snap: Snapshot }
    | { k: "j"; t: number; label: string; conf: number; latency: number; danger: number | null }
    | { k: "end"; t: number; result: "won" | "dead" }

// Snapshots further apart than this (pause, lost link) are not interpolated across.
export const GAP_MS = 1500
export const FRAME_MS = 40
export const TAIL_MS = 1500
const ALARM = 0.6
const ALARM_SHOT_MS = 700
const HURT_MS = 200
const ATTACK_MS = 250
const SHOT_REACH = 2048

export class FilmRecorder {
    private readonly parser = new Parser()
    private t = 0
    private readonly write: (rec: FilmRecord) => void

    constructor(write: (rec: FilmRecord) => void) {
        this.write = write
    }

    // Every console line, the same stream the bridge reads.
    line(raw: string): void {
        const msg = this.parser.line(raw)
        if (!msg) return
        if (msg.kind === "snapshot") {
            this.t = msg.snap.t
            this.write({ k: "s", snap: msg.snap })
        } else {
            this.write({ k: "end", t: this.t, result: msg.kind })
        }
    }

    // Every bridge log record; decisions become the JEV status line from the latest snapshot on.
    record(rec: LogRecord): void {
        if (rec.kind !== "decision" || !rec.decision || !rec.answer) return
        this.write({
            k: "j",
            t: this.t,
            label: rec.decision.label,
            conf: Math.round(rec.answer.confidence * 100),
            latency: rec.answer.latencyMs,
            danger: rec.answer.danger,
        })
    }
}

export function parseFilm(text: string): FilmRecord[] {
    return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as FilmRecord)
}

export function lerpAngle(a: number, b: number, f: number, angles = 1024): number {
    const d = ((b - a + angles / 2) & (angles - 1)) - angles / 2
    return (a + Math.round(d * f)) & (angles - 1)
}

const lerp = (a: number, b: number, f: number) => Math.round(a + (b - a) * f)

export interface FilmFrame {
    // Console time of the frame, ms.
    t: number
    world: World
    events: string[]
    line: string
    alert: boolean
    banner: string
}

interface Segment {
    snaps: Snapshot[]
    end: "won" | "dead" | null
}

// One segment per level attempt: a new run, level or map, or a won/dead record, starts the next.
function segments(records: FilmRecord[]): Segment[] {
    const out: Segment[] = []
    let cur: Segment | null = null
    let key = ""
    for (const r of records) {
        if (r.k === "s") {
            const k = `${r.snap.run}:${r.snap.lvl}:${r.snap.hash}`
            if (!cur || k !== key || cur.end) {
                cur = { snaps: [], end: null }
                out.push(cur)
                key = k
            }
            cur.snaps.push(r.snap)
        } else if (r.k === "end" && cur && !cur.end) {
            cur.end = r.result
        }
    }
    return out.filter((s) => s.snaps.length > 0)
}

// Plays the records back frame by frame on a world rebuilt from the game code.
export class FilmPlayer {
    private readonly api: LogicApi
    private readonly segs: Segment[]
    private readonly jev: Array<Extract<FilmRecord, { k: "j" }>>

    constructor(api: LogicApi, records: FilmRecord[]) {
        this.api = api
        this.segs = segments(records)
        this.jev = records.filter((r): r is Extract<FilmRecord, { k: "j" }> => r.k === "j")
    }

    // Length of the film in console ms, tails included.
    get durationMs(): number {
        return this.segs.reduce((sum, s) => sum + s.snaps[s.snaps.length - 1].t - s.snaps[0].t + (s.end ? TAIL_MS : 0), 0)
    }

    // `stepMs` of console time per frame: FRAME_MS plays at 1x, 2 * FRAME_MS at 2x.
    *frames(stepMs = FRAME_MS): Generator<FilmFrame> {
        for (const seg of this.segs) {
            const shadow = new Shadow(this.api)
            const world = shadow.sync(seg.snaps[0])
            if (!world) throw new Error(`level ${seg.snaps[0].lvl}: ${shadow.problem}`)
            const dying = new Map<number, number>()
            let at = 0
            const start = seg.snaps[0].t
            const last = seg.snaps[seg.snaps.length - 1].t
            const stop = last + (seg.end ? TAIL_MS : 0)
            for (let t = start; t <= stop; t += stepMs) {
                const events: string[] = []
                while (at + 1 < seg.snaps.length && seg.snaps[at + 1].t <= t) {
                    at++
                    this.changes(world, seg.snaps[at - 1], seg.snaps[at], events, dying, t)
                }
                const a = seg.snaps[at]
                const b = seg.snaps[at + 1]
                const f = b && b.t - a.t <= GAP_MS ? (t - a.t) / (b.t - a.t) : 0
                this.place(world, a, f > 0 ? b : null, f, t, stepMs, dying)
                const j = this.latestJev(t)
                yield {
                    t,
                    world,
                    events,
                    line: j ? `JEV ${j.label} ${j.conf}% ${j.latency}MS` : "JEV",
                    alert: j && j.danger !== null ? j.danger >= ALARM : this.threat(world),
                    banner: t > last && seg.end ? (seg.end === "won" ? "AI WON" : "AI DEAD") : "",
                }
            }
        }
    }

    private latestJev(t: number): Extract<FilmRecord, { k: "j" }> | null {
        let best: Extract<FilmRecord, { k: "j" }> | null = null
        for (const j of this.jev) {
            if (j.t > t) break
            best = j
        }
        return best
    }

    // What happened between two snapshots, as the game's own event names for the renderer.
    private changes(world: World, prev: Snapshot, next: Snapshot, events: string[], dying: Map<number, number>, t: number): void {
        const api = this.api
        if (next.ammo < prev.ammo) events.push(next.weapon === api.WEAPON_SHOTGUN ? "blast" : "shoot")
        if (next.hp < prev.hp) {
            events.push("hurt")
            for (const e of next.enemies) if (inBiteReach(api, next.x, next.y, e)) world.enemies[e.i].attack = ATTACK_MS
        }
        if (next.hp > prev.hp) events.push("pickup")
        for (const e of prev.enemies) {
            const now = next.enemies.find((n) => n.i === e.i)
            if (!now) {
                events.push("kill")
                dying.set(e.i, t)
            } else if (now.hp < e.hp) {
                events.push("hit")
                world.enemies[e.i].hurt = HURT_MS
            }
        }
        if (next.shots.length > prev.shots.length) {
            for (const s of next.shots.slice(prev.shots.length)) {
                const shooter = next.enemies.find((e) => api.distance(e.x, e.y, s.x, s.y) <= SHOT_REACH && api.ENEMY_BITE[e.kind] === 0)
                if (shooter) world.enemies[shooter.i].attack = ATTACK_MS
            }
        }
        next.taken.forEach((taken, i) => {
            if (!taken || prev.taken[i] || !world.items[i]) return
            const kind = world.items[i].kind
            events.push(kind === api.ITEM_SHOTGUN ? "weapon" : kind === api.ITEM_HEALTH || kind === api.ITEM_AMMO ? "pickup" : "unlock")
        })
    }

    // World at fraction `f` of the way from snapshot a to b (b null: hold a).
    private place(world: World, a: Snapshot, b: Snapshot | null, f: number, t: number, dt: number, dying: Map<number, number>): void {
        const api = this.api
        world.x = b ? lerp(a.x, b.x, f) : a.x
        world.y = b ? lerp(a.y, b.y, f) : a.y
        world.ang = b ? lerpAngle(a.ang, b.ang, f, api.ANGLES) : a.ang
        world.health = a.hp
        world.ammo = a.ammo
        world.weapon = a.weapon
        if (a.weapon === api.WEAPON_SHOTGUN) world.hasShotgun = true
        world.keys = a.keys
        world.exitLocked = a.locked
        world.time = t
        world.enemies.forEach((enemy, i) => {
            const e = a.enemies.find((s) => s.i === i)
            enemy.hurt = Math.max(0, enemy.hurt - dt)
            enemy.attack = Math.max(0, enemy.attack - dt)
            if (!e) {
                enemy.dead = true
                const since = dying.get(i)
                enemy.deadMs = since === undefined ? 10000 : t - since
                return
            }
            const n = b?.enemies.find((s) => s.i === i)
            const x = n ? lerp(e.x, n.x, f) : e.x
            const y = n ? lerp(e.y, n.y, f) : e.y
            if (!enemy.dead) enemy.walk += Math.abs(x - enemy.x) + Math.abs(y - enemy.y)
            enemy.dead = false
            enemy.x = x
            enemy.y = y
            enemy.hp = e.hp
            enemy.sees = e.sees
            enemy.awake = true
        })
        world.kills = world.enemies.filter((e) => e.dead).length
        world.shots = a.shots.map((s) => {
            const ms = t - a.t
            return new api.Shot(s.x + Math.round((s.vx * ms) / 1000), s.y + Math.round((s.vy * ms) / 1000), s.vx, s.vy)
        })
        const step = Math.ceil((api.FP * dt) / api.DOOR_OPEN_MS)
        a.doors.forEach((state, i) => {
            const door = world.doors[i]
            if (!door) return
            door.state = state
            if (state === api.DOOR_OPEN) door.progress = api.FP
            else if (state === api.DOOR_CLOSED) door.progress = 0
            else if (state === api.DOOR_OPENING) door.progress = Math.min(api.FP, door.progress + step)
            else door.progress = Math.max(0, door.progress - step)
        })
        world.items.forEach((item, i) => {
            item.taken = a.taken[i] ?? false
        })
    }

    // Without Jev's danger: the console's own rule, a fireball about to land or a biter in reach.
    private threat(world: World): boolean {
        const api = this.api
        if (world.shots.some((s) => {
            const eta = api.aiShotEta(world, s)
            return eta >= 0 && eta < ALARM_SHOT_MS
        })) return true
        return world.enemies.some((e) => !e.dead && api.ENEMY_BITE[e.kind] > 0
            && api.distance(world.x, world.y, e.x, e.y) <= api.IMP_REACH + api.ENEMY_RADIUS[e.kind] - api.IMP_RADIUS)
    }
}

// Renders every frame of the film into 160x120 images, the console's own resolution.
export function* renderFilm(game: Game, records: FilmRecord[], speed = 1): Generator<{ frame: FilmFrame; img: FakeImage }> {
    const r = game.corridorRender
    const player = new FilmPlayer(game.corridor, records)
    const view = new r.View()
    view.mode = r.MODE_PLAY
    const img = new FakeImage(160, 120)
    for (const frame of player.frames(FRAME_MS * speed)) {
        r.react(view, frame.events)
        r.tick(view, FRAME_MS * speed)
        view.aiLine = frame.line
        view.aiAlert = frame.alert
        r.draw(img as never, frame.world, view)
        if (frame.banner) {
            const w = r.textWidth(frame.banner, 2)
            r.text(img as never, frame.banner, 80 - (w >> 1) + 1, 51, 15, 2)
            r.text(img as never, frame.banner, 80 - (w >> 1), 50, frame.banner === "AI WON" ? 5 : 2, 2)
        }
        yield { frame, img }
    }
}

export function toRgb(img: FakeImage, palette: number[][]): Buffer {
    const out = Buffer.alloc(img.width * img.height * 3)
    for (let i = 0; i < img.pixels.length; i++) {
        const [r, g, b] = palette[img.pixels[i]] ?? [0, 0, 0]
        out[i * 3] = r
        out[i * 3 + 1] = g
        out[i * 3 + 2] = b
    }
    return out
}

// 160x120 rgb24 frames on stdin, 4x nearest-neighbour like the panel, H.264 for any player.
export function ffmpegArgs(out: string, fps = 1000 / FRAME_MS): string[] {
    return [
        "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "160x120", "-r", String(fps), "-i", "-",
        "-vf", "scale=640:480:flags=neighbor",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", out,
    ]
}

export async function makeFilm(input: string, out: string, speed = 1, game: Game = loadGame()): Promise<number> {
    const records = parseFilm(fs.readFileSync(input, "utf8"))
    const palette = rgbList(game.corridorArt.PALETTE)
    let count = 0
    if (out.endsWith(".gif")) {
        const frames: Frame[] = []
        for (const { img } of renderFilm(game, records, speed)) {
            const frame = new Frame(320, 240)
            paste(frame, img, 0, 0, 2)
            frames.push(frame)
        }
        fs.writeFileSync(out, encodeGif(frames, palette, FRAME_MS))
        return frames.length
    }
    const ff = spawn("ffmpeg", ffmpegArgs(out), { stdio: ["pipe", "inherit", "inherit"] })
    const done = new Promise<void>((resolve, reject) => {
        ff.on("error", reject)
        ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))))
    })
    for (const { img } of renderFilm(game, records, speed)) {
        if (!ff.stdin.write(toRgb(img, palette))) await new Promise((resolve) => ff.stdin.once("drain", resolve))
        count++
    }
    ff.stdin.end()
    await done
    return count
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { out: { type: "string" }, speed: { type: "string", default: "1" } },
    })
    const input = positionals[0]
    if (!input) throw new Error("usage: npm run ai:film -- bridge/out/film-X.jsonl [--out clip.mp4|clip.gif] [--speed 2]")
    const out = values.out ?? input.replace(/\.jsonl$/, "") + ".mp4"
    const frames = await makeFilm(input, out, Number(values.speed))
    console.log(`${out}: ${frames} frames, ${((frames * FRAME_MS) / 1000).toFixed(1)} s`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
