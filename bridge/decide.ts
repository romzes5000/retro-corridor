// Jev picks a tactic; this turns it into one mailbox command the console can execute alone.
import type { LogicApi, World } from "../load-logic.ts"
import type { Action } from "./jev.ts"
import { CMD } from "./mailbox.ts"
import { ROUTE_CELLS, waypoints, type Situation } from "./observe.ts"
import type { Cell } from "./route.ts"

export interface Decision {
    // What actually runs; differs from the pick when the pick is impossible right now.
    action: Action
    cmd: number
    a: number
    b: number
    label: string
    // GOTO points after (a, b).
    route: Cell[]
}

const LABELS: Record<Action, string> = {
    advance: "ADVANCE",
    attack: "ATTACK",
    dodge_left: "DODGE L",
    dodge_right: "DODGE R",
    retreat: "RETREAT",
    heal: "HEAL",
    ammo: "AMMO",
    weapon: "SHOTGUN",
    open: "OPEN",
    wait: "WAIT",
}

const WAIT_TICKS = 25
// Jev's danger at or above this shortens GOTO so the next decision lands sooner.
export const DANGER_SHORT = 0.6
const SHORT_CELLS = 1
// Backpedalling with fire is skipped when a fireball lands sooner than this: step out of it instead.
const BALL_SOON_MS = 700
export const BACKPEDAL = 1

// Below this health a reachable medkit beats any pick that is not fighting or dodging: Jev kept
// walking past one at 20-30 HP.
export const MUST_HEAL_HP = 40
const CALM: readonly Action[] = ["advance", "wait", "open", "ammo", "weapon"]

export function mustHeal(world: World, sit: Situation, pick: Action): boolean {
    if (world.health >= MUST_HEAL_HP || !sit.medkit || sit.medkit.steps === 0) return false
    if (CALM.includes(pick)) return true
    return pick === "retreat" && sit.enemies.length === 0 && sit.fireballs.length === 0
}

function make(action: Action, cmd: number, a = 0, b = 0, route: Cell[] = []): Decision {
    return { action, cmd, a, b, label: LABELS[action], route }
}

function attackTarget(sit: Situation): number {
    if (sit.target >= 0 && sit.enemies.some((e) => e.i === sit.target)) return sit.target
    const seen = sit.enemies.find((e) => e.sees)
    return (seen ?? sit.enemies[0])?.i ?? -1
}

function walk(action: Action, path: Cell[], danger: number): Decision | null {
    const points = waypoints(path, danger >= DANGER_SHORT ? SHORT_CELLS : ROUTE_CELLS)
    if (points.length === 0) return null
    return make(action, CMD.goto, points[0][0], points[0][1], points.slice(1))
}

function advance(api: LogicApi, world: World, sit: Situation, danger: number): Decision {
    if (sit.next) {
        const go = walk("advance", sit.path, danger)
        if (go) return go
    }
    if (sit.goal === "boss" && sit.bossSeen) {
        const boss = world.enemies.findIndex((e) => !e.dead && e.kind === api.ENEMY_BOSS)
        if (boss >= 0) return make("attack", CMD.attack, boss)
    }
    if (sit.doorAhead === "closed") return make("open", CMD.use)
    return make("wait", CMD.wait, WAIT_TICKS)
}

function fetchItem(api: LogicApi, world: World, sit: Situation, action: Action, item: Situation["medkit"], danger: number): Decision {
    return (item && walk(action, item.path, danger)) || advance(api, world, sit, danger)
}

function retreat(api: LogicApi, world: World, sit: Situation, danger: number): Decision {
    const nearest = sit.enemies[0]
    const ballSoon = sit.fireballs.some((f) => f.etaMs < BALL_SOON_MS)
    if (nearest && world.ammo >= 1 && !ballSoon) return make("retreat", CMD.attack, nearest.i, BACKPEDAL)
    if (sit.back) return make("retreat", CMD.goto, sit.back[0], sit.back[1])
    return advance(api, world, sit, danger)
}

export function decide(api: LogicApi, world: World, sit: Situation, pick: Action, danger: number | null = null): Decision {
    const d = danger ?? 0
    switch (pick) {
        case "advance":
            return advance(api, world, sit, d)
        case "attack": {
            const i = attackTarget(sit)
            if (i < 0 || world.ammo < 1) return advance(api, world, sit, d)
            return make("attack", CMD.attack, i)
        }
        case "dodge_left":
            return make("dodge_left", CMD.strafe, 0)
        case "dodge_right":
            return make("dodge_right", CMD.strafe, 1)
        case "retreat":
            return retreat(api, world, sit, d)
        case "heal":
            return fetchItem(api, world, sit, "heal", sit.medkit, d)
        case "ammo":
            return fetchItem(api, world, sit, "ammo", sit.ammo, d)
        case "weapon":
            return fetchItem(api, world, sit, "weapon", sit.shotgun, d)
        case "open":
            return make("open", CMD.use)
        case "wait":
            return make("wait", CMD.wait, WAIT_TICKS)
        default: {
            const never: never = pick
            return never
        }
    }
}
