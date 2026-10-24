// Who took the player's health: one rule for the sim bench, the film and the death lessons.
import type { LogicApi, World } from "../load-logic.ts"

export type DamageSource = "bite" | "shot" | "lava"

interface Body {
    kind: number
    x: number
    y: number
}

// `shotGone`: a projectile vanished on the same step the health dropped.
export function damageSource(api: LogicApi, world: World, x: number, y: number, shotGone: boolean): DamageSource {
    if (shotGone) return "shot"
    if (api.lavaAt(world, x >> 10, y >> 10)) return "lava"
    return "bite"
}

export function inBiteReach(api: LogicApi, x: number, y: number, e: Body): boolean {
    return api.ENEMY_BITE[e.kind] > 0 && api.distance(x, y, e.x, e.y) <= api.IMP_REACH + api.ENEMY_RADIUS[e.kind]
}

// Nearest enemy that can bite from where it stands, the likely author of a bite.
export function biter<T extends Body>(api: LogicApi, x: number, y: number, enemies: readonly T[]): T | null {
    let best: T | null = null
    let bestD = Infinity
    for (const e of enemies) {
        if (!inBiteReach(api, x, y, e)) continue
        const d = api.distance(x, y, e.x, e.y)
        if (d < bestD) {
            bestD = d
            best = e
        }
    }
    return best
}
