// Host copy of the level the console is playing. The map never travels over USB: the bridge
// rebuilds it from the same level code and checks the console's hash before trusting it.
import type { LogicApi, World } from "../load-logic.ts"
import type { Snapshot } from "./protocol.ts"

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

export class Shadow {
    readonly api: LogicApi
    world: World | null = null
    // Why the last sync failed, empty when the world is trusted.
    problem = ""
    private key = ""

    constructor(api: LogicApi) {
        this.api = api
    }

    // Rebuilds on a new run, level or difficulty, then copies the live state over the map.
    sync(snap: Snapshot): World | null {
        const key = `${snap.run}:${snap.lvl}:${snap.difficulty}`
        if (key !== this.key) {
            this.key = key
            this.world = null
            const session = sessionFor(this.api, snap.lvl, snap.difficulty)
            if (!session) {
                this.problem = `unknown level ${snap.lvl}`
                return null
            }
            const world = this.api.enterLevel(session)
            const hash = this.api.mapHash(world)
            if (hash !== snap.hash) {
                this.problem = `version mismatch: map hash ${hash} != console ${snap.hash} on level ${snap.lvl}`
                return null
            }
            this.problem = ""
            this.world = world
        }
        const world = this.world
        if (!world) return null
        world.x = snap.x
        world.y = snap.y
        world.ang = snap.ang
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
