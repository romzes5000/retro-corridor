// Run-level state above a single World: campaign progress, carried stock, title menu.
namespace corridor {
    export const RUN_CAMPAIGN = 0
    export const RUN_ENDLESS = 1

    export const MENU_CAMPAIGN = 0
    export const MENU_ENDLESS = 1
    export const MENU_DIFFICULTY = 2
    export const MENU_RECORDS = 3
    export const MENU_ITEMS = 4

    export const ACT_NONE = 0
    export const ACT_CAMPAIGN = 1
    export const ACT_ENDLESS = 2

    export const DIFF_EASY = 0
    export const DIFF_NORMAL = 1
    export const DIFF_HARD = 2
    export const DIFF_NAMES = ["EASY", "NORMAL", "HARD"]

    // Small deterministic PRNG (ZX81 LCG): products stay far below 2^31 on hardware and in Node.
    export function nextRand(seed: number): number {
        return (seed * 75 + 74) % 65537
    }

    export class Rng {
        seed: number
        constructor(seed: number) {
            this.seed = ((seed % 65537) + 65537) % 65537
        }
        next(n: number): number {
            this.seed = nextRand(this.seed)
            return n <= 1 ? 0 : this.seed % n
        }
    }

    export class Session {
        kind: number
        level: number
        difficulty: number
        health: number
        ammo: number
        entryHealth: number
        entryAmmo: number
        kills: number
        total: number
        time: number
        constructor(kind: number, difficulty: number) {
            this.kind = kind
            this.level = 0
            this.difficulty = difficulty
            this.health = 100
            this.ammo = START_AMMO
            this.entryHealth = 100
            this.entryAmmo = START_AMMO
            this.kills = 0
            this.total = 0
            this.time = 0
        }
    }

    export function levelCount(session: Session): number {
        return session.kind == RUN_CAMPAIGN ? LEVELS.length : 0
    }

    export function currentLevel(session: Session): Level {
        return LEVELS[session.level % LEVELS.length]
    }

    export function levelName(session: Session): string {
        if (session.kind == RUN_ENDLESS) return "DEPTH " + (session.level + 1)
        return currentLevel(session).name
    }

    // Builds the world for the session's current level with the stock the player entered it with.
    export function enterLevel(session: Session): World {
        const level = currentLevel(session)
        const world = createWorld(level.map, level.ang)
        world.health = session.entryHealth
        world.ammo = session.entryAmmo
        return world
    }

    export function startSession(kind: number, difficulty: number): Session {
        return new Session(kind, difficulty)
    }

    // Banks the finished level; true while there is another level to play.
    export function completeLevel(session: Session, world: World): boolean {
        session.kills += world.kills
        session.total += world.total
        session.time += world.time
        session.health = world.health
        session.ammo = world.ammo
        session.entryHealth = world.health
        session.entryAmmo = world.ammo
        session.level += 1
        return session.kind == RUN_ENDLESS || session.level < levelCount(session)
    }

    export class Menu {
        index: number
        difficulty: number
        records: boolean
        constructor() {
            this.index = MENU_CAMPAIGN
            this.difficulty = DIFF_NORMAL
            this.records = false
        }
    }

    export function menuStep(menu: Menu, pad: Pad): number {
        if (menu.records) {
            if (pad.tapA || pad.tapB) menu.records = false
            return ACT_NONE
        }
        if ((pad.tapDirs & DIR_UP) != 0) menu.index = (menu.index + MENU_ITEMS - 1) % MENU_ITEMS
        if ((pad.tapDirs & DIR_DOWN) != 0) menu.index = (menu.index + 1) % MENU_ITEMS
        if (menu.index == MENU_DIFFICULTY) {
            if ((pad.tapDirs & DIR_LEFT) != 0) menu.difficulty = (menu.difficulty + 2) % 3
            if ((pad.tapDirs & DIR_RIGHT) != 0 || pad.tapA) menu.difficulty = (menu.difficulty + 1) % 3
            return ACT_NONE
        }
        if (!pad.tapA) return ACT_NONE
        if (menu.index == MENU_CAMPAIGN) return ACT_CAMPAIGN
        if (menu.index == MENU_ENDLESS) return ACT_ENDLESS
        menu.records = true
        return ACT_NONE
    }
}
