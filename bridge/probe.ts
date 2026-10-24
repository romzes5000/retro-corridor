// Latency and format probe for Jev over OpenRouter:
//   npm run ai:probe [calls]                  one request shape, picks and cost
//   npm run ai:probe -- --variants [calls]    action only / action + danger / trimmed state, side by side
// Needs OPENROUTER_KEY in the environment; the key is never printed.
import { ACTION_ONLY, ACTION_QUESTIONS, JEV_URL, jevModel } from "./jev.ts"

export const STATE: Record<string, unknown> = {
    goal: "pick up the red key, 6 steps away",
    route: "next waypoint is ahead",
    progress: "closer to the goal (7 -> 6 steps)",
    health: 64,
    health_state: "hurt",
    ammo: 11,
    weapon: "pistol, 1 damage per shot",
    weapon_state: "weak",
    enemies: [{ kind: "imp", distance: 3, direction: "ahead-left", in_crosshair: false, in_bite_range: false, hp: 2, sees_you: true }],
    last_seen: [{ kind: "shooter", seconds_ago: 2.1, direction: "behind", distance: 4.5 }],
    fireballs: [{ coming_from: "ahead", hits_in_ms: 700, safe_side: "left" }],
    door_ahead: "none",
    medkit: { steps: 9, direction: "left", detour_steps: 6, heals: 25 },
    ammo_pickup: null,
    shotgun: { steps: 12, direction: "behind", detour_steps: 18 },
    lava: null,
    recent: ["advance ok", "advance ok", "attack hurt"],
}

export interface Variant {
    name: string
    questions: Record<string, unknown>
    state: Record<string, unknown>
}

function trimmed(state: Record<string, unknown>): Record<string, unknown> {
    const { recent: _r, route: _p, last_seen: _l, ...rest } = state
    return rest
}

export const VARIANTS: Variant[] = [
    { name: "action only", questions: ACTION_ONLY, state: STATE },
    { name: "action + danger", questions: ACTION_QUESTIONS, state: STATE },
    { name: "trimmed state", questions: ACTION_QUESTIONS, state: trimmed(STATE) },
]

export interface VariantResult {
    name: string
    latencies: number[]
    errors: number
    cost: number
    picks: Record<string, number>
    // Response headers that look like server-side timings, from the last good call.
    timings: Record<string, string>
}

const TIMING = /timing|time|latency|duration|processing/i

export interface ProbeDeps {
    key: string
    fetch?: typeof fetch
    now?: () => number
    model?: string
}

export async function probeVariant(v: Variant, calls: number, deps: ProbeDeps): Promise<VariantResult> {
    const doFetch = deps.fetch ?? fetch
    const now = deps.now ?? Date.now
    const out: VariantResult = { name: v.name, latencies: [], errors: 0, cost: 0, picks: {}, timings: {} }
    for (let i = 0; i < calls; i++) {
        const started = now()
        try {
            const res = await doFetch(JEV_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${deps.key}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: deps.model ?? jevModel(), state: v.state, questions: v.questions }),
            })
            const body = (await res.json()) as Record<string, unknown>
            out.latencies.push(now() - started)
            if (!res.ok) {
                out.errors++
                continue
            }
            const action = (body.answers as Record<string, { choice?: string }> | undefined)?.action?.choice ?? "?"
            out.picks[action] = (out.picks[action] ?? 0) + 1
            out.cost += (body.usage as { cost?: number } | undefined)?.cost ?? 0
            out.timings = {}
            res.headers.forEach((value, name) => {
                if (TIMING.test(name)) out.timings[name] = value
            })
        } catch {
            out.errors++
        }
    }
    return out
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function formatVariants(results: VariantResult[]): string[] {
    const lines = results.map((r) => {
        const timings = Object.entries(r.timings).map(([k, v]) => `${k}=${v}`).join(" ")
        return `${r.name}: median ${percentile(r.latencies, 0.5)} ms p90 ${percentile(r.latencies, 0.9)} ms, errors ${r.errors}, cost ${r.cost.toFixed(6)} USD, picks ${JSON.stringify(r.picks)}${timings ? `, ${timings}` : ""}`
    })
    const base = results.find((r) => r.name === "action only")
    const danger = results.find((r) => r.name === "action + danger")
    if (base && danger) lines.push(`danger adds ${percentile(danger.latencies, 0.5) - percentile(base.latencies, 0.5)} ms to the median`)
    return lines
}

async function legacy(key: string, calls: number): Promise<void> {
    const r = await probeVariant({ name: "current", questions: ACTION_QUESTIONS, state: STATE }, calls, { key })
    console.log(formatVariants([r]).join("\n"))
}

async function main(): Promise<void> {
    const key = process.env.OPENROUTER_KEY
    if (!key) throw new Error("OPENROUTER_KEY is not set")
    const args = process.argv.slice(2)
    const variants = args.includes("--variants")
    const calls = Number(args.find((a) => /^\d+$/.test(a)) ?? (variants ? 20 : 30))
    if (!variants) return legacy(key, calls)
    const results: VariantResult[] = []
    // Interleaved so a slow minute on the provider side hits every variant alike.
    const per = VARIANTS.map((): VariantResult[] => [])
    for (let i = 0; i < calls; i++) {
        for (let k = 0; k < VARIANTS.length; k++) per[k].push(await probeVariant(VARIANTS[k], 1, { key }))
    }
    VARIANTS.forEach((v, k) => {
        const all = per[k]
        const merged: VariantResult = { name: v.name, latencies: all.flatMap((r) => r.latencies), errors: 0, cost: 0, picks: {}, timings: all.at(-1)?.timings ?? {} }
        for (const r of all) {
            merged.errors += r.errors
            merged.cost += r.cost
            for (const [a, n] of Object.entries(r.picks)) merged.picks[a] = (merged.picks[a] ?? 0) + n
        }
        results.push(merged)
    })
    console.log(formatVariants(results).join("\n"))
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
