// What `npm run play` decides before it starts bridge/main.ts: the menu answers and the bridge flags
// they stand for, the last answers on disk, where the OpenRouter key comes from, which running
// bridges hold the console, and what `--check` said about it. No side effects here except the
// answers file; bridge/play.ts does the spawning.
import fs from "node:fs"
import path from "node:path"

export type Mode = "console" | "sim" | "sim-fake" | "browser"
export type Difficulty = "easy" | "normal" | "hard"
export type LessonsChoice = "on" | "reset" | "off"

export interface Choices {
    mode: Mode
    // Sim only: a level name, ALL or a depth range D1-D5.
    level: string
    attempts: number
    difficulty: Difficulty
    // Fake Jev in the sim only: virtual time.
    fast: boolean
    watch: boolean
    // Open the live page in the browser once the bridge serves it.
    open: boolean
    // A trycloudflare.com address for the live page, for as long as this run.
    public: boolean
    film: boolean
    lessons: LessonsChoice
    mapMemory: boolean
}

export const DEFAULTS: Choices = {
    mode: "console",
    level: "HANGAR",
    attempts: 1,
    difficulty: "normal",
    fast: false,
    watch: true,
    open: true,
    public: true,
    film: true,
    lessons: "on",
    mapMemory: true,
}

export const MODES: Array<[Mode, string]> = [
    ["console", "приставка по USB, Jev"],
    ["sim", "симулятор, Jev"],
    ["sim-fake", "симулятор, fake Jev (без ключа)"],
    ["browser", "браузер, с клавиатуры (без приставки)"],
]
export const LEVELS = ["HANGAR", "WAREHOUSE", "ARENA", "ALL", "D1-D5"]
const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]
const LESSONS: Array<[LessonsChoice, string]> = [
    ["on", "включены"],
    ["reset", "включены, начать с пустого файла"],
    ["off", "выключены"],
]

export const KEYCHAIN_SERVICE = "retro-corridor-openrouter"
export const STATE_FILE = ".play-last.json"

export function bridgeArgs(c: Choices): string[] {
    if (c.mode === "browser") return []
    const args: string[] = []
    if (c.mode !== "console") {
        args.push("--sim", c.level)
        if (c.difficulty !== "normal") args.push("--difficulty", c.difficulty)
        if (c.attempts > 1) args.push("--attempts", String(c.attempts))
    }
    if (c.mode === "sim-fake") {
        args.push("--fake")
        if (c.fast) args.push("--fast")
    }
    if (c.film) args.push("--film")
    if (c.watch) args.push("--watch")
    if (c.lessons === "on") args.push("--lessons")
    if (c.lessons === "reset") args.push("--lessons-reset")
    if (!c.mapMemory) args.push("--no-map-memory")
    return args
}

export function describe(c: Choices): string {
    if (c.mode === "browser") {
        const parts = ["браузер, с клавиатуры"]
        parts.push(c.open ? "страница откроется сама" : "без открытия страницы")
        if (c.public) parts.push("публичная ссылка")
        return parts.join("; ")
    }
    const parts = [MODES.find(([m]) => m === c.mode)![1]]
    if (c.mode !== "console") parts.push(`${c.level}, ${c.difficulty}${c.attempts > 1 ? `, до ${c.attempts} попыток` : ""}${c.mode === "sim-fake" && c.fast ? ", --fast" : ""}`)
    parts.push(c.watch ? (c.open ? "страница + браузер" : "страница") : "без страницы")
    if (c.watch && c.public) parts.push("публичная ссылка")
    parts.push(c.film ? "фильм" : "без фильма")
    parts.push(c.lessons === "off" ? "без уроков" : c.lessons === "reset" ? "уроки с нуля" : "уроки")
    parts.push(c.mapMemory ? "память карты" : "без памяти карты")
    return parts.join("; ")
}

// Fields of the file that are missing or of the wrong kind fall back to the defaults.
export function loadLast(file: string): Choices | null {
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
        return null
    }
    if (!raw || typeof raw !== "object") return null
    const r = raw as Record<string, unknown>
    const pick = <T>(v: unknown, ok: (v: unknown) => boolean, d: T): T => (ok(v) ? (v as T) : d)
    return {
        mode: pick(r.mode, (v) => MODES.some(([m]) => m === v), DEFAULTS.mode),
        level: pick(r.level, (v) => typeof v === "string" && v.length > 0, DEFAULTS.level),
        attempts: pick(r.attempts, (v) => Number.isInteger(v) && (v as number) >= 1, DEFAULTS.attempts),
        difficulty: pick(r.difficulty, (v) => DIFFICULTIES.includes(v as Difficulty), DEFAULTS.difficulty),
        fast: pick(r.fast, (v) => typeof v === "boolean", DEFAULTS.fast),
        watch: pick(r.watch, (v) => typeof v === "boolean", DEFAULTS.watch),
        open: pick(r.open, (v) => typeof v === "boolean", DEFAULTS.open),
        public: pick(r.public, (v) => typeof v === "boolean", DEFAULTS.public),
        film: pick(r.film, (v) => typeof v === "boolean", DEFAULTS.film),
        lessons: pick(r.lessons, (v) => LESSONS.some(([l]) => l === v), DEFAULTS.lessons),
        mapMemory: pick(r.mapMemory, (v) => typeof v === "boolean", DEFAULTS.mapMemory),
    }
}

