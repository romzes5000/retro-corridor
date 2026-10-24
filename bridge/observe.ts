// Turns the shadow world into (a) a situation the bridge can act on and (b) plain English facts
// for Jev. Facts describe; they never prescribe an action. Enemies and fireballs only count when
// they are in sight now (or, for enemies, were in the last few seconds). Of the map only the
// cells the player has seen count: routes, items, lava and the exit come from knownWorld().
import type { LogicApi, World } from "../load-logic.ts"
import { isFrontier, knownWorld, nearestFrontier, nearestStale } from "./explore.ts"
import { inSight, MEMORY_MS, Memory } from "./memory.ts"
import { angleDiff, angleTo, exitSpot, findPath, KEY_ITEMS, passable, planRoute, type Cell } from "./route.ts"

// `explore`: the goal is not known yet, or no known way leads to it; walk to the nearest unseen part.
export type GoalKind = "key" | "exit" | "boss" | "explore" | "none"

export interface EnemyView {
    i: number
    kind: string
    cells: number
    direction: string
    sees: boolean
    hp: number
    inCrosshair: boolean
    inBiteRange: boolean
}

export interface RememberedView {
    i: number
    kind: string
    secondsAgo: number
    direction: string
    cells: number
}

export interface FireballView {
    from: string
    safeSide: "left" | "right" | "none"
    etaMs: number
}

// A pickup on the map: grid path to it and how many extra steps it costs on the way to the goal.
export interface ItemView {
    cell: Cell
    steps: number
    detour: number
    path: Cell[]
    next: Cell
}

export interface LavaView {
    under: boolean
    cells: number
    direction: string
}

export interface Situation {
    at: Cell
    goal: GoalKind
    goalCell: Cell | null
    // Boss goal only: in sight now, or where it is being looked for.
    bossSeen: boolean
    bossSource: "seen" | "earlier" | ""
    bossAgeMs: number
    // What the level needs next (exit, or the boss while the exit is locked), and whether the
    // player has seen it; an explore goal says why it explores with these two.
    seeking: "exit" | "boss"
    seekingKnown: boolean
    // Explore goal with nothing unexplored left: how long ago the cell being looked over again
    // was on screen (0 for a real frontier).
    recheckMs: number
    steps: number
    // Grid path from the player's cell to the goal; the last cell is the exit tile itself.
    path: Cell[]
    // Explore goal: unseen cells straight on past the frontier, walked into if they are floor.
    beyond: Cell[]
    // First GOTO waypoint along the path (straight, at most 2 cells).
    next: Cell | null
    back: Cell | null
    medkit: ItemView | null
    ammo: ItemView | null
    shotgun: ItemView | null
    enemies: EnemyView[]
    remembered: RememberedView[]
    fireballs: FireballView[]
    doorAhead: "closed" | "locked" | "opening" | "none"
    target: number
    lava: LavaView | null
    // The route is longer than it would be through lava.
    aroundLava: boolean
}

export const ENEMY_NAMES = ["imp", "shooter", "knight", "boss"]
const KEY_NAMES: Record<number, string> = { 1: "red", 2: "blue" }
const NEAR_ENEMIES = 4
const ENEMY_RANGE = 8
const LAVA_RANGE = 2
// While exploring, a seen key this close is picked up before the next unexplored area: walking
// back for it once its door turned up cost D1 about 70 steps.
const KEY_NEAR = 12
const BITE_MARGIN = 150
export const ROUTE_CELLS = 6
const ROUTE_POINTS = 3
const SEGMENT = 2

const cellOf = (x: number, y: number): Cell => [x >> 10, y >> 10]
const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]
const centreOf = (api: LogicApi, c: Cell): [number, number] => [c[0] * api.FP + api.FP / 2, c[1] * api.FP + api.FP / 2]

// Up to 3 GOTO points along a grid path (path[0] is the player's cell), covering at most
// `maxCells` cells. Each point is a straight run of 1-2 cells from the one before, so an older
// console that only reads the first point still accepts it. From index `each` on every cell is a
// point of its own, so the console, which drops a route from its first bad leg, keeps the cells
// before an unseen one that is a wall.
export function waypoints(path: Cell[], maxCells = ROUTE_CELLS, each = Infinity): Cell[] {
    const cells = path.slice(0, maxCells + 1)
    const out: Cell[] = []
    let from = cells[0]
    for (let i = 1; i < cells.length && out.length < ROUTE_POINTS; i++) {
        const c = cells[i]
        const last = i === cells.length - 1
        const n = cells[i + 1]
        const turns = !last && (n[0] - c[0] !== c[0] - cells[i - 1][0] || n[1] - c[1] !== c[1] - cells[i - 1][1])
        const run = Math.abs(c[0] - from[0]) + Math.abs(c[1] - from[1])
        if (last || turns || run >= SEGMENT || i >= each) {
            out.push(c)
            from = c
        }
    }
    return out
}

