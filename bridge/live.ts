// Live view of AI play in a browser. The bridge renders frames from the console snapshots with the
// same player as the film, LIVE_DELAY_MS behind the latest snapshot so that there is always a next
// one to interpolate towards, and streams them over SSE as palette indices with Jev's decisions.
//   npm run ai -- --watch               then open http://localhost:8787
//   npm run ai -- --watch --watch-host 0.0.0.0   reachable from a phone on the same network
import http from "node:http"
import type { AddressInfo } from "node:net"
import { rgbList } from "../demo/frames.ts"
import { FakeImage } from "../fake-image.ts"
import type { Game, LogicApi, World } from "../load-logic.ts"
import { drawBanner, FRAME_MS, GAP_MS, jevAlert, jevLine, SegmentPlayer, TAIL_MS, type FilmRecord, type JevRecord } from "./film.ts"
import { learnedLine, lessonWhere, type Lesson, type LessonStore } from "./lessons.ts"
import { emptyStats, percentile, type LogRecord, type Stats } from "./loop.ts"
import { MAP_PAGE, MAP_PANEL, MAP_SCRIPT, MAP_STYLE, OVERLAY_MS } from "./map.ts"
import type { Snapshot } from "./protocol.ts"

export const LIVE_DELAY_MS = 300
export const WATCH_PORT = 8787
export const NO_SIGNAL = "NO SIGNAL"
export const STATUS_MS = 1000
const JEV_KEEP = 50

export interface LiveFrame {
    // Console time of the frame, ms.
    t: number
    world: World
    img: FakeImage
    banner: string
}

interface Ended {
    seg: SegmentPlayer
    end: "won" | "dead"
    until: number
}

// Turns the film records into frames as they arrive. `now` is wall time.
export class LivePlayer {
    onJev: ((j: JevRecord) => void) | null = null
    problem = ""
    // Bumped on every level attempt, the key of the map the page shows.
    segment = 0
    private readonly game: Game
    private readonly now: () => number
    private readonly view: any
    private readonly img = new FakeImage(160, 120)
    private seg: SegmentPlayer | null = null
    private key = ""
    private end: "won" | "dead" | null = null
    // Last attempt, kept on screen with its banner for TAIL_MS after it ended.
    private ended: Ended | null = null
    // Latest snapshot: console time and the wall time it arrived.
    private anchor = { t: 0, wall: 0 }
    private t = -Infinity
    private jev: JevRecord[] = []

    constructor(game: Game, now: () => number = Date.now) {
        this.game = game
        this.now = now
        this.view = new game.corridorRender.View()
        this.view.mode = game.corridorRender.MODE_PLAY
    }

    get latest(): Snapshot | null {
        return this.seg ? this.seg.snaps[this.seg.snaps.length - 1] : null
    }

    get world(): World | null {
        return this.seg?.world ?? null
    }

    push(rec: FilmRecord): void {
        if (rec.k === "j") {
            this.jev.push(rec)
            if (this.jev.length > JEV_KEEP) this.jev.shift()
            this.onJev?.(rec)
            return
        }
        if (rec.k === "end") {
            if (this.seg && !this.end) this.end = rec.result
            return
        }
        const snap = rec.snap
        const key = `${snap.run}:${snap.lvl}:${snap.hash}`
        if (!this.seg || key !== this.key || this.end) {
            if (this.seg && this.end) this.ended = { seg: this.seg, end: this.end, until: this.now() + TAIL_MS }
            try {
                this.seg = new SegmentPlayer(this.game.corridor, snap)
                this.problem = ""
            } catch (err) {
                this.seg = null
                this.problem = err instanceof Error ? err.message : String(err)
            }
            this.segment++
            this.key = key
            this.end = null
            this.t = -Infinity
            this.jev = this.jev.filter((j) => j.t >= snap.t)
        } else {
            this.seg.push(snap)
        }
        this.anchor = { t: snap.t, wall: this.now() }
    }

