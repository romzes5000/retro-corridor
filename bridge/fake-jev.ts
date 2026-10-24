// Offline stand-in for Jev: reads the same facts and picks with a few fixed rules. Used by tests
// and by `npm run ai -- --sim LEVEL --fake` to check the link without an API key.
import type { Action, JevAnswer } from "./jev.ts"

interface Facts {
    health: number
    ammo: number
    enemies: Array<{ distance: number; sees_you: boolean; in_crosshair: boolean }>
    fireballs: Array<{ hits_in_ms: number; safe_side: string }>
    door_ahead: string
    nearest_medkit: number | null
    nearest_ammo: number | null
}

export function fakePick(state: Record<string, unknown>): Action {
    const f = state as unknown as Facts
    const ball = f.fireballs.find((b) => b.hits_in_ms < 700 && b.safe_side !== "none")
    if (ball) return ball.safe_side === "left" ? "dodge_left" : "dodge_right"
    if (f.health < 40 && f.nearest_medkit !== null && f.nearest_medkit < 8) return "heal"
    const threat = f.enemies.find((e) => e.in_crosshair || (e.sees_you && e.distance < 6))
    if (threat && f.ammo > 0) return "attack"
    if (f.ammo < 3 && f.nearest_ammo !== null) return "ammo"
    if (f.door_ahead === "closed") return "open"
    return "advance"
}

export async function fakeJev(state: Record<string, unknown>): Promise<JevAnswer> {
    return { action: fakePick(state), confidence: 0.9, danger: null, cost: 0, latencyMs: 0, error: "" }
}
