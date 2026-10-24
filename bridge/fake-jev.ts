// Offline stand-in for Jev: reads the same facts and picks with a few fixed rules. Used by tests
// and by `npm run ai -- --sim LEVEL --fake` to check the link without an API key.
import type { Action, JevAnswer } from "./jev.ts"

interface Pickup {
    steps: number
    detour_steps: number
}

interface Facts {
    health: number
    health_state: string
    ammo: number
    enemies: Array<{ distance: number; sees_you: boolean; in_crosshair: boolean; in_bite_range: boolean }>
    fireballs: Array<{ hits_in_ms: number; safe_side: string }>
    door_ahead: string
    medkit: Pickup | null
    ammo_pickup: Pickup | null
    shotgun: Pickup | null
}

const SHOTGUN_STEPS = 10
const MEDKIT_DETOUR = 6

export function fakePick(state: Record<string, unknown>): Action {
    const f = state as unknown as Facts
    const ball = f.fireballs.find((b) => b.hits_in_ms < 700 && b.safe_side !== "none")
    if (ball) return ball.safe_side === "left" ? "dodge_left" : "dodge_right"
    const biting = f.enemies.find((e) => e.in_bite_range)
    if (biting && f.health < 40 && f.ammo > 0) return "retreat"
    if (f.health_state !== "ok" && f.medkit && f.medkit.detour_steps <= MEDKIT_DETOUR) return "heal"
    const threat = f.enemies.find((e) => e.in_crosshair || (e.sees_you && e.distance < 6))
    if (threat && f.ammo > 0) return "attack"
    if (f.shotgun && f.shotgun.steps < SHOTGUN_STEPS) return "weapon"
    if (f.ammo < 3 && f.ammo_pickup) return "ammo"
    if (f.door_ahead === "closed") return "open"
    return "advance"
}

export async function fakeJev(state: Record<string, unknown>): Promise<JevAnswer> {
    return { action: fakePick(state), confidence: 0.9, danger: null, cost: 0, latencyMs: 0, error: "" }
}
