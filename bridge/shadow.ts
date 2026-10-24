// Host copy of the level the console is playing. The map never travels over USB: the bridge
// rebuilds it from the same level code and checks the console's hash before trusting it.
import type { LogicApi, World } from "../load-logic.ts"
import type { Snapshot } from "./protocol.ts"
import type { Cell } from "./route.ts"

export interface Session {
    [k: string]: unknown
}

// Level id from the snapshot: campaign index ("0") or endless depth ("D3").
export function sessionFor(api: LogicApi, lvl: string, difficulty: number): Session | null {
    if (/^D\d+$/.test(lvl)) {
        const session = api.startSession(api.RUN_ENDLESS, difficulty)
        session.level = Number(lvl.slice(1)) - 1
        return session
    }
    if (!/^\d+$/.test(lvl)) return null
    const index = Number(lvl)
    if (index >= api.LEVELS.length) return null
    return api.startAtLevel(difficulty, index)
}

// The pause menu changes the difficulty mid-level, but the enemy set stays the one the level was
// entered with, so `d` in the snapshot can name a difficulty the map was not built for.
function buildLevel(api: LogicApi, snap: Snapshot): { world: World | null; problem: string } {
    const order = [snap.difficulty, ...[api.DIFF_EASY, api.DIFF_NORMAL, api.DIFF_HARD].filter((d) => d !== snap.difficulty)]
    let problem = ""
    for (const d of order) {
        const session = sessionFor(api, snap.lvl, d)
        if (!session) return { world: null, problem: `unknown level ${snap.lvl}` }
        const world = api.enterLevel(session)
        const hash = api.mapHash(world)
        if (hash === snap.hash) {
            world.difficulty = snap.difficulty
            return { world, problem: "" }
        }
        if (!problem) problem = `version mismatch: map hash ${hash} != console ${snap.hash} on level ${snap.lvl}`
    }
    return { world: null, problem }
}

export class Shadow {
    readonly api: LogicApi
    world: World | null = null
    // Enemy spawn cells of the current level, by enemy index.
    spawns: Cell[] = []
    // Why the last sync failed, empty when the world is trusted.
    problem = ""
    private key = ""

    constructor(api: LogicApi) {
        this.api = api
    }

    // Rebuilds on a new run, level or map, then copies the live state over the map.
    sync(snap: Snapshot): World | null {
        const key = `${snap.run}:${snap.lvl}:${snap.hash}`
        if (key !== this.key) {
            this.key = key
            const built = buildLevel(this.api, snap)
            this.world = built.world
            this.problem = built.problem
            this.spawns = built.world ? built.world.enemies.map((e): Cell => [e.x >> 10, e.y >> 10]) : []
        }
        const world = this.world
        if (!world) return null
        world.x = snap.x
        world.y = snap.y
        world.ang = snap.ang
        world.difficulty = snap.difficulty
        world.health = snap.hp
        world.ammo = snap.ammo
        world.weapon = snap.weapon
        if (snap.weapon === this.api.WEAPON_SHOTGUN) world.hasShotgun = true
        world.keys = snap.keys
        world.exitLocked = snap.locked
        for (const enemy of world.enemies) enemy.dead = true
        for (const e of snap.enemies) {
            const enemy = world.enemies[e.i]
            if (!enemy) continue
            enemy.dead = false
            enemy.x = e.x
            enemy.y = e.y
            enemy.hp = e.hp
            enemy.sees = e.sees
        }
        world.shots = snap.shots.map((s) => new this.api.Shot(s.x, s.y, s.vx, s.vy))
        snap.doors.forEach((state, i) => {
            if (world.doors[i]) world.doors[i].state = state
        })
        world.items.forEach((item, i) => {
            item.taken = snap.taken[i] ?? false
        })
        return world
    }
}
