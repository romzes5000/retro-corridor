// One command for the AI bridge: npm run play
// A short menu (Enter repeats the last run), then the OpenRouter key, a running console bridge
// stopped with SIGINT, `--check` on the console, bridge/main.ts started and the live page opened.
// npm run play -- --last      the last run without questions
// npm run play -- --yes       the defaults: console, --film --watch --lessons
// npm run play -- --dry-run   print the command and where the key comes from, start nothing
// --no-open (no browser), --no-public (no trycloudflare address), --no-check (skip the console
// check); any other flag goes to the bridge: npm run play -- --yes --sim ARENA --runs 3
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { BROWSER_PORT, startBrowser } from "../browser/serve.ts"
import {
    askYes,
    bridgeArgs,
    checkVerdict,
    consoleBridges,
    DEFAULTS,
    findKey,
    keyHint,
    loadLast,
    parsePlayArgs,
    parsePs,
    plan,
    runMenu,
    saveLast,
    shellLine,
    STATE_FILE,
    stopBridges,
    publicLink,
    tunnelArgs,
    tunnelTarget,
    watchUrl,
    CLOUDFLARED_HINT,
    type MenuIO,
} from "./launch.ts"

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = path.join("bridge", "main.ts")
const CHECK_TIMEOUT_MS = 15000

const USAGE = `npm run play [-- --last | --yes] [--dry-run] [--no-open] [--no-public] [--no-check] [флаги npm run ai]
  без флагов   меню; Enter запускает как в прошлый раз
  --last       прошлый запуск без вопросов
  --yes        по умолчанию: приставка, --film --watch --lessons
  в меню «браузер» — та же игра в браузере, без приставки и без Jev
  --dry-run    показать команду и откуда ключ, ничего не запускать
  --no-public  без случайной ссылки в интернет на этот запуск`

function lineIO(): { io: MenuIO; close: () => void } {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
    rl.on("SIGINT", () => process.exit(130))
    const lines = rl[Symbol.asyncIterator]()
    return {
        io: {
            write: (text) => void process.stdout.write(text),
            next: async () => {
                const r = await lines.next()
                if (r.done) {
                    process.stdout.write("\n")
                    return null
                }
                if (!process.stdin.isTTY) process.stdout.write(r.value + "\n")
                return r.value
            },
        },
        close: () => rl.close(),
    }
}