// GOTO points along the known path and on into the unseen cells past it.
export function walkPoints(path: Cell[], beyond: Cell[], maxCells = ROUTE_CELLS): Cell[] {
    return beyond.length > 0 ? waypoints([...path, ...beyond], maxCells, path.length - 1) : waypoints(path, maxCells)
}

// Every cell a GOTO walks: straight legs from `from` through each point.
export function legCells(from: Cell, points: Cell[]): Cell[] {
    const out: Cell[] = [from]
    for (const p of points) {
        const last = out[out.length - 1]
        const dx = Math.sign(p[0] - last[0])
        const dy = Math.sign(p[1] - last[1])
        if (dx !== 0 && dy !== 0) break
        for (let c: Cell = last; !same(c, p); ) {
            c = [c[0] + dx, c[1] + dy]
            out.push(c)
        }
    }
    return out
}

// The walk planned from where the command in flight takes the player (`ahead`, the predicted
// situation), led there along that command's cells (`sent`). The console finds the player on
// this route whether the answer lands before or after it gets there; a route from the snapshot's
// cell that turns back is off the route once the player walked on, and the console drops it.
export function throughAhead(now: Situation, ahead: Situation, sent: Cell[]): Situation {
    const i = sent.findIndex((c) => same(c, now.at))
    const j = sent.findIndex((c) => same(c, ahead.at))
    if (i < 0 || j <= i || ahead.path.length === 0 || (ahead.goal === "boss" && ahead.bossSeen)) return now
    const path = [...sent.slice(i, j), ...ahead.path]
    return { ...now, goal: ahead.goal, goalCell: ahead.goalCell, path, beyond: ahead.beyond, next: walkPoints(path, ahead.beyond)[0] ?? null }
}