// A reset is a one-off: repeating the last run must not wipe the lessons learned since.
export function saveLast(file: string, c: Choices): void {
    const kept: Choices = { ...c, lessons: c.lessons === "reset" ? "on" : c.lessons }
    fs.writeFileSync(file, JSON.stringify(kept, null, 2) + "\n")
}

export interface PlayArgs {
    yes: boolean
    last: boolean
    dryRun: boolean
    open: boolean
    // A trycloudflare.com address for this run. --no-public turns it off once.
    public: boolean
    check: boolean
    help: boolean
    // Everything else goes to bridge/main.ts after the flags of the choices.
    passthrough: string[]
}

export function parsePlayArgs(argv: string[]): PlayArgs {
    const out: PlayArgs = { yes: false, last: false, dryRun: false, open: true, public: true, check: true, help: false, passthrough: [] }
    for (const a of argv) {
        if (a === "--yes" || a === "-y") out.yes = true
        else if (a === "--last") out.last = true
        else if (a === "--dry-run") out.dryRun = true
        else if (a === "--no-open") out.open = false
        else if (a === "--no-public") out.public = false
        else if (a === "--no-check") out.check = false
        else if (a === "--help" || a === "-h") out.help = true
        else out.passthrough.push(a)
    }
    return out
}

function hasFlag(argv: string[], name: string): boolean {
    return argv.some((a) => a === name || a.startsWith(name + "="))
}

export interface Plan {
    // Without --sim the bridge opens the console over USB, and only one process can hold it.
    console: boolean
    needsKey: boolean
    checkOnly: boolean
    watch: boolean
}

// From the final bridge flags, raw ones included: `--yes --sim ARENA` is a sim run.
export function plan(argv: string[]): Plan {
    const checkOnly = hasFlag(argv, "--check")
    return {
        console: !hasFlag(argv, "--sim"),
        needsKey: !hasFlag(argv, "--fake") && !checkOnly,
        checkOnly,
        watch: hasFlag(argv, "--watch") && !checkOnly,
    }
}

// The value of NAME in a dotenv file: `NAME=v`, `export NAME="v"`, `NAME='v' # note`.
export function envFileValue(text: string, name = "OPENROUTER_KEY"): string | null {
    let found: string | null = null
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (!m || m[1] !== name) continue
        let v = m[2].trim()
        const q = v[0]
        if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1))
        else v = v.replace(/\s+#.*$/, "")
        found = v
    }
    return found ? found : null
}

export interface KeySources {
    env: Record<string, string | undefined>
    repoDir: string
    readFile: (file: string) => string | null
    keychain: (service: string) => string | null
}

export interface FoundKey {
    key: string
    // Where it came from, never the value.
    source: string
}

// OPENROUTER_KEY in the environment, then the dotenv file RC_ENV_FILE points at, then .env.local in
// the repo, then the macOS Keychain (service RC_KEYCHAIN_SERVICE or retro-corridor-openrouter).
export function findKey(src: KeySources): FoundKey | null {
    if (src.env.OPENROUTER_KEY) return { key: src.env.OPENROUTER_KEY, source: "OPENROUTER_KEY из окружения" }
    const files: Array<[string, string]> = []
    if (src.env.RC_ENV_FILE) files.push([src.env.RC_ENV_FILE, `RC_ENV_FILE (${src.env.RC_ENV_FILE})`])
    files.push([path.join(src.repoDir, ".env.local"), ".env.local"])
    for (const [file, label] of files) {
        const text = src.readFile(file)
        const key = text === null ? null : envFileValue(text)
        if (key) return { key, source: label }
    }
    const service = src.env.RC_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE
    const key = src.keychain(service)
    if (key) return { key, source: `Keychain ${service}` }
    return null
}

export function keyHint(service = KEYCHAIN_SERVICE): string {
    return `Нет ключа OpenRouter. Один раз: security add-generic-password -U -s ${service} -a "$USER" -w (спросит ключ); или OPENROUTER_KEY в окружении, или .env.local в репо, или RC_ENV_FILE=путь/к/.env`
}

