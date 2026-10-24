// AI player bridge. Console over USB:   npm run ai
// Simulated console, same protocol:     npm run ai -- --sim HANGAR [--difficulty normal] [--runs 5]
// Bench over every campaign level:      npm run ai -- --sim ALL --runs 5 --quiet
// Extra flags: --fake (rule-based picks, no API key), --fast (virtual time, only with --fake),
// --lag 500 (with --fast: fake answers land 500 ms of sim time later), --no-reflexes, --no-predict,
// --record demo/ai-hangar.json (inputs of the first won run, for the GIF replay),
// --check (console only: find the mailbox, listen to the console for 3 s, no Jev),
// --film (snapshots and decisions to bridge/out/film-*.jsonl; npm run ai:film renders a video).
// Jev needs OPENROUTER_KEY in the environment; JEV_MODEL overrides the model.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadLogic } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { FilmRecorder } from "./film.ts"
import { Hf2Transport } from "./hf2.ts"
import { jevModel, makeJev, type JevFn } from "./jev.ts"
import { addStats, Bridge, emptyStats, percentile, type LogRecord, type Stats } from "./loop.ts"
import { isBox } from "./mailbox.ts"
import { levelIndex, recording, SIM_DT, SimConsole } from "./sim.ts"

const DIFFICULTIES = ["easy", "normal", "hard"]
const OUT_DIR = new URL("./out/", import.meta.url)

function openLog(): { write: (rec: LogRecord) => void; file: string } {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR.pathname, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    const fd = fs.openSync(file, "a")
    return { write: (rec) => fs.writeSync(fd, JSON.stringify(rec) + "\n"), file }
}

// --film: every snapshot and decision to bridge/out/film-*.jsonl, for `npm run ai:film`.
function openFilm(): { recorder: FilmRecorder; file: string } {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR.pathname, `film-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    const fd = fs.openSync(file, "a")
    return { recorder: new FilmRecorder((rec) => fs.writeSync(fd, JSON.stringify(rec) + "\n")), file }
}

function pickJev(fake: boolean): JevFn {
    if (fake) return fakeJev
    const key = process.env.OPENROUTER_KEY
    if (!key) throw new Error("OPENROUTER_KEY is not set (or pass --fake)")
    return makeJev({ key })
}

function summary(stats: Stats, seconds: number): string {
    const rate = seconds > 0 ? (stats.decisions / seconds).toFixed(2) : "0"
    return [
        `decisions ${stats.decisions} (${rate}/s)`,
        `latency median ${percentile(stats.latencies, 0.5)} ms p95 ${percentile(stats.latencies, 0.95)} ms`,
        `errors ${stats.errors} stale ${stats.stale} skipped ${stats.skipped}`,
        `cost ${stats.cost.toFixed(5)} USD`,
    ].join(", ")
}

function printDecision(rec: LogRecord): void {
    if (rec.kind === "decision" && rec.decision && rec.answer) {
        const err = rec.answer.error ? ` (${rec.answer.error})` : ""
        console.log(`#${rec.n} ${rec.answer.action} -> ${rec.decision.label} ${Math.round(rec.answer.confidence * 100)}% ${rec.answer.latencyMs} ms${err}`)
    } else if (rec.kind !== "decision") {
        console.log(`${rec.kind}${rec.reason ? ": " + rec.reason : ""}`)
    }
}

interface SimOpts {
    level: string
    difficulty: number
    runs: number
    fake: boolean
    fast: boolean
    // With --fast: every answer lands this many ms of sim time after the request.
    lag: number
    reflexes: boolean
    predict: boolean
    timeout: number
    record?: string
    film: FilmRecorder | null
    quiet: boolean
}

// Answers in sim time: the request resolves once the sim clock has moved `lag` ms on.
function lagged(jev: JevFn, sim: SimConsole, lag: number, pending: Array<{ at: number; done: () => void }>): JevFn {
    return async (state) => {
        const answer = await jev(state)
        await new Promise<void>((done) => pending.push({ at: sim.clock + lag, done }))
        return { ...answer, latencyMs: lag }
    }
}

