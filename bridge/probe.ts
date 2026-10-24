// Latency and format probe for Jev over OpenRouter: npm run ai:probe [calls]
// Needs OPENROUTER_KEY in the environment; the key is never printed.
import { ACTION_QUESTIONS, JEV_URL, jevModel } from "./jev.ts"

const STATE = {
    goal: "red key, 6 steps, next waypoint is ahead",
    health: 64,
    ammo: 11,
    weapon: "shotgun",
    enemies: [{ kind: "imp", distance: 3, direction: "ahead-left", in_crosshair: false, hp: 2, sees_you: true }],
    fireballs: [{ side: "right", eta_ms: 700 }],
    door_ahead: "none",
    nearest_medkit: 9,
    nearest_ammo: null,
    recent: ["advance ok", "advance ok", "attack hurt"],
}

function percentile(sorted: number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

async function main(): Promise<void> {
    const key = process.env.OPENROUTER_KEY
    if (!key) throw new Error("OPENROUTER_KEY is not set")
    const calls = Number(process.argv[2] || 30)
    const lat: number[] = []
    const picks = new Map<string, number>()
    let errors = 0
    let cost = 0
    let tokens = 0
    let shape = ""
    for (let i = 0; i < calls; i++) {
        const started = Date.now()
        try {
            const res = await fetch(JEV_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: jevModel(), state: STATE, questions: ACTION_QUESTIONS }),
            })
            const body = await res.json() as Record<string, unknown>
            lat.push(Date.now() - started)
            if (!res.ok) {
                errors++
                console.log(`call ${i}: http ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
                continue
            }
            if (!shape) shape = JSON.stringify({ answers: body.answers, usage: body.usage })
            const action = (body.answers as Record<string, { choice?: string }> | undefined)?.action?.choice ?? "?"
            picks.set(action, (picks.get(action) ?? 0) + 1)
            const usage = body.usage as Record<string, number> | undefined
            cost += usage?.cost ?? 0
            tokens += usage?.input_tokens ?? usage?.prompt_tokens ?? 0
        } catch (err) {
            errors++
            console.log(`call ${i}: ${err instanceof Error ? err.message : err}`)
        }
    }
    const sorted = [...lat].sort((a, b) => a - b)
    console.log(`shape ${shape}`)
    console.log(`calls ${calls} errors ${errors} median ${percentile(sorted, 0.5)} ms p95 ${percentile(sorted, 0.95)} ms`)
    console.log(`picks ${JSON.stringify(Object.fromEntries(picks))}`)
    console.log(`cost ${cost.toFixed(6)} USD, input tokens ${tokens}, per call ${(tokens / Math.max(1, calls - errors)).toFixed(0)}`)
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