    // The frame to show now, or null while there is nothing to interpolate yet.
    frame(): LiveFrame | null {
        const wall = this.now()
        if (this.ended && wall < this.ended.until) {
            const { seg, end } = this.ended
            return this.draw(seg, seg.lastT, 0, end === "won" ? "AI WON" : "AI DEAD")
        }
        this.ended = null
        const seg = this.seg
        if (!seg || seg.snaps.length < 2) return null
        const since = wall - this.anchor.wall
        const t = Math.max(this.t, seg.snaps[0].t, Math.min(seg.lastT, this.anchor.t + since - LIVE_DELAY_MS))
        const dt = this.t === -Infinity ? FRAME_MS : t - this.t
        this.t = t
        const banner = this.end ? (this.end === "won" ? "AI WON" : "AI DEAD") : since > GAP_MS ? NO_SIGNAL : ""
        return this.draw(seg, t, dt, banner, seg.frameAt(t, dt))
    }

    private draw(seg: SegmentPlayer, t: number, dt: number, banner: string, events: string[] = []): LiveFrame {
        const r = this.game.corridorRender
        const j = this.latestJev(t)
        r.react(this.view, events)
        r.tick(this.view, dt)
        this.view.aiLine = jevLine(j)
        this.view.aiAlert = jevAlert(j, seg)
        r.draw(this.img as never, seg.world, this.view)
        drawBanner(this.game, this.img, banner)
        return { t, world: seg.world, img: this.img, banner }
    }

    private latestJev(t: number): JevRecord | null {
        let best: JevRecord | null = null
        for (const j of this.jev) if (j.t <= t) best = j
        return best
    }
}

export interface LessonView {
    id: string
    where: string
    when: string[]
    do: string
    why: string
    deaths: number
    wins: number
    failed: number
    source: string
    // Holds on the level being played: a zone lesson of this map or a global one.
    here: boolean
}

export interface LiveStatus {
    level: string | null
    hp: number | null
    ammo: number | null
    weapon: "pistol" | "shotgun" | null
    keys: number | null
    kills: number | null
    enemies: number | null
    won: number
    dead: number
    decisions: number
    medianMs: number
    p95Ms: number
    errors: number
    cost: number
    watchdog: number
    forcedHeal: number
    lessonActive: number
    lessonOverride: number
    fps: number | null
    // Null when lessons are off.
    lessons: { active: string | null; list: LessonView[] } | null
}

export interface LiveNote {
    kind: "lesson" | "won" | "dead" | "watchdog" | "override" | "heal" | "error"
    text: string
}

// What the page shows next to the picture: the bridge's counters, the level, the lessons, and a
// note for every event worth a line in the feed.
export class LiveBoard {
    stats: () => Stats = emptyStats
    private readonly api: LogicApi
    private readonly player: LivePlayer
    private readonly store: LessonStore | null
    private fps: number | null = null
    private active: string | null = null

    constructor(api: LogicApi, player: LivePlayer, store: LessonStore | null) {
        this.api = api
        this.player = player
        this.store = store
    }

    // Console lines that are not AI protocol: the game reports `fps N` every 5 s.
    line(raw: string): void {
        const m = raw.match(/^fps (\d+)/)
        if (m) this.fps = Number(m[1])
    }

    record(rec: LogRecord): LiveNote | null {
        switch (rec.kind) {
            case "decision":
                this.active = rec.lesson ?? null
                if (rec.answer?.error) return { kind: "error", text: `Jev: ${rec.answer.error}` }
                if (rec.override) return { kind: "override", text: `${rec.lesson} replaced ${rec.answer?.action} with ${rec.decision?.label}` }
                if (rec.forced) return { kind: "heal", text: `low health: ${rec.answer?.action} replaced with heal` }
                return null
            case "watchdog":
                return { kind: "watchdog", text: `watchdog: ${rec.reason ?? "stalled"}, advance` }
            case "won":
            case "dead":
                this.active = null
                return { kind: rec.kind, text: `${rec.kind === "won" ? "won" : "died on"} ${this.levelName(this.player.latest?.lvl ?? null) ?? "the level"}` }
            case "lesson":
                return rec.learned ? { kind: "lesson", text: learnedLine(rec.learned) } : null
            case "skip":
                return { kind: "error", text: `skipped: ${rec.reason ?? ""}` }
            default: {
                const never: never = rec.kind
                return never
            }
        }
    }

