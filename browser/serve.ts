// The game in the browser: same code as the console, keyboard instead of the handheld.
// npm run browser
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { fakeJev } from "../bridge/fake-jev.ts"
import { sfxPlayerSource } from "../bridge/sfx.ts"
import { makeJev, type JevFn } from "../bridge/jev.ts"
import { findKey } from "../bridge/launch.ts"
import { loadLogic } from "../load-logic.ts"
import { browserBundle } from "./bundle.ts"
import { BrowserDrive } from "./drive.ts"

export const BROWSER_PORT = 8787

const PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corridor</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 13px/1.4 ui-monospace, Menlo, monospace; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 16px; }
  #screen, #map { flex: none; background: #000; image-rendering: pixelated; }
  #screen { width: 640px; max-width: 100%; height: auto; aspect-ratio: 4 / 3; }
  #map { width: 480px; max-width: 100%; height: auto; aspect-ratio: 4 / 3; }
  p { flex: 1 1 100%; margin: 0; color: #888; }
  kbd { color: #ddd; }
</style>
</head>
<body>
<canvas id="screen" width="160" height="120"></canvas>
<canvas id="map" width="160" height="120"></canvas>
<p><kbd>стрелки</kbd> или <kbd>WASD</kbd> — ход и поворот. <kbd>пробел</kbd> или <kbd>K</kbd> — огонь и выбор (A). <kbd>J</kbd> или <kbd>Shift</kbd> — карта и пауза (B): удерживай без стрелок. В паузе <kbd>GIVE TO AI</kbd> отдаёт управление, <kbd>TAKE OVER</kbd> забирает.</p>
<script src="/play.js"></script>
<script>
${sfxPlayerSource()}
const keys = new Set()
const A = new Set([" ", "k", "K"])
const B = new Set(["j", "J", "Shift"])
addEventListener("keydown", (e) => { keys.add(e.key); if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) e.preventDefault() })
addEventListener("keyup", (e) => keys.delete(e.key))
addEventListener("blur", () => keys.clear())
const held = (names) => names.some((n) => keys.has(n))
function paint(canvas, img) {
  const pal = corridorBrowser.palette
  const ctx = canvas.getContext("2d")
  const data = ctx.createImageData(img.width, img.height)
  const px = img.pixels
  for (let i = 0; i < px.length; i++) {
    const c = pal[px[i]] || 0
    const o = i * 4
    data.data[o] = (c >> 16) & 255
    data.data[o + 1] = (c >> 8) & 255
    data.data[o + 2] = c & 255
    data.data[o + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
}
const screen = document.getElementById("screen")
const map = document.getElementById("map")
let aiBusy = false
let boxBusy = false
function sendAi() {
  if (aiBusy) return
  const lines = corridorBrowser.takeLines()
  if (!lines) return
  aiBusy = true
  fetch("/ai/lines", { method: "POST", headers: { "content-type": "text/plain" }, body: lines.join("\\n") })
    .catch(() => {})
    .then(() => { aiBusy = false })
}
function pollBox() {
  if (boxBusy || !corridorBrowser.place().ai) return
  boxBusy = true
  fetch("/ai/box")
    .then((r) => r.json())
    .then((box) => corridorBrowser.setBox(box))
    .catch(() => {})
    .then(() => { boxBusy = false })
}
function frame(now) {
  pollBox()
  sendAi()
  corridorBrowser.tick(now,
    held(["ArrowUp", "w", "W"]), held(["ArrowDown", "s", "S"]),
    held(["ArrowLeft", "a", "A"]), held(["ArrowRight", "d", "D"]),
    held([...A]), held([...B]))
  const heard = corridorBrowser.takeEvents()
  for (let i = 0; i < heard.length; i++) corridorSfx.play(heard[i])
  paint(screen, corridorBrowser.screen)
  paint(map, corridorBrowser.map)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
</script>
</body>
</html>`

export interface BrowserServer {
    url: string
    port: number
    close: () => Promise<void>
}

function browserJev(): JevFn {
    const key = process.env.OPENROUTER_KEY
    if (key) return makeJev({ key })
    return fakeJev
}

export function startBrowser(port = BROWSER_PORT, jev: JevFn = browserJev()): Promise<BrowserServer> {
    const js = browserBundle()
    const drive = new BrowserDrive(loadLogic(), jev)
    const server = http.createServer((req, res) => {
        const urlPath = new URL(req.url ?? "/", "http://localhost").pathname
        if (urlPath === "/" || urlPath === "/play") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            res.end(PAGE)
        } else if (urlPath === "/play.js") {
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" })
            res.end(js)
        } else if (urlPath === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" })
            res.end("ok\n")
        } else if (req.method === "POST" && urlPath === "/ai/lines") {
            const chunks: Buffer[] = []
            req.on("data", (c: Buffer) => chunks.push(c))
            req.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8")
                for (const line of text.split("\n")) if (line.trim()) drive.feed(line.trim())
                // The answer lands in the box when Jev returns. Waiting for it here holds the next
                // snapshot back, and the command is already stale by the time the page can read it.
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify(drive.box()))
            })
        } else if (urlPath === "/ai/box") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(drive.box()))
        } else {
            res.writeHead(404)
            res.end()
        }
    })
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "127.0.0.1", () => {
            const got = (server.address() as AddressInfo).port
            resolve({
                url: `http://localhost:${got}`,
                port: got,
                close: () => new Promise((done) => {
                    server.close(() => done())
                    server.closeAllConnections()
                }),
            })
        })
    })
}

function applyBrowserKey(): void {
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    const found = findKey({
        env: process.env,
        repoDir: repo,
        readFile: (file) => {
            try { return fs.readFileSync(file, "utf8") } catch { return null }
        },
        keychain: (service) => {
            if (process.platform !== "darwin") return null
            const r = spawnSync("security", ["find-generic-password", "-w", "-s", service], { encoding: "utf8" })
            return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
        },
    })
    if (found) {
        process.env.OPENROUTER_KEY = found.key
        console.log(`ключ OpenRouter: ${found.source}`)
    } else console.log("ИИ в браузере: правила, без ключа OpenRouter")
}

if (process.argv[1]?.endsWith("serve.ts")) {
    applyBrowserKey()
    const port = Number(process.env.RC_BROWSER_PORT || BROWSER_PORT)
    startBrowser(port).then((srv) => {
        console.log(`watch ${srv.url}`)
        console.log(`\n  играть: ${srv.url}\n  стоп:   Ctrl+C\n`)
    }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") console.error(`порт ${port} занят`)
        else console.error(err.message)
        process.exit(1)
    })
}