// One level of the bench: outcomes plus what the player did on the way.
interface LevelBench {
    name: string
    runs: number
    wins: number
    seconds: number
    hpAtEnd: number[]
    idleMs: number
    playMs: number
    longestIdleMs: number
    damage: { bite: number; shot: number; lava: number }
    stats: Stats
}

function benchLine(b: LevelBench): string {
    const share = b.playMs > 0 ? ((100 * b.idleMs) / b.playMs).toFixed(1) : "0"
    const hp = b.hpAtEnd.length ? Math.round(b.hpAtEnd.reduce((a, v) => a + v, 0) / b.hpAtEnd.length) : 0
    return [
        `${b.name}: won ${b.wins}/${b.runs}, ${(b.seconds / Math.max(1, b.runs)).toFixed(1)} s per run, hp at end ${hp}`,
        `pickups ${JSON.stringify(b.stats.pickups)}, picks ${JSON.stringify(b.stats.picks)}`,
        `idle ${share}% (longest ${b.longestIdleMs} ms), damage bite ${b.damage.bite} shot ${b.damage.shot} lava ${b.damage.lava}`,
        `watchdog ${b.stats.watchdog}, predicted ${b.stats.predicted}/${b.stats.decisions}`,
        summary(b.stats, b.seconds),
    ].join("\n  ")
}

async function runSim(opts: SimOpts): Promise<void> {
    const api = loadLogic()
    const levels = opts.level.toUpperCase() === "ALL" ? api.LEVELS.map((_: unknown, i: number) => i) : [levelIndex(api, opts.level)]
    const jev = pickJev(opts.fake)
    const log = openLog()
    console.log(`sim ${levels.map((l: number) => api.LEVELS[l].name).join(", ")} ${DIFFICULTIES[opts.difficulty]}, ${opts.runs} run(s) each, ${opts.fake ? "fake picks" : jevModel()}, log ${log.file}`)
    const benches: LevelBench[] = []
    for (const level of levels) benches.push(await simLevel(api, level, jev, log, opts))
    if (benches.length > 1) console.log("bench:")
    for (const b of benches) console.log(benchLine(b))
}

async function simLevel(api: ReturnType<typeof loadLogic>, level: number, jev: JevFn, log: ReturnType<typeof openLog>, opts: SimOpts): Promise<LevelBench> {
    const bench: LevelBench = {
        name: api.LEVELS[level].name, runs: opts.runs, wins: 0, seconds: 0, hpAtEnd: [], idleMs: 0, playMs: 0,
        longestIdleMs: 0, damage: { bite: 0, shot: 0, lava: 0 }, stats: emptyStats(),
    }
    let recorded = false
    for (let run = 1; run <= opts.runs; run++) {
        const sim = new SimConsole(level, opts.difficulty)
        sim.reflexes = opts.reflexes
        const now = opts.fast ? () => sim.clock : Date.now
        const pending: Array<{ at: number; done: () => void }> = []
        const ask = opts.fast && opts.lag > 0 ? lagged(jev, sim, opts.lag, pending) : jev
        const film = opts.film
        if (film) sim.onLine((line) => film.line(line))
        const bridge = new Bridge(sim.api, sim, ask, (rec) => {
            log.write({ ...rec, run } as LogRecord)
            film?.record(rec)
            if (!opts.quiet) printDecision(rec)
        }, now, undefined, { predict: opts.predict })
        const limit = opts.timeout * 1000
        if (opts.fast) {
            while (!sim.result && sim.clock < limit) {
                sim.step()
                for (const p of pending.filter((p) => p.at <= sim.clock)) {
                    pending.splice(pending.indexOf(p), 1)
                    p.done()
                }
                if (opts.lag > 0) await new Promise((resolve) => setImmediate(resolve))
                else await bridge.idle()
            }
        } else {
            let last = Date.now()
            while (!sim.result && sim.clock < limit) {
                await new Promise((resolve) => setTimeout(resolve, SIM_DT))
                const t = Date.now()
                for (let left = t - last; left >= SIM_DT && !sim.result; left -= SIM_DT) sim.step()
                last = t - ((t - last) % SIM_DT)
            }
            await bridge.idle()
        }
        const w = sim.world
        const result = sim.result ?? "timeout"
        if (result === "won") bench.wins++
        bench.seconds += sim.clock / 1000
        bench.hpAtEnd.push(w.health)
        bench.idleMs += sim.idleMs
        bench.playMs += sim.playMs
        bench.longestIdleMs = Math.max(bench.longestIdleMs, sim.longestIdleMs)
        for (const k of ["bite", "shot", "lava"] as const) bench.damage[k] += sim.damage[k]
        addStats(bench.stats, bridge.stats)
        console.log(`${bench.name} run ${run}: ${result} in ${(sim.clock / 1000).toFixed(1)} s, hp ${w.health}, kills ${w.kills}/${w.total}; ${summary(bridge.stats, sim.clock / 1000)}`)
        if (opts.record && result === "won" && !recorded) {
            fs.writeFileSync(opts.record, JSON.stringify(recording(sim)) + "\n")
            recorded = true
            console.log(`recorded ${sim.frames.length} frames to ${opts.record}`)
        }
    }
    return bench
}

