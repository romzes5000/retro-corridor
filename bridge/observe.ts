// Turns the shadow world into (a) a situation the bridge can act on and (b) plain English facts
// for Jev. Facts describe; they never prescribe an action.
import type { LogicApi, World } from "../load-logic.ts"
import { angleDiff, angleTo, exitSpot, findPath, KEY_ITEMS, passable, planRoute, type Cell } from "./route.ts"

export type GoalKind = "key" | "exit" | "boss" | "none"

export interface EnemyView {
    i: number
    kind: string
    cells: number
    direction: string
    sees: boolean
    hp: number
    inCrosshair: boolean
}

export interface FireballView {
    from: string
    safeSide: "left" | "right" | "none"
    etaMs: number
}

export interface Situation {
    at: Cell
    goal: GoalKind
    goalCell: Cell | null
    steps: number
    // Next GOTO target: up to 2 cells in a straight line along the route.
    next: Cell | null
    back: Cell | null
    medkit: { cell: Cell; steps: number; next: Cell } | null
    ammo: { cell: Cell; steps: number; next: Cell } | null
    enemies: EnemyView[]
    // Live enemies in range with a wall between them and the player.
    hidden: number
    fireballs: FireballView[]
    doorAhead: "closed" | "locked" | "opening" | "none"
    target: number
}

const ENEMY_NAMES = ["imp", "shooter", "knight", "boss"]
const KEY_NAMES: Record<number, string> = { 1: "red", 2: "blue" }
const NEAR_ENEMIES = 4
const ENEMY_RANGE = 8
const FIREBALL_RANGE = 3.5

const cellOf = (x: number, y: number): Cell => [x >> 10, y >> 10]
const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

// Farthest cell (at most 2) the route keeps going straight from its start.
export function straightStep(path: Cell[]): Cell | null {
    if (path.length < 2) return null
    const dx = path[1][0] - path[0][0]
    const dy = path[1][1] - path[0][1]
    let k = 1
    while (k < 2 && k + 1 < path.length && path[k + 1][0] - path[k][0] === dx && path[k + 1][1] - path[k][1] === dy) k++
    return path[k]
}

// Exit tile behind the floor cell exitSpot() returns, so the last GOTO walks into it.
function exitTile(api: LogicApi, world: World): { spot: Cell; tile: Cell } | null {
    try {
        const spot = exitSpot(api, world)
        const step: Record<number, Cell> = { 0: [1, 0], 512: [-1, 0], 256: [0, 1], 768: [0, -1] }
        const d = step[spot.ang]
        return { spot: spot.cell, tile: [spot.cell[0] + d[0], spot.cell[1] + d[1]] }
    } catch {
        return null
    }
}

function direction(api: LogicApi, world: World, x: number, y: number): string {
    const rel = angleDiff(api, world.ang, angleTo(api, world, x, y))
    const a = Math.abs(rel)
    if (a <= 64) return "ahead"
    if (a >= 384) return "behind"
    if (a <= 160) return rel > 0 ? "ahead-right" : "ahead-left"
    return rel > 0 ? "right" : "left"
}