function keychain(service: string): string | null {
    if (process.platform !== "darwin") return null
    const r = spawnSync("security", ["find-generic-password", "-w", "-s", service], { encoding: "utf8" })
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

function readFile(file: string): string | null {
    try {
        return fs.readFileSync(file, "utf8")
    } catch {
        return null
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function freeConsole(): Promise<void> {
    const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    const pids = consoleBridges(parsePs(ps.stdout ?? ""), process.pid)
    await stopBridges(pids, {
        kill: (pid, signal) => {
            try {
                process.kill(pid, signal)
            } catch {}
        },
        alive,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        log: (line) => console.log(line),
    })
}

// True when the bridge can go on: the console answers, PLAYER AI or not yet.
async function checkConsole(io: MenuIO | null): Promise<boolean> {
    for (;;) {
        console.log("проверяю приставку (npm run ai -- --check)...")
        const r = spawnSync(process.execPath, ["--experimental-strip-types", MAIN, "--check"], { cwd: REPO, encoding: "utf8", timeout: CHECK_TIMEOUT_MS })
        const verdict = checkVerdict(r.error ? null : r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`)
        console.log(verdict.hint)
        if (verdict.go) return true
        if (!io || !(await askYes(io, "Проверить снова", true))) return false
    }
}

function openBrowser(url: string): void {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true })
    child.on("error", () => console.log(`браузер не открылся, открой сам: ${url}`))
    child.unref()
}

// SIGTERM to the tunnel's process group: cloudflared is its own group, like the bridge.
function stopTunnel(tunnel: ChildProcess | null): void {
    if (!tunnel?.pid || tunnel.exitCode !== null) return
    try {
        process.kill(-tunnel.pid, "SIGTERM")
    } catch {
        try {
            tunnel.kill("SIGTERM")
        } catch {
            // Already gone.
        }
    }
}

// A quick tunnel to the page. The address arrives on stderr a moment later; no binary means the
// local page still works.
function startTunnel(local: string): ChildProcess | null {
    const target = tunnelTarget(local)
    if (!target) return null
    const bin = process.env.RC_CLOUDFLARED || "cloudflared"
    const tunnel = spawn(bin, tunnelArgs(target), { stdio: ["ignore", "ignore", "pipe"], detached: true })
    tunnel.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") console.log(CLOUDFLARED_HINT)
    })
    let rest = ""
    let shown = false
    tunnel.stderr?.on("data", (chunk: Buffer) => {
        rest += chunk.toString("utf8")
        if (shown) return
        const url = publicLink(rest)
        if (!url) return
        shown = true
        console.log(`\n  в интернет: ${url}\n  карта:       ${url}/map\n`)
    })
    return tunnel
}

// The bridge gets its own process group, so Ctrl+C reaches it once, from here.
function startBridge(argv: string[], key: string | null, open: boolean, expose: boolean): ChildProcess {
    const env = { ...process.env }
    if (key) env.OPENROUTER_KEY = key
    const child = spawn(process.execPath, ["--experimental-strip-types", MAIN, ...argv], { cwd: REPO, env, stdio: ["ignore", "pipe", "inherit"], detached: true })
    let tunnel: ChildProcess | null = null
    let rest = ""
    let shown = false
    child.stdout!.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk)
        rest += chunk.toString("utf8")
        const lines = rest.split("\n")
        rest = lines.pop() ?? ""
        for (const line of lines) {
            const url = watchUrl(line)
            if (!url || shown) continue
            shown = true
            console.log(`\n  смотреть: ${url}\n  карта:    ${url}/map\n  стоп:     Ctrl+C\n`)
            if (open) openBrowser(url)
            if (expose) tunnel = startTunnel(url)
        }
    })
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            stopTunnel(tunnel)
            if (child.exitCode === null && child.signalCode === null) child.kill(signal)
        })
    }
    child.on("exit", (code, signal) => {
        stopTunnel(tunnel)
        process.exit(code ?? (signal ? 130 : 1))
    })
    return child
}

// The page runs the game itself. The tunnel, when asked, points at this server.
async function runBrowser(open: boolean, expose: boolean): Promise<void> {
    const port = Number(process.env.RC_BROWSER_PORT || BROWSER_PORT)
    let srv: Awaited<ReturnType<typeof startBrowser>>
    try {
        srv = await startBrowser(port)
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        console.error(code === "EADDRINUSE" ? `порт ${port} занят` : err instanceof Error ? err.message : err)
        process.exit(1)
    }
    console.log(`watch ${srv.url}`)
    console.log(`\n  играть: ${srv.url}\n  стоп:   Ctrl+C\n`)
    if (open) openBrowser(srv.url)
    const tunnel = expose ? startTunnel(srv.url) : null
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            stopTunnel(tunnel)
            void srv.close()
            process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 130 : 1)
        })
    }
}

async function main(): Promise<void> {
    const args = parsePlayArgs(process.argv.slice(2))
    if (args.help) {
        console.log(USAGE)
        return
    }
    const stateFile = process.env.RC_PLAY_STATE || path.join(REPO, STATE_FILE)
    const last = loadLast(stateFile)
    const menu = args.yes || args.last ? null : lineIO()
    const io = menu?.io ?? null
    try {
        const choices = args.yes ? DEFAULTS : args.last || !io ? (last ?? DEFAULTS) : await runMenu(io, last ?? DEFAULTS, last === null)
        if (choices.mode === "browser") {
            console.log("команда: npm run browser")
            if (args.dryRun) return
            const found = findKey({ env: process.env, repoDir: REPO, readFile, keychain })
            if (found) {
                process.env.OPENROUTER_KEY = found.key
                console.log(`ключ OpenRouter: ${found.source}`)
            } else console.log("ИИ в браузере: правила, без ключа OpenRouter")
            saveLast(stateFile, choices)
            await runBrowser(args.open && choices.open, args.public && choices.public)
            return
        }
        const argv = [...bridgeArgs(choices), ...args.passthrough]
        const p = plan(argv)
        const found = p.needsKey ? findKey({ env: process.env, repoDir: REPO, readFile, keychain }) : null
        if (p.needsKey && found) console.log(`ключ OpenRouter: ${found.source}`)
        if (p.needsKey && !found) {
            console.log(keyHint(process.env.RC_KEYCHAIN_SERVICE || undefined))
            if (args.dryRun) {
                // Only shown.
            } else if (io && (await askYes(io, "Запустить с fake Jev (правила вместо модели)", true))) {
                argv.push("--fake")
            } else {
                process.exitCode = 1
                return
            }
        }
        console.log(`команда: npm run ai -- ${shellLine(argv)}`)
        if (args.dryRun) return
        saveLast(stateFile, choices)
        if (p.console) {
            await freeConsole()
            if (args.check && !p.checkOnly && !(await checkConsole(io))) {
                process.exitCode = 1
                return
            }
        }
        startBridge(argv, found?.key ?? null, args.open && choices.open && p.watch, args.public && choices.public && p.watch)
    } finally {
        menu?.close()
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
