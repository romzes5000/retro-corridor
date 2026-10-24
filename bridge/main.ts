// AI player bridge. Console over USB:   npm run ai
// Simulated console, same protocol:     npm run ai -- --sim HANGAR [--difficulty normal] [--runs 5]
// Extra flags: --fake (rule-based picks, no API key), --fast (virtual time, only with --fake),
// --record demo/ai-hangar.json (inputs of the first won run, for the GIF replay),
// --check (console only: find the mailbox, listen to the console for 3 s, no Jev).
// Jev needs OPENROUTER_KEY in the environment; JEV_MODEL overrides the model.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadLogic } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { Hf2Transport } from "./hf2.ts"
import { jevModel, makeJev, type JevFn } from "./jev.ts"
import { Bridge, percentile, type LogRecord, type Stats } from "./loop.ts"
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

async function runSim(opts: { level: string; difficulty: number; runs: number; fake: boolean; fast: boolean; timeout: number; record?: string; quiet: boolean }): Promise<void> {
    const api = loadLogic()
    const level = levelIndex(api, opts.level)
    const jev = pickJev(opts.fake)
    const log = openLog()
    console.log(`sim ${api.LEVELS[level].name} ${DIFFICULTIES[opts.difficulty]}, ${opts.runs} run(s), ${opts.fake ? "fake picks" : jevModel()}, log ${log.file}`)
    let wins = 0
    let recorded = false
    const total: Stats = { decisions: 0, errors: 0, latencies: [], cost: 0, won: 0, dead: 0, stale: 0, skipped: 0 }
    let seconds = 0
    for (let run = 1; run <= opts.runs; run++) {
        const sim = new SimConsole(level, opts.difficulty)
        const now = opts.fast ? () => sim.clock : Date.now
        const bridge = new Bridge(sim.api, sim, jev, (rec) => {
            log.write({ ...rec, run } as LogRecord)
            if (!opts.quiet) printDecision(rec)
        }, now)
        const limit = opts.timeout * 1000
        if (opts.fast) {
            while (!sim.result && sim.clock < limit) {
                sim.step()
                await bridge.idle()
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
        if (result === "won") wins++
        seconds += sim.clock / 1000
        for (const k of ["decisions", "errors", "cost", "stale", "skipped"] as const) total[k] += bridge.stats[k]
        total.latencies.push(...bridge.stats.latencies)
        console.log(`run ${run}: ${result} in ${(sim.clock / 1000).toFixed(1)} s, hp ${w.health}, kills ${w.kills}/${w.total}; ${summary(bridge.stats, sim.clock / 1000)}`)
        if (opts.record && result === "won" && !recorded) {
            fs.writeFileSync(opts.record, JSON.stringify(recording(sim)) + "\n")
            recorded = true
            console.log(`recorded ${sim.frames.length} frames to ${opts.record}`)
        }
    }
    console.log(`won ${wins}/${opts.runs}; ${summary(total, seconds)}`)
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

async function runConsole(fake: boolean): Promise<void> {
    const api = loadLogic()
    const jev = pickJev(fake)
    const log = openLog()
    const usb = new Hf2Transport()
    usb.open()
    console.log(`HF2 mode ${await usb.bininfo()} (2 = game running), ${fake ? "fake picks" : jevModel()}, log ${log.file}`)
    const started = Date.now()
    const bridge = new Bridge(api, usb, jev, (rec) => {
        log.write(rec)
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
            quiet: { type: "boolean", default: false },
            check: { type: "boolean", default: false },
        },
    })
    const difficulty = DIFFICULTIES.indexOf(values.difficulty.toLowerCase())
    if (difficulty < 0) throw new Error(`--difficulty: ${DIFFICULTIES.join(", ")}`)
    if (values.fast && !values.fake) throw new Error("--fast needs --fake: real Jev runs in real time")
    if (values.check) return checkConsole()
    if (values.sim === undefined) return runConsole(values.fake)
    return runSim({
        level: values.sim,
        difficulty,
        runs: Number(values.runs),
        fake: values.fake,
        fast: values.fast,
        timeout: Number(values.timeout),
        record: values.record,
        quiet: values.quiet,
    })
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
