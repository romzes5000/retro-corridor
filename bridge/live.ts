// Live view of AI play in a browser. The bridge renders frames from the console snapshots with the
// same player as the film, LIVE_DELAY_MS behind the latest snapshot so that there is always a next
// one to interpolate towards, and streams them over SSE as palette indices with Jev's decisions.
//   npm run ai -- --watch               then open http://localhost:8787
//   npm run ai -- --watch --watch-host 0.0.0.0   reachable from a phone on the same network
import http from "node:http"
import type { AddressInfo } from "node:net"
import { rgbList } from "../demo/frames.ts"
import { FakeImage } from "../fake-image.ts"
import type { Game, World } from "../load-logic.ts"
import { drawBanner, FRAME_MS, GAP_MS, jevAlert, jevLine, SegmentPlayer, TAIL_MS, type FilmRecord, type JevRecord } from "./film.ts"

export const LIVE_DELAY_MS = 300
export const WATCH_PORT = 8787
export const NO_SIGNAL = "NO SIGNAL"
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

// Palette indices of a 160x120 frame, one byte per pixel, as base64.
export function encodeFrame(img: FakeImage): string {
    return Buffer.from(img.pixels.buffer, img.pixels.byteOffset, img.pixels.byteLength).toString("base64")
}

export interface Watch {
    url: string
    port: number
    // Open /stream connections.
    clients(): number
    close(): Promise<void>
}

export interface WatchOptions {
    port?: number
    host?: string
    frameMs?: number
}

// Serves the page on / and the stream on /stream: `palette` once, then `frame` and `jev` events.
export async function startWatch(game: Game, player: LivePlayer, opts: WatchOptions = {}): Promise<Watch> {
    const host = opts.host ?? "127.0.0.1"
    const clients = new Set<http.ServerResponse>()
    const palette = JSON.stringify(rgbList(game.corridorArt.PALETTE))
    let last = ""
    const send = (res: http.ServerResponse, event: string, data: string) => res.write(`event: ${event}\ndata: ${data}\n\n`)
    player.onJev = (j) => {
        const data = JSON.stringify(j)
        for (const c of clients) send(c, "jev", data)
    }
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            res.end(PAGE)
        } else if (url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" })
            res.end("ok\n")
        } else if (url.pathname === "/stream") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
            send(res, "palette", palette)
            last = ""
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
        for (const c of clients) send(c, "frame", data)
    }, opts.frameMs ?? FRAME_MS)
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(opts.port ?? WATCH_PORT, host, () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    return {
        url: `http://${host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host}:${port}`,
        port,
        clients: () => clients.size,
        close: () => {
            clearInterval(timer)
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
  body { margin: 0; background: #111; color: #ddd; font: 14px/1.4 ui-monospace, Menlo, monospace; display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; }
  canvas { width: 640px; height: 480px; max-width: 100%; height: auto; aspect-ratio: 4 / 3; image-rendering: pixelated; background: #000; }
  #side { flex: 1; min-width: 240px; }
  #status { margin-bottom: 8px; }
  #status.off { color: #e55; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { padding: 2px 0; border-bottom: 1px solid #222; }
  li.danger { color: #e55; }
</style>
</head>
<body>
<canvas id="screen" width="160" height="120"></canvas>
<div id="side">
  <div id="status" class="off">connecting...</div>
  <ol id="jev"></ol>
</div>
<script>
  const ctx = document.getElementById("screen").getContext("2d")
  const image = ctx.createImageData(160, 120)
  const status = document.getElementById("status")
  const list = document.getElementById("jev")
  let palette = []
  const stream = new EventSource("/stream")
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
    const li = document.createElement("li")
    const danger = j.danger === null ? "" : " danger " + Math.round(j.danger * 100) + "%"
    li.textContent = j.label + " " + j.conf + "% " + j.latency + " ms" + danger
    if (j.danger !== null && j.danger >= 0.6) li.className = "danger"
    list.prepend(li)
    while (list.children.length > 30) list.lastChild.remove()
  })
</script>
</body>
</html>
`