    status(): LiveStatus {
        const s = this.stats()
        const snap = this.player.latest
        const world = this.player.world
        const key = snap ? `${snap.lvl}:${snap.hash}` : ""
        return {
            level: this.levelName(snap?.lvl ?? null),
            hp: snap?.hp ?? null,
            ammo: snap?.ammo ?? null,
            weapon: snap ? (snap.weapon === this.api.WEAPON_SHOTGUN ? "shotgun" : "pistol") : null,
            keys: snap?.keys ?? null,
            kills: world ? world.enemies.length - (snap?.enemies.length ?? 0) : null,
            enemies: world ? world.enemies.length : null,
            won: s.won,
            dead: s.dead,
            decisions: s.decisions,
            medianMs: percentile(s.latencies, 0.5),
            p95Ms: percentile(s.latencies, 0.95),
            errors: s.errors,
            cost: s.cost,
            watchdog: s.watchdog,
            forcedHeal: s.forcedHeal,
            lessonActive: s.lessonActive,
            lessonOverride: s.lessonOverride,
            fps: this.fps,
            lessons: this.store ? { active: this.active, list: this.lessonList(key) } : null,
        }
    }

    // Lessons of this level first, then the rest; the strongest first within each.
    private lessonList(key: string): LessonView[] {
        const views = (this.store?.lessons ?? []).map((l: Lesson) => ({
            id: l.id, where: lessonWhere(l), when: [...l.when], do: l.do, why: l.why, deaths: l.deaths, wins: l.wins, failed: l.failed, source: l.source,
            here: l.scope === "global" || l.key === key,
        }))
        return views.sort((a, b) => Number(b.here) - Number(a.here) || (b.wins - b.deaths) - (a.wins - a.deaths))
    }

    private levelName(lvl: string | null): string | null {
        if (lvl === null) return null
        return /^\d+$/.test(lvl) ? (this.api.LEVELS[Number(lvl)]?.name ?? lvl) : lvl
    }
}

// Palette indices of a 160x120 frame, one byte per pixel, as base64.
export function encodeFrame(img: FakeImage): string {
    return Buffer.from(img.pixels.buffer, img.pixels.byteOffset, img.pixels.byteLength).toString("base64")
}

export interface Watch {
    url: string
    port: number
    // Open /stream connections.
    clients(): number
    // Sends an event to every open stream.
    publish(event: string, data: unknown): void
    close(): Promise<void>
}

export interface WatchOptions {
    port?: number
    host?: string
    frameMs?: number
    // Sent as a `status` event to every new stream and then every statusMs.
    status?: () => unknown
    statusMs?: number
    // Sent as `map` when its seg changes (and to every new stream), `overlay` every overlayMs.
    map?: () => { seg: number } | null
    overlay?: () => unknown
    overlayMs?: number
}

const MAP_EVENTS = new Set(["map", "overlay"])