// Kept for callers that only want the first point.
export function straightStep(path: Cell[]): Cell | null {
    return waypoints(path)[0] ?? null
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

const cellsTo = (api: LogicApi, world: World, x: number, y: number) => Math.round((api.distance(world.x, world.y, x, y) / api.FP) * 10) / 10

function fireballs(api: LogicApi, world: World): FireballView[] {
    const out: FireballView[] = []
    for (const shot of world.shots) {
        if (!inSight(api, world, shot.x, shot.y)) continue
        const eta = api.aiShotEta(world, shot)
        if (eta < 0) continue
        const side = api.aiDodgeSide(world, shot)
        out.push({ from: direction(api, world, shot.x, shot.y), safeSide: side > 0 ? "right" : side < 0 ? "left" : "none", etaMs: eta })
    }
    return out.sort((a, b) => a.etaMs - b.etaMs)
}

function pathTo(api: LogicApi, world: World, from: Cell, to: Cell): Cell[] {
    return same(from, to) ? [from] : findPath(api, world, from, to)
}

function nearestItem(api: LogicApi, world: World, at: Cell, kind: number, goalCell: Cell | null, goalSteps: number): ItemView | null {
    let best: ItemView | null = null
    for (const item of world.items) {
        if (item.taken || item.kind !== kind) continue
        const cell = cellOf(item.x, item.y)
        const path = pathTo(api, world, at, cell)
        if (path.length === 0) continue
        const steps = path.length - 1
        if (best && steps >= best.steps) continue
        const onward = goalCell ? pathTo(api, world, cell, goalCell) : []
        const detour = goalCell && onward.length > 0 ? steps + onward.length - 1 - goalSteps : steps
        best = { cell, steps, detour, path, next: waypoints(path)[0] ?? cell }
    }
    return best
}

// Neighbour cell that takes the player farthest from what threatens it: enemies in sight or seen
// in the last few seconds, and fireballs in sight. Null when nothing does.
function backStep(api: LogicApi, world: World, map: World, at: Cell, memory: Memory, enemies: EnemyView[], remembered: RememberedView[]): Cell | null {
    const threats: Array<[number, number]> = []
    for (const e of enemies) threats.push([world.enemies[e.i].x, world.enemies[e.i].y])
    for (const r of remembered) {
        const s = memory.last.get(r.i)
        if (s) threats.push([s.x, s.y])
    }
    for (const s of world.shots) if (inSight(api, world, s.x, s.y)) threats.push([s.x, s.y])
    if (threats.length === 0) return null
    let best: Cell | null = null
    let bestGap = -Infinity
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell: Cell = [at[0] + dx, at[1] + dy]
        if (!passable(api, map, cell[0], cell[1], world.keys)) continue
        const [cx, cy] = centreOf(api, cell)
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

function nearestLava(api: LogicApi, world: World, at: Cell): LavaView | null {
    if (api.lavaAt(world, at[0], at[1])) return { under: true, cells: 0, direction: "under you" }
    let best: LavaView | null = null
    for (let dy = -LAVA_RANGE; dy <= LAVA_RANGE; dy++) {
        for (let dx = -LAVA_RANGE; dx <= LAVA_RANGE; dx++) {
            if (!api.lavaAt(world, at[0] + dx, at[1] + dy)) continue
            const [x, y] = centreOf(api, [at[0] + dx, at[1] + dy])
            const cells = cellsTo(api, world, x, y)
            if (!best || cells < best.cells) best = { under: false, cells, direction: direction(api, world, x, y) }
        }
    }
    return best
}

export function biteReach(api: LogicApi, kind: number): number {
    return api.ENEMY_BITE[kind] > 0 ? api.IMP_REACH + api.ENEMY_RADIUS[kind] - api.IMP_RADIUS + BITE_MARGIN : 0
}

// Nearest key on the known map the player does not hold, reachable now.
function nearestKey(api: LogicApi, map: World, at: Cell): Cell | null {
    let best: Cell | null = null
    let bestLen = Infinity
    for (const item of map.items) {
        const bit = KEY_ITEMS[item.kind]
        if (!bit || item.taken || (map.keys & bit) !== 0) continue
        const len = pathTo(api, map, at, cellOf(item.x, item.y)).length
        if (len > 0 && len < bestLen) {
            best = cellOf(item.x, item.y)
            bestLen = len
        }
    }
    return best
}

// `world` is the live shadow world: enemies, fireballs, the crosshair and the door ahead are read
// from the current view. Planning (goal, path, items, lava) sees only what memory.known holds.
// Without a memory the situation is built from what is on screen right now.
export function situate(api: LogicApi, world: World, memory?: Memory): Situation {
    if (!memory) {
        memory = new Memory()
        memory.observe("now", api, world, 0)
    }
    const map = knownWorld(api, world, memory.known)
    const at = cellOf(world.x, world.y)
    const exit = exitTile(api, map)
    const target = api.target(world)
    const near = world.enemies
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !e.dead && api.distance(world.x, world.y, e.x, e.y) <= ENEMY_RANGE * api.FP)
        .filter(({ e }) => inSight(api, world, e.x, e.y))
    const enemies: EnemyView[] = near
        .map(({ e, i }) => {
            const d = api.distance(world.x, world.y, e.x, e.y)
            return {
                i,
                kind: ENEMY_NAMES[e.kind] ?? "enemy",
                cells: Math.round((d / api.FP) * 10) / 10,
                direction: direction(api, world, e.x, e.y),
                sees: e.sees,
                hp: e.hp,
                inCrosshair: target === i,
                inBiteRange: d <= biteReach(api, e.kind),
            }
        })
        .sort((a, b) => a.cells - b.cells)
        .slice(0, NEAR_ENEMIES)
    const remembered: RememberedView[] = memory.recent(api, world).map((s) => ({
        i: s.i,
        kind: ENEMY_NAMES[s.kind] ?? "enemy",
        secondsAgo: Math.round((memory.now - s.at) / 100) / 10,
        direction: direction(api, world, s.x, s.y),
        cells: cellsTo(api, world, s.x, s.y),
    }))

    let goal: GoalKind = "none"
    let goalCell: Cell | null = null
    let bossSeen = false
    let bossSource: Situation["bossSource"] = ""
    let bossAgeMs = 0
    let seeking: Situation["seeking"] = "exit"
    let seekingKnown = false
    const boss = memory.bossIndex(api, world)
    let recheckMs = 0
    const lookFor = () => {
        const look = memory.bossTarget(api, world)
        if (look) {
            bossSource = look.source
            bossAgeMs = look.ageMs
        }
        return look?.cell ?? null
    }
    if (world.exitLocked && boss >= 0) {
        seeking = "boss"
        const b = world.enemies[boss]
        bossSeen = inSight(api, world, b.x, b.y)
        const cell = bossSeen ? cellOf(b.x, b.y) : lookFor()
        seekingKnown = cell !== null
        if (cell && pathTo(api, map, at, cell).length > 0) {
            goal = "boss"
            goalCell = cell
        } else if (cell) {
            const route = planRoute(api, map, at, cell)
            if (route && route.length > 1) {
                goal = "key"
                goalCell = route[0]
            } else if (bossSeen) {
                goal = "boss"
                goalCell = cell
            }
        }
    } else if (exit) {
        seekingKnown = true
        const route = planRoute(api, map, at, exit.spot)
        if (route) {
            goalCell = route[0]
            goal = route.length > 1 ? "key" : "exit"
        }
    }
    let beyond: Cell[] = []
    if (goal === "none") {
        const commit = memory.observed === world
        const key = nearestKey(api, map, at)
        const frontier = nearestFrontier(api, map, memory.known, at, commit)
            ?? (key || seeking !== "boss" ? null : nearestStale(api, map, memory.known, at, memory.now, commit))
        const keyFirst = key !== null && (!frontier || pathTo(api, map, at, key).length - 1 <= KEY_NEAR)
        if (keyFirst) {
            goal = "key"
            goalCell = key
        } else if (frontier) {
            goal = "explore"
            goalCell = frontier.cell
            beyond = frontier.beyond
            if (!isFrontier(api, map, memory.known, frontier.cell)) recheckMs = memory.known.ageMs(frontier.cell[0], frontier.cell[1], memory.now)
        }
    }
    let path: Cell[] = goalCell ? pathTo(api, map, at, goalCell) : []
    if (goal === "exit" && exit && path.length > 0) path = [...path, exit.tile]
    if (path.length === 0) beyond = []
    let next = walkPoints(path, beyond)[0] ?? null
    if (goal === "boss" && bossSeen && path.length > 0 && path.length <= 2) next = null
    let aroundLava = false
    if (goalCell && path.length > 1) {
        const direct = findPath(api, map, at, goalCell, world.keys, false)
        aroundLava = direct.length > 0 && direct.length < pathTo(api, map, at, goalCell).length
    }
    const steps = Math.max(0, (goalCell ? pathTo(api, map, at, goalCell).length : 0) - 1)
    return {
        at,
        goal,
        goalCell,
        bossSeen,
        bossSource,
        bossAgeMs,
        seeking,
        seekingKnown,
        recheckMs,
        steps,
        path,
        beyond,
        next,
        back: backStep(api, world, map, at, memory, enemies, remembered),
        medkit: world.health < 100 ? nearestItem(api, map, at, api.ITEM_HEALTH, goalCell, steps) : null,
        ammo: nearestItem(api, map, at, api.ITEM_AMMO, goalCell, steps),
        shotgun: world.hasShotgun ? null : nearestItem(api, map, at, api.ITEM_SHOTGUN, goalCell, steps),
        enemies,
        remembered,
        fireballs: fireballs(api, world),
        doorAhead: doorAhead(api, world),
        target,
        lava: nearestLava(api, map, at),
        aroundLava,
    }
}

function exploreText(sit: Situation): string {
    if (sit.recheckMs > 0) return `boss not in sight and the map is explored: look again at an area last seen ${(sit.recheckMs / 1000).toFixed(0)} s ago, ${sit.steps} steps away`
    const why = sit.seeking === "boss"
        ? sit.seekingKnown ? "no known way to the boss yet" : "boss not found yet"
        : sit.seekingKnown ? "exit seen, no known way to it yet" : "exit not found yet"
    return `exploring: ${why}, unexplored area ${sit.steps} steps away`
}

function goalText(api: LogicApi, world: World, sit: Situation): string {
    if (sit.goal === "none") return sit.seeking === "boss" ? "boss not found, nothing left to explore" : "exit not found, nothing left to explore"
    if (sit.goal === "explore") return exploreText(sit)
    if (sit.goal === "boss") {
        if (sit.bossSeen) return `kill the boss to unlock the exit, ${sit.steps} steps away`
        if (sit.bossSource === "seen") return `find the boss to unlock the exit, last seen ${(sit.bossAgeMs / 1000).toFixed(0)} s ago, ${sit.steps} steps away`
        if (sit.bossSource === "earlier") return `find the boss to unlock the exit, seen there on an earlier attempt, ${sit.steps} steps away`
        return "find the boss to unlock the exit"
    }
    if (sit.goal === "key") {
        const item = world.items.find((it) => !it.taken && sit.goalCell && same(cellOf(it.x, it.y), sit.goalCell))
        const colour = item ? KEY_NAMES[KEY_ITEMS[item.kind]] ?? "" : ""
        return `pick up the ${colour} key, ${sit.steps} steps away`.replace("  ", " ")
    }
    if (!sit.next) return "the exit route is blocked"
    return sit.steps === 0 ? "the exit is right ahead, walk into it" : `reach the exit, ${sit.steps} steps away`
}

function cellDirection(api: LogicApi, world: World, c: Cell): string {
    const [x, y] = centreOf(api, c)
    return direction(api, world, x, y)
}

function routeText(api: LogicApi, world: World, sit: Situation): string {
    if (!sit.next) return "no walkable step toward the goal"
    const text = `next waypoint is ${cellDirection(api, world, sit.next)}`
    return sit.aroundLava ? `route goes around lava, ${text}` : text
}

// Progress since the previous decision, from the step count to the goal then and now.
export function progressText(before: number | null, now: number): string {
    if (before === null) return "new goal"
    if (now < before) return `closer to the goal (${before} -> ${now} steps)`
    if (now > before) return `farther from the goal (${before} -> ${now} steps)`
    return "no progress toward the goal"
}

export function healthState(hp: number): "critical" | "hurt" | "ok" {
    if (hp < 40) return "critical"
    if (hp < 70) return "hurt"
    return "ok"
}

function itemFacts(api: LogicApi, world: World, item: ItemView | null): Record<string, unknown> | null {
    if (!item) return null
    return { steps: item.steps, direction: cellDirection(api, world, item.next), detour_steps: item.detour }
}

const SHOTGUN_TEXT = "shotgun, 3 pellets of 1-3 damage, 2 ammo per shot"
export const SHOTGUN_NEAR = 10

// Jev ignores a shotgun lying a few steps off the route unless the facts say the pistol is weak
// and the shotgun close; the distance alone did not make it detour.
export function weaponState(world: World, sit: Situation): "strong" | "weak" | "weak, a shotgun is near" {
    if (world.hasShotgun) return "strong"
    return sit.shotgun && sit.shotgun.steps <= SHOTGUN_NEAR ? "weak, a shotgun is near" : "weak"
}

export interface FactsExtra {
    // Out of combat and not moving for this long, from the bridge's own clock.
    stalledMs?: number
    // Text of the death lesson in force.
    lesson?: string
}

// Where the `lesson` field goes. Field order changes what Jev does (see weapon_state).
export const LESSON_POSITION: "last" | "before_weapon_state" = "last"

// The JSON state Jev reads. English only, short, no instructions.
export function facts(api: LogicApi, world: World, sit: Situation, recent: string[], progress = "new goal", extra: FactsExtra = {}, lessonAt = LESSON_POSITION): Record<string, unknown> {
    const weapon = world.weapon === api.WEAPON_SHOTGUN ? SHOTGUN_TEXT : "pistol, 1 damage per shot"
    const medkit = itemFacts(api, world, sit.medkit)
    const state: Record<string, unknown> = {
        goal: goalText(api, world, sit),
        route: routeText(api, world, sit),
        progress,
        health: world.health,
        health_state: healthState(world.health),
        ammo: world.ammo,
        weapon,
        enemies: sit.enemies.map((e) => ({
            kind: e.kind,
            distance: e.cells,
            direction: e.direction,
            in_crosshair: e.inCrosshair,
            in_bite_range: e.inBiteRange,
            hp: e.hp,
            sees_you: e.sees,
        })),
        last_seen: sit.remembered.map((r) => ({ kind: r.kind, seconds_ago: r.secondsAgo, direction: r.direction, distance: r.cells })),
        fireballs: sit.fireballs.map((f) => ({
            coming_from: f.from,
            hits_in_ms: f.etaMs,
            safe_side: f.safeSide,
        })),
        door_ahead: sit.doorAhead,
        medkit: medkit ? { ...medkit, heals: api.HEALTH_PICKUP } : null,
        ammo_pickup: itemFacts(api, world, sit.ammo),
        shotgun: itemFacts(api, world, sit.shotgun),
        lava: sit.lava ? { under_you: sit.lava.under, nearest_cells: sit.lava.cells, direction: sit.lava.direction } : null,
        recent,
    }
    if (extra.lesson && lessonAt === "before_weapon_state") state.lesson = extra.lesson
    // Last on purpose: right after `weapon` Jev never took the shotgun (0 of 6), here 6 of 6.
    state.weapon_state = weaponState(world, sit)
    if ((extra.stalledMs ?? 0) >= STALL_FACT_MS) state.stalled = `standing still for ${((extra.stalledMs ?? 0) / 1000).toFixed(1)} s`
    if (extra.lesson && lessonAt === "last") state.lesson = extra.lesson
    return state
}

export const STALL_FACT_MS = 3000
export { MEMORY_MS }