async function checkConsole(): Promise<void> {
    const usb = new Hf2Transport()
    usb.open()
    const lines: string[] = []
    usb.onLine((line) => lines.push(line))
    console.log(`HF2 mode ${await usb.bininfo()} (2 = game running)`)
    const addr = await usb.findBox()
    const box = await usb.readBox()
    console.log(`mailbox at 0x${addr.toString(16)}, signature ${isBox(box) ? "ok" : "BAD"}, seq ${box[8] | (box[9] << 8)}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const ai = lines.filter((l) => l.startsWith("AI "))
    console.log(`console: ${lines.length} lines in 3 s, ${ai.length} AI lines${ai.length === 0 ? " (pick PLAYER AI in the menu and start a level)" : ""}`)
    for (const l of lines.slice(-3)) console.log(`  ${l}`)
    await usb.close()
}

async function runConsole(fake: boolean, filming: boolean): Promise<void> {
    const api = loadLogic()
    const jev = pickJev(fake)
    const log = openLog()
    const film = filming ? openFilm() : null
    const usb = new Hf2Transport()
    usb.open()
    console.log(`HF2 mode ${await usb.bininfo()} (2 = game running), ${fake ? "fake picks" : jevModel()}, log ${log.file}`)
    if (film) console.log(`film ${film.file} (npm run ai:film -- ${path.relative(process.cwd(), film.file)})`)
    const started = Date.now()
    usb.onLine((line) => {
        film?.recorder.line(line)
        if (!line.startsWith("AI ")) console.log(`console: ${line}`)
    })
    const bridge = new Bridge(api, usb, jev, (rec) => {
        log.write(rec)
        film?.recorder.record(rec)
        printDecision(rec)
    })
    const stop = async () => {
        console.log(summary(bridge.stats, (Date.now() - started) / 1000))
        await usb.close()
        process.exit(0)
    }
    process.on("SIGINT", () => void stop())
    await new Promise(() => {})
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            sim: { type: "string" },
            difficulty: { type: "string", default: "normal" },
            runs: { type: "string", default: "1" },
            timeout: { type: "string", default: "240" },
            record: { type: "string" },
            fake: { type: "boolean", default: false },
            fast: { type: "boolean", default: false },
            lag: { type: "string", default: "0" },
            "no-reflexes": { type: "boolean", default: false },
            "no-predict": { type: "boolean", default: false },
            quiet: { type: "boolean", default: false },
            check: { type: "boolean", default: false },
            film: { type: "boolean", default: false },
        },
    })
    const difficulty = DIFFICULTIES.indexOf(values.difficulty.toLowerCase())
    if (difficulty < 0) throw new Error(`--difficulty: ${DIFFICULTIES.join(", ")}`)
    if (values.fast && !values.fake) throw new Error("--fast needs --fake: real Jev runs in real time")
    if (values.check) return checkConsole()
    if (values.sim === undefined) return runConsole(values.fake, values.film)
    const film = values.film ? openFilm() : null
    if (film) console.log(`film ${film.file}`)
    return runSim({
        level: values.sim,
        difficulty,
        runs: Number(values.runs),
        fake: values.fake,
        fast: values.fast,
        lag: Number(values.lag),
        reflexes: !values["no-reflexes"],
        predict: !values["no-predict"],
        timeout: Number(values.timeout),
        record: values.record,
        film: film?.recorder ?? null,
        quiet: values.quiet,
    })
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