// Serves the page on /, the map alone on /map and the stream on /stream: `palette` once, then
// `frame`, `jev`, `status`, `map`, `overlay` and published events. /stream?only=map carries just
// the map events.
export async function startWatch(game: Game, player: LivePlayer, opts: WatchOptions = {}): Promise<Watch> {
    const host = opts.host ?? "127.0.0.1"
    const clients = new Set<http.ServerResponse>()
    const mapOnly = new WeakSet<http.ServerResponse>()
    const palette = JSON.stringify(rgbList(game.corridorArt.PALETTE))
    let last = ""
    let mapSeg = -1
    let lastOverlay = ""
    const send = (res: http.ServerResponse, event: string, data: string) => res.write(`event: ${event}\ndata: ${data}\n\n`)
    const publish = (event: string, data: unknown) => {
        const text = JSON.stringify(data)
        for (const c of clients) if (!mapOnly.has(c) || MAP_EVENTS.has(event)) send(c, event, text)
    }
    // A new attempt goes to every stream once; the overlay only when it changed.
    const mapTick = () => {
        const map = opts.map?.()
        if (map && map.seg !== mapSeg) {
            mapSeg = map.seg
            lastOverlay = ""
            publish("map", map)
        }
        const overlay = opts.overlay?.()
        if (!overlay) return
        const text = JSON.stringify(overlay)
        if (text === lastOverlay) return
        lastOverlay = text
        for (const c of clients) send(c, "overlay", text)
    }
    player.onJev = (j) => publish("jev", j)
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            res.end(PAGE)
        } else if (url.pathname === "/map") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            res.end(MAP_PAGE)
        } else if (url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" })
            res.end("ok\n")
        } else if (url.pathname === "/stream") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
            res.flushHeaders()
            const only = url.searchParams.get("only") === "map"
            if (only) mapOnly.add(res)
            if (!only) send(res, "palette", palette)
            last = ""
            if (opts.status && !only) send(res, "status", JSON.stringify(opts.status()))
            // The world only moves when a frame is drawn, and no frames are drawn without streams.
            if (clients.size === 0 && opts.overlay) player.frame()
            const map = opts.map?.()
            if (map) {
                if (map.seg !== mapSeg) {
                    mapSeg = map.seg
                    publish("map", map)
                }
                send(res, "map", JSON.stringify(map))
                const overlay = opts.overlay?.()
                if (overlay) send(res, "overlay", JSON.stringify(overlay))
            }
            clients.add(res)
            res.on("close", () => clients.delete(res))
        } else {
            res.writeHead(404)
            res.end()
        }
    })
    const timer = setInterval(() => {
        if (clients.size === 0) return
        const frame = player.frame()
        if (!frame) return
        const data = encodeFrame(frame.img)
        if (data === last) return
        last = data
        for (const c of clients) if (!mapOnly.has(c)) send(c, "frame", data)
    }, opts.frameMs ?? FRAME_MS)
    const status = opts.status
    const statusTimer = status ? setInterval(() => {
        if (clients.size > 0) publish("status", status())
    }, opts.statusMs ?? STATUS_MS) : null
    const mapTimer = opts.map || opts.overlay ? setInterval(() => {
        if (clients.size > 0) mapTick()
    }, opts.overlayMs ?? OVERLAY_MS) : null
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(opts.port ?? WATCH_PORT, host, () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    return {
        url: `http://${host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host}:${port}`,
        port,
        clients: () => clients.size,
        publish,
        close: () => {
            clearInterval(timer)
            if (statusTimer) clearInterval(statusTimer)
            if (mapTimer) clearInterval(mapTimer)
            for (const c of clients) c.end()
            clients.clear()
            const closed = new Promise<void>((resolve) => server.close(() => resolve()))
            server.closeAllConnections()
            return closed
        },
    }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corridor - AI live</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 13px/1.4 ui-monospace, Menlo, monospace; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 16px; }
  #screen { flex: none; width: 640px; max-width: 100%; height: auto; aspect-ratio: 4 / 3; image-rendering: pixelated; background: #000; }
  #side { flex: 1; min-width: 280px; height: 480px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  h2 { flex: none; margin: 0; font-size: 11px; font-weight: normal; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  #status { flex: none; }
  #status.off { color: #e55; }
  #stats { flex: none; display: grid; grid-template-columns: max-content 1fr; gap: 1px 12px; }
  #stats dt { color: #888; }
  #stats dd { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #lessons { flex: none; max-height: 132px; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
  #lessons li { padding: 2px 4px; border-left: 2px solid #333; margin-bottom: 2px; }
  #lessons li.here { border-left-color: #c90; }
  #lessons li.active { background: #3a2f00; border-left-color: #fc0; }
  #lessons .why { color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #lessons .empty { color: #666; border: 0; }
  #feed { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
  #feed li { padding: 2px 0; border-bottom: 1px solid #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #feed li.danger, #feed li.dead, #feed li.error { color: #e55; }
  #feed li.won { color: #5c5; }
  #feed li.lesson, #feed li.override { color: #fc0; }
  #feed li.heal, #feed li.watchdog { color: #6af; }