function fireballs(api: LogicApi, world: World): FireballView[] {
    const lane = api.PLAYER_RADIUS + api.SHOT_RADIUS + 200
    const rightX = -api.sin(world.ang) / api.FP
    const rightY = api.cos(world.ang) / api.FP
    const out: FireballView[] = []
    for (const shot of world.shots) {
        const rx = world.x - shot.x
        const ry = world.y - shot.y
        const along = rx * shot.vx + ry * shot.vy
        const v2 = shot.vx * shot.vx + shot.vy * shot.vy
        if (along <= 0 || v2 === 0 || Math.hypot(rx, ry) > FIREBALL_RANGE * api.FP) continue
        const px = rx - (along / v2) * shot.vx
        const py = ry - (along / v2) * shot.vy
        if (Math.hypot(px, py) > lane) continue
        // A sidestep only leaves the line of a ball flying along the facing axis; one crossing from
        // the side keeps hitting whatever the strafe direction.
        const lateral = Math.abs(shot.vx * rightX + shot.vy * rightY)
        const frontal = Math.abs(shot.vx * rightY - shot.vy * rightX)
        let side: "left" | "right" | "none" = px * rightX + py * rightY >= 0 ? "right" : "left"
        const probe = (s: string) => {
            const d = s === "right" ? 1 : -1
            return api.fits(world, world.x + rightX * d * 600, world.y + rightY * d * 600, api.PLAYER_RADIUS)
        }
        if (lateral > frontal) side = "none"
        else if (!probe(side)) side = side === "right" ? "left" : "right"
        if (side !== "none" && !probe(side)) side = "none"
        out.push({ from: direction(api, world, shot.x, shot.y), safeSide: side, etaMs: Math.round((along * 1000) / v2) })
    }
    return out.sort((a, b) => a.etaMs - b.etaMs)
}

function nearestItem(api: LogicApi, world: World, at: Cell, kind: number): Situation["medkit"] {
    let best: Situation["medkit"] = null
    for (const item of world.items) {
        if (item.taken || item.kind !== kind) continue
        const cell = cellOf(item.x, item.y)
        const path = same(cell, at) ? [at] : findPath(api, world, at, cell)
        if (path.length === 0) continue
        const next = straightStep(path)
        if (next && (!best || path.length - 1 < best.steps)) best = { cell, steps: path.length - 1, next }
    }
    return best
}

// Neighbour cell that takes the player farthest from the nearest live enemy or fireball.
function backStep(api: LogicApi, world: World, at: Cell): Cell | null {
    const threats = [
        ...world.enemies.filter((e) => !e.dead && (e.sees || e.awake)).map((e) => [e.x, e.y]),
        ...world.shots.map((s) => [s.x, s.y]),
    ]
    if (threats.length === 0) return null
    let best: Cell | null = null
    let bestGap = -Infinity
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell: Cell = [at[0] + dx, at[1] + dy]
        if (!passable(api, world, cell[0], cell[1], world.keys)) continue
        const cx = cell[0] * api.FP + api.FP / 2
        const cy = cell[1] * api.FP + api.FP / 2
        const gap = Math.min(...threats.map(([x, y]) => Math.hypot(x - cx, y - cy)))
        if (gap > bestGap) {
            bestGap = gap
            best = cell
        }
    }
    return best
}

function doorAhead(api: LogicApi, world: World): Situation["doorAhead"] {
    const ax = world.x + ((api.cos(world.ang) * api.USE_REACH) >> 10)
    const ay = world.y + ((api.sin(world.ang) * api.USE_REACH) >> 10)
    const door = api.doorAt(world, ax >> 10, ay >> 10)
    if (!door || door.state === api.DOOR_OPEN) return "none"
    if (door.key !== 0 && (world.keys & door.key) === 0) return "locked"
    return door.state === api.DOOR_OPENING ? "opening" : "closed"
}

