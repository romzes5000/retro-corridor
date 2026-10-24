// Jev (TypeSafe System One) over OpenRouter: one Choice for the next tactic, one Noul for danger.
export const JEV_URL = "https://openrouter.ai/api/v1/systemone"
export const DEFAULT_MODEL = "~typesafe/jev-latest"
export const TIMEOUT_MS = 1500

export const ACTIONS = ["advance", "attack", "dodge_left", "dodge_right", "retreat", "heal", "ammo", "weapon", "open", "wait"] as const
export type Action = (typeof ACTIONS)[number]

const INSTRUCTIONS = "You are the player in a first-person maze shooter. Pick the best action for the next half second to survive and reach the goal."

const CRITERIA: Record<Action, string> = {
    advance: "Walk along the route toward the goal (key, then its door, then the exit), or explore while the goal is not found yet",
    attack: "Turn to the nearest visible enemy and shoot it",
    dodge_left: "Sidestep to the player's left; this is the safe move when a fireball's safe_side is left",
    dodge_right: "Sidestep to the player's right; this is the safe move when a fireball's safe_side is right",
    retreat: "Back away from the nearest enemy while shooting at it, or step away from a fireball; pointless when neither is near",
    heal: "Walk to the nearest medkit; a medkit restores health, which matters when health is hurt or critical",
    ammo: "Walk toward the nearest ammo",
    weapon: "Walk to the shotgun and pick it up; it triples the damage of the pistol, which matters when weapon_state is weak",
    open: "Press use on the door or wall right ahead",
    wait: "Stand still for a moment",
}

export const ACTION_QUESTIONS = {
    action: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
    danger: {
        type: "noul",
        instructions: "Is the player about to take damage?",
    },
} as const

// Request without the danger question, for latency comparison in `probe --variants`.
export const ACTION_ONLY = { action: ACTION_QUESTIONS.action } as const

export const LESSON_CRITERION = "; this is what lesson says to do"

// With a lesson in force its action's criterion points at the `lesson` field: a criterion that
// names a state field is what moved Jev for the shotgun, the field alone did not.
export function questionsFor(lesson: Action | null): typeof ACTION_QUESTIONS {
    if (!lesson) return ACTION_QUESTIONS
    const criteria = { ...CRITERIA, [lesson]: CRITERIA[lesson] + LESSON_CRITERION }
    return { ...ACTION_QUESTIONS, action: { ...ACTION_QUESTIONS.action, criteria } } as unknown as typeof ACTION_QUESTIONS
}

export function jevModel(): string {
    return process.env.JEV_MODEL || DEFAULT_MODEL
}

export interface JevAnswer {
    action: Action
    // Probability Jev gave its pick, 0..1.
    confidence: number
    danger: number | null
    cost: number
    latencyMs: number
    error: string
}

export interface JevHint {
    // Action of the lesson in force, if any.
    lesson?: Action | null
}

export type JevFn = (state: Record<string, unknown>, hint?: JevHint) => Promise<JevAnswer>

function isAction(v: unknown): v is Action {
    return typeof v === "string" && (ACTIONS as readonly string[]).includes(v)
}

// Pulls the pick, its confidence, danger and cost out of a System One response; throws on a shape
// it cannot trust so the caller falls back to "wait".
export function parseAnswer(body: unknown): Omit<JevAnswer, "latencyMs" | "error"> {
    const answers = (body as { answers?: Record<string, Record<string, unknown>> })?.answers
    const pick = answers?.action
    if (!pick || !isAction(pick.choice)) throw new Error(`no action in answer: ${JSON.stringify(body).slice(0, 200)}`)
    const probs = pick.probabilities as Record<string, number> | undefined
    const raw = typeof probs?.[pick.choice] === "number" ? probs[pick.choice] : pick.confidence
    const confidence = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    const noul = answers?.danger?.noul
    const usage = (body as { usage?: { cost?: number } }).usage
    return {
        action: pick.choice,
        confidence,
        danger: typeof noul === "number" ? noul : null,
        cost: typeof usage?.cost === "number" ? usage.cost : 0,
    }
}

export interface JevOptions {
    key: string
    model?: string
    timeoutMs?: number
    fetch?: typeof fetch
    now?: () => number
}

// Calls Jev with a hard timeout. Never throws: any failure answers "wait" with the reason.
export function makeJev(opts: JevOptions): JevFn {
    const doFetch = opts.fetch ?? fetch
    const now = opts.now ?? Date.now
    const model = opts.model ?? jevModel()
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
    return async (state, hint) => {
        const started = now()
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), timeoutMs)
        try {
            const res = await doFetch(JEV_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model, state, questions: questionsFor(hint?.lesson ?? null) }),
                signal: abort.signal,
            })
            const body = await res.json()
            if (!res.ok) throw new Error(`http ${res.status}`)
            return { ...parseAnswer(body), latencyMs: now() - started, error: "" }
        } catch (err) {
            const error = abort.signal.aborted ? `timeout ${timeoutMs} ms` : err instanceof Error ? err.message : String(err)
            return { action: "wait", confidence: 0, danger: null, cost: 0, latencyMs: now() - started, error }
        } finally {
            clearTimeout(timer)
        }
    }
}