export interface Proc {
    pid: number
    command: string
}

// `ps -axo pid=,command=` output.
export function parsePs(out: string): Proc[] {
    const procs: Proc[] = []
    for (const line of out.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.+)$/)
        if (m) procs.push({ pid: Number(m[1]), command: m[2] })
    }
    return procs
}

// Node processes running bridge/main.ts without --sim (any checkout: they all want the same USB
// device). Not a sim of another agent, not `sh -c` or npm wrapping one, not this launcher.
export function consoleBridges(procs: Proc[], self: number): number[] {
    return procs
        .filter((p) => {
            if (p.pid === self) return false
            const tokens = p.command.trim().split(/\s+/)
            if (!/^node\d*$/.test(path.basename(tokens[0]))) return false
            const script = tokens.findIndex((t) => t === "bridge/main.ts" || t.endsWith("/bridge/main.ts"))
            if (script < 0) return false
            const args = tokens.slice(script + 1)
            return !hasFlag(args, "--sim") && !hasFlag(args, "--check")
        })
        .map((p) => p.pid)
}

export interface StopDeps {
    kill: (pid: number, signal: NodeJS.Signals) => void
    alive: (pid: number) => boolean
    sleep: (ms: number) => Promise<void>
    log: (line: string) => void
}

// SIGINT first: the bridge prints its summary, saves and closes the USB link. SIGTERM only for
// those still running after `waitMs`.
export async function stopBridges(pids: number[], deps: StopDeps, waitMs = 10000, stepMs = 200): Promise<void> {
    if (pids.length === 0) return
    deps.log(`останавливаю мост на приставке: pid ${pids.join(", ")}`)
    for (const pid of pids) deps.kill(pid, "SIGINT")
    for (let t = 0; t < waitMs; t += stepMs) {
        if (!pids.some((pid) => deps.alive(pid))) return
        await deps.sleep(stepMs)
    }
    for (const pid of pids.filter((pid) => deps.alive(pid))) {
        deps.log(`pid ${pid} не вышел за ${waitMs / 1000} с, SIGTERM`)
        deps.kill(pid, "SIGTERM")
    }
}

export type ConsoleState = "ready" | "no-ai" | "no-console" | "not-game" | "no-mailbox" | "failed"

export interface Verdict {
    state: ConsoleState
    // Can the bridge start: it waits for PLAYER AI by itself, the rest it cannot fix.
    go: boolean
    hint: string
}

// What `npm run ai -- --check` printed; status null when it did not finish in time.
export function checkVerdict(status: number | null, output: string): Verdict {
    const mode = output.match(/HF2 mode (\d+)/)
    if (status === null) return { state: "no-console", go: false, hint: "Приставка не ответила на проверку: переподключи кабель и включи игру." }
    if (/no HF2 device/.test(output) || (status !== 0 && !mode)) return { state: "no-console", go: false, hint: "Приставка не найдена по USB: подключи кабель, включи её и запусти Corridor." }
    if (mode && mode[1] !== "2") return { state: "not-game", go: false, hint: `Приставка в загрузчике (HF2 mode ${mode[1]}), а не в игре: запусти Corridor.` }
    if (/mailbox not found/.test(output)) return { state: "no-mailbox", go: false, hint: "На приставке прошивка без ИИ: залей свежую сборку (README, Build and flash)." }
    if (status !== 0) {
        const last = output.trim().split("\n").pop() ?? ""
        return { state: "failed", go: false, hint: `Проверка приставки упала: ${last}` }
    }
    const ai = output.match(/(\d+) AI lines/)
    if (ai && ai[1] === "0") return { state: "no-ai", go: true, hint: "Игра не в режиме ИИ: в меню A на PLAYER -> AI и начни уровень, мост подождёт." }
    return { state: "ready", go: true, hint: "Приставка на связи, ИИ играет." }
}

export function watchUrl(line: string): string | null {
    const m = line.match(/^watch (https?:\/\/\S+)/)
    return m ? m[1] : null
}

// The quick-tunnel address cloudflared prints on stderr, once it has one.
export function trycloudflareUrl(text: string): string | null {
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    return m ? m[0] : null
}

// The banner names the address before it exists in DNS. An early lookup is cached as NXDOMAIN,
// so the link is ready only once cloudflared has registered the tunnel.
export function publicLink(text: string): string | null {
    const url = trycloudflareUrl(text)
    if (!url || !/Registered tunnel connection/.test(text)) return null
    return url
}