export function situate(api: LogicApi, world: World): Situation {
    const at = cellOf(world.x, world.y)
    const exit = exitTile(api, world)
    let goal: GoalKind = "none"
    let goalCell: Cell | null = null
    const boss = world.enemies.findIndex((e) => !e.dead && e.kind === api.ENEMY_BOSS)
    if (world.exitLocked && boss >= 0) {
        goal = "boss"
        goalCell = cellOf(world.enemies[boss].x, world.enemies[boss].y)
    } else if (exit) {
        const route = planRoute(api, world, at, exit.spot)
        goalCell = route ? route[0] : exit.spot
        goal = route && route.length > 1 ? "key" : "exit"
    }
    let path: Cell[] = []
    if (goalCell) path = same(at, goalCell) ? [at] : findPath(api, world, at, goalCell)
    let next = straightStep(path)
    if (goal === "exit" && exit && same(at, exit.spot)) next = exit.tile
    if (goal === "boss" && path.length > 0 && path.length <= 2) next = null
    const target = api.target(world)
    const near = world.enemies
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !e.dead && api.distance(world.x, world.y, e.x, e.y) <= ENEMY_RANGE * api.FP)
    const seen = near.filter(({ e }) => api.canSee(world, world.x, world.y, e.x, e.y))
    const enemies = seen
        .map(({ e, i }) => ({
            i,
            kind: ENEMY_NAMES[e.kind] ?? "enemy",
            cells: Math.round((api.distance(world.x, world.y, e.x, e.y) / api.FP) * 10) / 10,
            direction: direction(api, world, e.x, e.y),
            sees: e.sees,
            hp: e.hp,
            inCrosshair: target === i,
        }))
        .sort((a, b) => a.cells - b.cells)
        .slice(0, NEAR_ENEMIES)
    return {
        at,
        goal,
        goalCell,
        steps: Math.max(0, path.length - 1),
        next,
        back: backStep(api, world, at),
        medkit: nearestItem(api, world, at, api.ITEM_HEALTH),
        ammo: nearestItem(api, world, at, api.ITEM_AMMO),
        enemies,
        hidden: near.length - seen.length,
        fireballs: fireballs(api, world),
        doorAhead: doorAhead(api, world),
        target,
    }
}

function goalText(api: LogicApi, world: World, sit: Situation): string {
    if (sit.goal === "none") return "no goal visible"
    if (sit.goal === "boss") return `kill the boss to unlock the exit, ${sit.steps} steps away`
    if (sit.goal === "key") {
        const item = world.items.find((it) => !it.taken && sit.goalCell && same(cellOf(it.x, it.y), sit.goalCell))
        const colour = item ? KEY_NAMES[KEY_ITEMS[item.kind]] ?? "" : ""
        return `pick up the ${colour} key, ${sit.steps} steps away`.replace("  ", " ")
    }
    if (!sit.next) return "the exit route is blocked"
    return sit.steps === 0 ? "the exit is right ahead, walk into it" : `reach the exit, ${sit.steps} steps away`
}

function routeText(api: LogicApi, world: World, sit: Situation): string {
    if (!sit.next) return "no walkable step toward the goal"
    const x = sit.next[0] * api.FP + api.FP / 2
    const y = sit.next[1] * api.FP + api.FP / 2
    return `next waypoint is ${direction(api, world, x, y)}`
}

// Progress since the previous decision, from the step count to the goal then and now.
export function progressText(before: number | null, now: number): string {
    if (before === null) return "new goal"
    if (now < before) return `closer to the goal (${before} -> ${now} steps)`
    if (now > before) return `farther from the goal (${before} -> ${now} steps)`
    return "no progress toward the goal"
}

// The JSON state Jev reads. English only, short, no instructions.
export function facts(api: LogicApi, world: World, sit: Situation, recent: string[], progress = "new goal"): Record<string, unknown> {
    const weapon = world.weapon === api.WEAPON_SHOTGUN ? "shotgun" : "pistol"
    return {
        goal: goalText(api, world, sit),
        route: routeText(api, world, sit),
        progress,
        health: world.health,
        ammo: world.ammo,
        weapon,
        enemies: sit.enemies.map((e) => ({
            kind: e.kind,
            distance: e.cells,
            direction: e.direction,
            in_crosshair: e.inCrosshair,
            hp: e.hp,
            sees_you: e.sees,
        })),
        enemies_behind_walls: sit.hidden,
        fireballs: sit.fireballs.map((f) => ({
            coming_from: f.from,
            hits_in_ms: f.etaMs,
            safe_side: f.safeSide,
        })),
        door_ahead: sit.doorAhead,
        nearest_medkit: sit.medkit ? sit.medkit.steps : null,
        nearest_ammo: sit.ammo ? sit.ammo.steps : null,
        recent,
    }
}
