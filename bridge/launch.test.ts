// npm run play: menu answers -> bridge flags, the last answers on disk, where the key comes from,
// which processes hold the console, what --check means; then the launcher itself, spawned.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
    bridgeArgs,
    checkVerdict,
    consoleBridges,
    DEFAULTS,
    envFileValue,
    findKey,
    loadLast,
    parsePlayArgs,
    parsePs,
    plan,
    runMenu,
    saveLast,
    stopBridges,
    watchUrl,
    type Choices,
    type KeySources,
    type MenuIO,
} from "./launch.ts"

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLAY = path.join(REPO, "bridge", "play.ts")

function tmp(name: string): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-play-")), name)
}

function scripted(answers: string[]): MenuIO & { out: string[] } {
    const out: string[] = []
    let i = 0
    return { out, write: (t) => void out.push(t), next: async () => (i < answers.length ? answers[i++] : null) }
}

test("флаги моста: по умолчанию приставка с --film --watch --lessons, как запускали руками", () => {
    assert.deepEqual(bridgeArgs(DEFAULTS), ["--film", "--watch", "--lessons"])
})

test("флаги моста: симулятор, fake, попытки, сложность, сброс уроков, без памяти карты", () => {
    const c: Choices = { ...DEFAULTS, mode: "sim-fake", level: "ARENA", attempts: 4, difficulty: "hard", fast: true, watch: false, film: false, lessons: "reset", mapMemory: false }
    assert.deepEqual(bridgeArgs(c), ["--sim", "ARENA", "--difficulty", "hard", "--attempts", "4", "--fake", "--fast", "--lessons-reset", "--no-map-memory"])
    assert.deepEqual(bridgeArgs({ ...DEFAULTS, mode: "sim", level: "D1-D5", lessons: "off" }), ["--sim", "D1-D5", "--film", "--watch"])
    assert.deepEqual(bridgeArgs({ ...DEFAULTS, fast: true, attempts: 3 }), ["--film", "--watch", "--lessons"], "--fast и попытки только для симулятора")
})

test("прошлый выбор: запись и чтение, сброс уроков не повторяется, битый файл -> null, пропуски из умолчаний", () => {
    const file = tmp("last.json")
    assert.equal(loadLast(file), null)
    saveLast(file, { ...DEFAULTS, mode: "sim", level: "ARENA", attempts: 3, lessons: "reset", open: false })
    assert.deepEqual(loadLast(file), { ...DEFAULTS, mode: "sim", level: "ARENA", attempts: 3, lessons: "on", open: false })
    fs.writeFileSync(file, "{oops")
    assert.equal(loadLast(file), null)
    fs.writeFileSync(file, JSON.stringify({ mode: "console", film: false, attempts: -2, difficulty: "insane" }))
    assert.deepEqual(loadLast(file), { ...DEFAULTS, film: false })
})

test("аргументы лаунчера: свои флаги забирает, остальное уходит мосту", () => {
    const a = parsePlayArgs(["--last", "--no-open", "--sim", "ARENA", "--dry-run", "--runs", "3", "--no-check"])
    assert.equal(a.last, true)
    assert.equal(a.yes, false)
    assert.equal(a.open, false)
    assert.equal(a.check, false)
    assert.equal(a.dryRun, true)
    assert.deepEqual(a.passthrough, ["--sim", "ARENA", "--runs", "3"])
    assert.equal(parsePlayArgs(["-y"]).yes, true)
})

test("план по итоговым флагам: сырой --sim делает запуск симулятором, --fake и --check без ключа", () => {
    assert.deepEqual(plan(["--film", "--watch", "--lessons"]), { console: true, needsKey: true, checkOnly: false, watch: true })
    assert.deepEqual(plan(["--film", "--watch", "--sim=ARENA"]), { console: false, needsKey: true, checkOnly: false, watch: true })
    assert.equal(plan(["--fake"]).needsKey, false)
    assert.deepEqual(plan(["--check", "--watch"]), { console: true, needsKey: false, checkOnly: true, watch: false })
})

test("dotenv: export, кавычки, комментарий, последняя строка побеждает, пусто -> null", () => {
    assert.equal(envFileValue("A=1\nOPENROUTER_KEY=abc\n"), "abc")
    assert.equal(envFileValue('export OPENROUTER_KEY="a b#c" # note'), "a b#c")
    assert.equal(envFileValue("OPENROUTER_KEY='x'\nOPENROUTER_KEY=y # later"), "y")
    assert.equal(envFileValue("# OPENROUTER_KEY=no\nOPENROUTER_KEY_OLD=no"), null)
    assert.equal(envFileValue("OPENROUTER_KEY="), null)
})