${MAP_STYLE}
</style>
</head>
<body>
<canvas id="screen" width="160" height="120"></canvas>
<div id="side">
  <div id="status" class="off">connecting...</div>
  <dl id="stats"></dl>
  <h2 id="lessons-title">Lessons</h2>
  <ol id="lessons"></ol>
  <h2>Feed</h2>
  <ol id="feed"></ol>
</div>
${MAP_PANEL}
<script>
${MAP_SCRIPT}
  const ctx = document.getElementById("screen").getContext("2d")
  const image = ctx.createImageData(160, 120)
  const status = document.getElementById("status")
  const stats = document.getElementById("stats")
  const lessons = document.getElementById("lessons")
  const lessonsTitle = document.getElementById("lessons-title")
  const feed = document.getElementById("feed")
  let palette = []
  const el = (tag, cls, text) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }
  const add = (cls, text) => {
    feed.prepend(el("li", cls, text))
    while (feed.children.length > 100) feed.lastChild.remove()
  }
  const dash = (v, f) => (v === null || v === undefined ? "-" : f ? f(v) : String(v))
  const stream = new EventSource("/stream")
  mapView(stream)
  stream.onopen = () => { status.textContent = "live"; status.className = "" }
  stream.onerror = () => { status.textContent = "no link to the bridge, retrying"; status.className = "off" }
  stream.addEventListener("palette", (e) => { palette = JSON.parse(e.data) })
  stream.addEventListener("frame", (e) => {
    const bytes = atob(e.data)
    for (let i = 0; i < bytes.length; i++) {
      const c = palette[bytes.charCodeAt(i)] || [0, 0, 0]
      image.data[i * 4] = c[0]
      image.data[i * 4 + 1] = c[1]
      image.data[i * 4 + 2] = c[2]
      image.data[i * 4 + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
  })
  stream.addEventListener("jev", (e) => {
    const j = JSON.parse(e.data)
    const danger = j.danger === null ? "" : " danger " + Math.round(j.danger * 100) + "%"
    add(j.danger !== null && j.danger >= 0.6 ? "danger" : "", j.label + " " + j.conf + "% " + j.latency + " ms" + danger)
  })
  stream.addEventListener("note", (e) => {
    const n = JSON.parse(e.data)
    add(n.kind, n.text)
  })
  stream.addEventListener("status", (e) => {
    const s = JSON.parse(e.data)
    const rows = [
      ["level", dash(s.level)],
      ["health", dash(s.hp)],
      ["weapon", s.weapon ? s.weapon + ", ammo " + s.ammo + (s.keys ? ", keys " + s.keys : "") : "-"],
      ["kills", s.enemies === null ? "-" : s.kills + " / " + s.enemies],
      ["attempts", "won " + s.won + ", died " + s.dead],
      ["jev", s.decisions + " decisions, " + s.medianMs + " ms median, p95 " + s.p95Ms + " ms" + (s.errors ? ", errors " + s.errors : "")],
      ["cost", "$" + s.cost.toFixed(4)],
      ["rules", "forced heal " + s.forcedHeal + ", watchdog " + s.watchdog],
      ["lessons", s.lessons ? "in force " + s.lessonActive + ", replaced the pick " + s.lessonOverride : "off"],
      ["console", dash(s.fps, (v) => v + " fps")],
    ]
    stats.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", "", k), el("dd", "", v)]))
    if (!s.lessons) {
      lessonsTitle.textContent = "Lessons (off, run with --lessons)"
      lessons.replaceChildren()
      return
    }
    lessonsTitle.textContent = "Lessons (" + s.lessons.list.length + ")"
    if (s.lessons.list.length === 0) {
      lessons.replaceChildren(el("li", "empty", "none yet: a lesson appears after a death"))
      return
    }
    lessons.replaceChildren(...s.lessons.list.map((l) => {
      const li = el("li", (l.here ? "here" : "") + (l.id === s.lessons.active ? " active" : ""))
      li.append(el("div", "", l.id + " " + l.where + ": " + l.when.join(" + ") + " -> " + l.do + "  d" + l.deaths + " w" + l.wins + (l.failed ? " f" + l.failed : "")))
      li.append(el("div", "why", l.why + " (" + l.source + ")"))
      return li
    }))
  })
</script>
</body>
</html>
`
