// Control situations against Jev: npm run ai:eval [-- --runs 5] [--fake]
// Each scenario is asked `runs` times; prints how often the pick was right, latency and cost.
// Needs OPENROUTER_KEY (unless --fake); the key is never printed.
import { parseArgs } from "node:util"
import { loadLogic, type LogicApi } from "../load-logic.ts"
import { fakeJev } from "./fake-jev.ts"
import { jevModel, makeJev, type JevFn } from "./jev.ts"
import { percentile } from "./loop.ts"
import { judge, SCENARIOS, scenarioState, type Scenario } from "./scenarios.ts"

export interface ScenarioScore {
    name: string
    hits: number
    runs: number
    picks: Record<string, number>
}

export interface EvalReport {
    scores: ScenarioScore[]
    latencies: number[]
    cost: number
    errors: number
}

export async function evaluate(api: LogicApi, jev: JevFn, runs: number, scenarios: Scenario[] = SCENARIOS): Promise<EvalReport> {
    const report: EvalReport = { scores: [], latencies: [], cost: 0, errors: 0 }
    for (const sc of scenarios) {
        const state = scenarioState(api, sc)
        const score: ScenarioScore = { name: sc.name, hits: 0, runs, picks: {} }
        for (let i = 0; i < runs; i++) {
            const answer = await jev(state)
            if (answer.error) report.errors++
            report.latencies.push(answer.latencyMs)
            report.cost += answer.cost
            score.picks[answer.action] = (score.picks[answer.action] ?? 0) + 1
            if (!answer.error && judge(sc, answer.action)) score.hits++
        }
        report.scores.push(score)
    }
    return report
}

export function formatReport(report: EvalReport): string[] {
    const lines = report.scores.map((s) => `${s.hits}/${s.runs}  ${s.name}  ${JSON.stringify(s.picks)}`)
    const hits = report.scores.reduce((n, s) => n + s.hits, 0)
    const runs = report.scores.reduce((n, s) => n + s.runs, 0)
    lines.push(`total ${hits}/${runs}, latency median ${percentile(report.latencies, 0.5)} ms p90 ${percentile(report.latencies, 0.9)} ms, errors ${report.errors}, cost ${report.cost.toFixed(5)} USD`)
    return lines
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { runs: { type: "string", default: "5" }, fake: { type: "boolean", default: false } } })
    let jev: JevFn = fakeJev
    if (!values.fake) {
        const key = process.env.OPENROUTER_KEY
        if (!key) throw new Error("OPENROUTER_KEY is not set (or pass --fake)")
        jev = makeJev({ key })
    }
    console.log(`eval ${SCENARIOS.length} scenarios x ${values.runs}, ${values.fake ? "fake picks" : jevModel()}`)
    for (const line of formatReport(await evaluate(loadLogic(), jev, Number(values.runs)))) console.log(line)
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