test("ключ: окружение, затем RC_ENV_FILE, затем .env.local, затем Keychain; источник без значения", () => {
    const files: Record<string, string> = {}
    const asked: string[] = []
    const src = (env: KeySources["env"], chain: string | null = "from-keychain"): KeySources => ({
        env,
        repoDir: "/repo",
        readFile: (f) => files[f] ?? null,
        keychain: (s) => {
            asked.push(s)
            return chain
        },
    })
    assert.deepEqual(findKey(src({ OPENROUTER_KEY: "from-env", RC_ENV_FILE: "/x/.env" })), { key: "from-env", source: "OPENROUTER_KEY из окружения" })
    files["/x/.env"] = "OPENROUTER_KEY=from-file"
    files["/repo/.env.local"] = "OPENROUTER_KEY=from-local"
    assert.deepEqual(findKey(src({ RC_ENV_FILE: "/x/.env" })), { key: "from-file", source: "RC_ENV_FILE (/x/.env)" })
    files["/x/.env"] = "OTHER=1"
    assert.equal(findKey(src({ RC_ENV_FILE: "/x/.env" }))?.key, "from-local")
    delete files["/repo/.env.local"]
    assert.deepEqual(asked, [])
    assert.deepEqual(findKey(src({ RC_KEYCHAIN_SERVICE: "my-svc" })), { key: "from-keychain", source: "Keychain my-svc" })
    assert.equal(findKey(src({}))?.source, "Keychain retro-corridor-openrouter")
    assert.equal(findKey(src({}, null)), null)
    assert.deepEqual(asked, ["my-svc", "retro-corridor-openrouter", "retro-corridor-openrouter"])
})

test("остановка: только node с bridge/main.ts без --sim и --check, не обёртки и не сам лаунчер", () => {
    const ps = [
        "  101 /opt/homebrew/bin/node --experimental-strip-types bridge/main.ts --film --watch --lessons",
        "  102 sh -c node --experimental-strip-types bridge/main.ts --film --watch",
        "  103 npm run ai -- --film --watch --lessons",
        "  104 node --experimental-strip-types bridge/main.ts --sim HANGAR --fake",
        "  105 node --experimental-strip-types /tmp/rc-other/bridge/main.ts --sim=ARENA",
        "  106 node --experimental-strip-types /Users/x/rc-wt/bridge/main.ts --fake",
        "  107 node --experimental-strip-types bridge/main.ts --check",
        "  108 node --experimental-strip-types bridge/play.ts --last",
        "  109 node --experimental-strip-types bridge/main.ts",
        "  110 vim bridge/main.ts",
    ].join("\n")
    const procs = parsePs(ps)
    assert.equal(procs.length, 10)
    assert.deepEqual(consoleBridges(procs, 999), [101, 106, 109])
    assert.deepEqual(consoleBridges(procs, 109), [101, 106])
})

test("остановка: SIGINT всем, кто не вышел за отведённое время — SIGTERM", async () => {
    const live = new Set([1, 2])
    const sent: string[] = []
    await stopBridges([1, 2], {
        kill: (pid, sig) => {
            sent.push(`${pid}:${sig}`)
            if (pid === 1 && sig === "SIGINT") live.delete(1)
        },
        alive: (pid) => live.has(pid),
        sleep: async () => {},
        log: () => {},
    }, 1000, 100)
    assert.deepEqual(sent, ["1:SIGINT", "2:SIGINT", "2:SIGTERM"])
    const none: string[] = []
    await stopBridges([], { kill: () => void none.push("x"), alive: () => true, sleep: async () => {}, log: () => void none.push("log") })
    assert.deepEqual(none, [])
})

test("проверка приставки: нет USB, загрузчик, не та прошивка, не PLAYER AI, готово", () => {
    assert.deepEqual(checkVerdict(1, "no HF2 device (is the console plugged in and running the game?)").state, "no-console")
    assert.equal(checkVerdict(null, "").state, "no-console")
    assert.equal(checkVerdict(1, "HF2 mode 1 (2 = game running)\nboom").state, "not-game")
    assert.equal(checkVerdict(1, "HF2 mode 2 (2 = game running)\nmailbox not found among 40 globals (is this the AI build?)").state, "no-mailbox")
    const noAi = checkVerdict(0, "HF2 mode 2 (2 = game running)\nmailbox at 0x2000, signature ok, seq 3\nconsole: 2 lines in 3 s, 0 AI lines (pick PLAYER AI in the menu and start a level)")
    assert.equal(noAi.state, "no-ai")
    assert.equal(noAi.go, true)
    assert.match(noAi.hint, /PLAYER -> AI/)
    const ready = checkVerdict(0, "HF2 mode 2 (2 = game running)\nmailbox at 0x2000, signature ok, seq 3\nconsole: 14 lines in 3 s, 12 AI lines")
    assert.deepEqual([ready.state, ready.go], ["ready", true])
    assert.equal(checkVerdict(1, "HF2 mode 2 (2 = game running)\nhf2 status 3 for 0x1").go, false)
})

test("адрес страницы из строки моста", () => {
    assert.equal(watchUrl("watch http://localhost:8787"), "http://localhost:8787")
    assert.equal(watchUrl("film bridge/out/film-1.jsonl"), null)
})

