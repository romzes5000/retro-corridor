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
    | { k: "end"; t: number; result: SegmentEnd }

// How an AI segment ended: a win, a death, or the player taking the controls.
export type SegmentEnd = "won" | "dead" | "human"

export function endBanner(end: SegmentEnd): string {
    switch (end) {
        case "won":
            return "AI WON"
        case "dead":
            return "AI DEAD"
        case "human":
            return "PLAYER"
        default: {
            const never: never = end
            return never
        }
    }
}

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
    end: SegmentEnd | null
}

// One segment per stretch of AI play: a new run, level or map, or an end record (won, dead, the
// player took over), starts the next, so a hand-back is never interpolated from where they took over.
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

export type JevRecord = Extract<FilmRecord, { k: "j" }>

export const jevLine = (j: JevRecord | null): string => (j ? `JEV ${j.label} ${j.conf}% ${j.latency}MS` : "JEV")

// Red status line: Jev's danger when it gave one, else the console's own threat rule.
export const jevAlert = (j: JevRecord | null, seg: SegmentPlayer): boolean => (j && j.danger !== null ? j.danger >= ALARM : seg.threat())

// Plays the records back frame by frame on a world rebuilt from the game code.
export class FilmPlayer {
    private readonly api: LogicApi
    private readonly segs: Segment[]
    private readonly jev: JevRecord[]

    constructor(api: LogicApi, records: FilmRecord[]) {
        this.api = api
        this.segs = segments(records)
        this.jev = records.filter((r): r is JevRecord => r.k === "j")
    }

    // Length of the film in console ms, tails included.
    get durationMs(): number {
        return this.segs.reduce((sum, s) => sum + s.snaps[s.snaps.length - 1].t - s.snaps[0].t + (s.end ? TAIL_MS : 0), 0)
    }

    // `stepMs` of console time per frame: FRAME_MS plays at 1x, 2 * FRAME_MS at 2x.
    *frames(stepMs = FRAME_MS): Generator<FilmFrame> {
        for (const seg of this.segs) {
            const player = new SegmentPlayer(this.api, seg.snaps[0])
            for (const s of seg.snaps.slice(1)) player.push(s)
            const last = seg.snaps[seg.snaps.length - 1].t
            const stop = last + (seg.end ? TAIL_MS : 0)
            for (let t = seg.snaps[0].t; t <= stop; t += stepMs) {
                const events = player.frameAt(t, stepMs)
                const j = this.latestJev(t)
                yield {
                    t,
                    world: player.world,
                    events,
                    line: jevLine(j),
                    alert: jevAlert(j, player),
                    banner: t > last && seg.end ? endBanner(seg.end) : "",
                }
            }
        }
    }

    private latestJev(t: number): JevRecord | null {
        let best: JevRecord | null = null
        for (const j of this.jev) {
            if (j.t > t) break
            best = j
        }
        return best
    }
}

// One level attempt played on a world rebuilt from the game code. Snapshots may keep arriving
// while it plays; frame times must not go backwards.
export class SegmentPlayer {
    readonly world: World
    readonly snaps: Snapshot[]
    private readonly api: LogicApi
    private readonly dying = new Map<number, number>()
    private at = 0

    constructor(api: LogicApi, first: Snapshot) {
        const shadow = new Shadow(api)
        const world = shadow.sync(first)
        if (!world) throw new Error(`level ${first.lvl}: ${shadow.problem}`)
        this.api = api
        this.world = world
        this.snaps = [first]
    }

    get lastT(): number {
        return this.snaps[this.snaps.length - 1].t
    }

    push(snap: Snapshot): void {
        this.snaps.push(snap)
    }

    // Moves the world to console time `t`; returns the game events since the previous frame.
    frameAt(t: number, dt: number): string[] {
        const events: string[] = []
        const snaps = this.snaps
        while (this.at + 1 < snaps.length && snaps[this.at + 1].t <= t) {
            this.at++
            this.changes(this.world, snaps[this.at - 1], snaps[this.at], events, this.dying, t)
        }
        const a = snaps[this.at]
        const b = snaps[this.at + 1]
        const f = b && b.t - a.t <= GAP_MS ? (t - a.t) / (b.t - a.t) : 0
        this.place(this.world, a, f > 0 ? b : null, f, t, dt, this.dying)
        return events
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
        next.doors.forEach((state, i) => {
            if (state === prev.doors[i]) return
            if (state === api.DOOR_OPENING || state === api.DOOR_CLOSING) events.push("door")
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
    threat(): boolean {
        const api = this.api
        const world = this.world
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
        drawBanner(game, img, frame.banner)
        yield { frame, img }
    }
}

// Big centred caption with a shadow: green for a win, red otherwise.
export function drawBanner(game: Game, img: FakeImage, banner: string): void {
    if (!banner) return
    const r = game.corridorRender
    const w = r.textWidth(banner, 2)
    r.text(img as never, banner, 80 - (w >> 1) + 1, 51, 15, 2)
    r.text(img as never, banner, 80 - (w >> 1), 50, banner === "AI WON" ? 5 : 2, 2)
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