// cloudflared dials the page on this machine, whatever host the bridge printed.
export function tunnelTarget(watch: string): string | null {
    let url: URL
    try {
        url = new URL(watch)
    } catch {
        return null
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    return `http://127.0.0.1:${port}`
}

export function tunnelArgs(target: string): string[] {
    return ["tunnel", "--no-autoupdate", "--url", target]
}

export const CLOUDFLARED_HINT = "нет cloudflared: brew install cloudflared"

export function shellLine(args: string[]): string {
    return args.map((a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ")
}

export interface MenuIO {
    write: (text: string) => void
    // One answer line, null once the input is over (then every question takes its default).
    next: () => Promise<string | null>
}

async function pickOne<T>(io: MenuIO, title: string, options: Array<[T, string]>, current: T): Promise<T> {
    const def = Math.max(0, options.findIndex(([v]) => v === current))
    io.write(`${title ? title + "\n" : ""}${options.map(([, label], i) => `  ${i + 1}) ${label}`).join("\n")}\n`)
    for (;;) {
        io.write(`Выбор [${def + 1}]: `)
        const answer = await io.next()
        if (answer === null || answer.trim() === "") return options[def][0]
        const n = Number(answer.trim())
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1][0]
        io.write(`  от 1 до ${options.length}\n`)
    }
}

const YES = ["д", "да", "y", "yes", "1", "+"]
const NO = ["н", "нет", "n", "no", "0", "-"]

export async function askYes(io: MenuIO, title: string, current: boolean): Promise<boolean> {
    for (;;) {
        io.write(`${title} (д/н) [${current ? "д" : "н"}]: `)
        const answer = await io.next()
        if (answer === null || answer.trim() === "") return current
        const a = answer.trim().toLowerCase()
        if (YES.includes(a)) return true
        if (NO.includes(a)) return false
        io.write("  д или н\n")
    }
}

async function askLevel(io: MenuIO, current: string): Promise<string> {
    const known = LEVELS.indexOf(current.toUpperCase())
    const def = known >= 0 ? String(known + 1) : current
    io.write(`Уровень\n${LEVELS.map((l, i) => `  ${i + 1}) ${l}`).join("\n")}\n  или имя: D3, D2-D8\n`)
    io.write(`Выбор [${def}]: `)
    const answer = await io.next()
    if (answer === null || answer.trim() === "") return current
    const a = answer.trim()
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= LEVELS.length) return LEVELS[n - 1]
    return a.toUpperCase()
}

async function askCount(io: MenuIO, title: string, current: number): Promise<number> {
    for (;;) {
        io.write(`${title} [${current}]: `)
        const answer = await io.next()
        if (answer === null || answer.trim() === "") return current
        const n = Number(answer.trim())
        if (Number.isInteger(n) && n >= 1) return n
        io.write("  целое от 1\n")
    }
}

// Enter on the first question repeats `start` (the last run, or the defaults the first time).
export async function runMenu(io: MenuIO, start: Choices, first: boolean): Promise<Choices> {
    io.write(`Corridor: запуск ИИ\n${first ? "По умолчанию" : "Прошлый запуск"}: ${describe(start)}\n`)
    const again = await pickOne(io, "", [[true, "запустить так"], [false, "изменить"]], true)
    if (again) return start
    const c: Choices = { ...start }
    c.mode = await pickOne(io, "Режим", MODES, c.mode)
    if (c.mode === "browser") {
        c.open = await askYes(io, "Открыть страницу сам", c.open)
        c.public = await askYes(io, "Публичная ссылка в интернете (trycloudflare)", c.public)
        return c
    }
    if (c.mode !== "console") {
        c.level = await askLevel(io, c.level)
        c.attempts = await askCount(io, "Попыток на уровень (после смерти заново, до победы)", c.attempts)
        c.difficulty = await pickOne(io, "Сложность", DIFFICULTIES.map((d): [Difficulty, string] => [d, d]), c.difficulty)
    }
    c.watch = await askYes(io, "Страница просмотра в браузере (localhost:8787)", c.watch)
    if (c.watch) {
        c.open = await askYes(io, "Открыть браузер сам", c.open)
        c.public = await askYes(io, "Публичная ссылка в интернете (trycloudflare)", c.public)
    }
    c.film = await askYes(io, "Записывать фильм (bridge/out/film-*.jsonl)", c.film)
    c.lessons = await pickOne(io, "Уроки после смерти", LESSONS, c.lessons)
    c.mapMemory = await askYes(io, "Помнить разведанную карту между попытками", c.mapMemory)
    if (c.mode === "sim-fake") c.fast = await askYes(io, "Виртуальное время, без пауз (--fast)", c.fast)
    return c
}