test("меню: Enter повторяет прошлый запуск, конец ввода — тоже", async () => {
    const last: Choices = { ...DEFAULTS, mode: "sim", level: "ARENA" }
    assert.deepEqual(await runMenu(scripted([""]), last, false), last)
    const io = scripted([])
    assert.deepEqual(await runMenu(io, DEFAULTS, true), DEFAULTS)
    assert.match(io.out.join(""), /По умолчанию: приставка по USB, Jev/)
})

test("меню: изменить — симулятор с fake, уровень по номеру, неверный ввод переспрашивается", async () => {
    const io = scripted(["2", "3", "3", "x", "4", "1", "н", "д", "2", "н", "д"])
    const c = await runMenu(io, DEFAULTS, true)
    assert.deepEqual(c, { ...DEFAULTS, mode: "sim-fake", level: "ARENA", attempts: 4, difficulty: "easy", watch: false, film: true, lessons: "reset", mapMemory: false, fast: true })
    assert.match(io.out.join(""), /целое от 1/)
    const named = await runMenu(scripted(["2", "2", "d2-d4", "", "", "", "", "", "", ""]), DEFAULTS, true)
    assert.equal(named.level, "D2-D4")
    assert.deepEqual(bridgeArgs(named), ["--sim", "D2-D4", "--film", "--watch", "--lessons"])
})

function play(args: string[], env: Record<string, string>, input = ""): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", PLAY, ...args], { cwd: REPO, input, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

test("лаунчер --yes --dry-run: команда по умолчанию, источник ключа назван, значение не печатается, файл выбора не пишется", () => {
    const state = tmp("last.json")
    const r = play(["--yes", "--dry-run"], { RC_PLAY_STATE: state, OPENROUTER_KEY: "sk-test-NEVER-PRINT" })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /команда: npm run ai -- --film --watch --lessons\n/)
    assert.match(r.out, /ключ OpenRouter: OPENROUTER_KEY из окружения/)
    assert.doesNotMatch(r.out, /NEVER-PRINT/)
    assert.equal(fs.existsSync(state), false)
})

test("лаунчер без ключа в режиме с Jev и без меню: подсказка и выход 1, мост не стартует", (t) => {
    if (fs.existsSync(path.join(REPO, ".env.local"))) return t.skip(".env.local в репо даёт ключ")
    const envFile = tmp(".env")
    fs.writeFileSync(envFile, "OTHER=1\n")
    const r = play(["--yes", "--sim", "HANGAR"], { RC_PLAY_STATE: tmp("last.json"), OPENROUTER_KEY: "", RC_ENV_FILE: envFile, RC_KEYCHAIN_SERVICE: `rc-test-missing-${process.pid}` })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /Нет ключа OpenRouter.*security add-generic-password -U -s rc-test-missing-/)
    assert.doesNotMatch(r.out, /команда:/)
})

test("лаунчер с меню из stdin: симулятор с fake Jev играет уровень, выбор запоминается, --last повторяет его", () => {
    const state = tmp("last.json")
    const env = { RC_PLAY_STATE: state, OPENROUTER_KEY: "" }
    const r = play([], env, "2\n3\n1\n\n\nн\nн\n3\n\nд\n")
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /команда: npm run ai -- --sim HANGAR --fake --fast\n/)
    assert.match(r.out, /HANGAR run 1: (won|lost)/)
    assert.equal(loadLast(state)?.mode, "sim-fake")
    const again = play(["--last", "--dry-run"], env)
    assert.match(again.out, /команда: npm run ai -- --sim HANGAR --fake --fast\n/)
    assert.doesNotMatch(again.out, /Corridor: запуск ИИ/)
})

function get(url: string): Promise<number> {
    return new Promise((done) => {
        http.get(url, (res) => {
            res.resume()
            done(res.statusCode ?? 0)
        }).on("error", () => done(0))
    })
}

test("лаунчер со страницей: печатает адреса страницы и карты, Ctrl+C останавливает мост", async () => {
    const state = tmp("last.json")
    const port = 20000 + Math.floor(Math.random() * 20000)
    saveLast(state, { ...DEFAULTS, mode: "sim-fake", watch: true, open: true, film: false, lessons: "off" })
    const child = spawn(process.execPath, ["--experimental-strip-types", PLAY, "--last", "--no-open", "--watch-port", String(port), "--quiet"], {
        cwd: REPO,
        env: { ...process.env, RC_PLAY_STATE: state, OPENROUTER_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stderr.on("data", (c: Buffer) => (out += c))
    await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no URLs: ${out}`)), 30000)
        child.stdout.on("data", (c: Buffer) => {
            out += c
            if (out.includes("карта:")) {
                clearTimeout(timer)
                done()
            }
        })
    })
    assert.match(out, new RegExp(`смотреть: http://localhost:${port}\\n`))
    assert.match(out, new RegExp(`карта: +http://localhost:${port}/map\\n`))
    assert.equal(await get(`http://localhost:${port}/map`), 200)
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)))
    child.kill("SIGINT")
    assert.equal(await exited, 130)
    assert.equal(await get(`http://localhost:${port}/`), 0)
})
