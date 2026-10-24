// What the player has seen: the last sighting of each enemy on this level, and where the boss
// might be. Jev only ever hears about enemies that are in sight now or were in the last 5 s.
import type { LogicApi, World } from "../load-logic.ts"
import type { Cell } from "./route.ts"

export const MEMORY_MS = 5000
const REMEMBERED = 4

export interface Sighting {
    i: number
    kind: number
    x: number
    y: number
    at: number
}

export interface BossTarget {
    cell: Cell
    source: "seen" | "spawn"
    ageMs: number
}

const cellKey = (c: Cell) => `${c[0]},${c[1]}`

export function inSight(api: LogicApi, world: World, x: number, y: number): boolean {
    return api.canSee(world, world.x, world.y, x, y)
}

export class Memory {
    now = 0
    // Enemy spawn cells from the map, by enemy index.
    spawns: Cell[] = []
    readonly last = new Map<number, Sighting>()
    // Boss search spots already walked to without finding it.
    readonly checked = new Set<string>()
    private key = ""

    // Call once per trusted snapshot; a new key (run or level) forgets everything.
    observe(key: string, api: LogicApi, world: World, now: number, spawns: Cell[] = this.spawns): void {
        if (key !== this.key) {
            this.key = key
            this.last.clear()
            this.checked.clear()
        }
        this.spawns = spawns
        this.now = now
        world.enemies.forEach((e, i) => {
            if (e.dead) {
                this.last.delete(i)
                return
            }
            if (!inSight(api, world, e.x, e.y)) return
            this.last.set(i, { i, kind: e.kind, x: e.x, y: e.y, at: now })
            if (e.kind === api.ENEMY_BOSS) this.checked.clear()
        })
        const boss = this.bossIndex(api, world)
        if (boss < 0 || inSight(api, world, world.enemies[boss].x, world.enemies[boss].y)) return
        const target = this.bossTarget(api, world)
        if (target && target.cell[0] === world.x >> 10 && target.cell[1] === world.y >> 10) this.checked.add(cellKey(target.cell))
    }

    // Enemies out of sight now but seen in the last MEMORY_MS, freshest first.
    recent(api: LogicApi, world: World): Sighting[] {
        return [...this.last.values()]
            .filter((s) => this.now - s.at <= MEMORY_MS && world.enemies[s.i] && !world.enemies[s.i].dead)
            .filter((s) => !inSight(api, world, world.enemies[s.i].x, world.enemies[s.i].y))
            .sort((a, b) => b.at - a.at)
            .slice(0, REMEMBERED)
    }

    bossIndex(api: LogicApi, world: World): number {
        return world.enemies.findIndex((e) => !e.dead && e.kind === api.ENEMY_BOSS)
    }

    // Where to look for a boss that is out of sight: where it was last seen, else where it appears.
    bossTarget(api: LogicApi, world: World): BossTarget | null {
        const boss = this.bossIndex(api, world)
        if (boss < 0) return null
        const candidates: BossTarget[] = []
        const seen = this.last.get(boss)
        if (seen) candidates.push({ cell: [seen.x >> 10, seen.y >> 10], source: "seen", ageMs: this.now - seen.at })
        const spawn = this.spawns[boss]
        if (spawn) candidates.push({ cell: spawn, source: "spawn", ageMs: 0 })
        if (candidates.length === 0) return null
        const open = candidates.find((c) => !this.checked.has(cellKey(c.cell)))
        if (open) return open
        this.checked.clear()
        return candidates[candidates.length - 1]
    }
}
