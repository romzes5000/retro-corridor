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

    export class Session {
        kind: number
        level: number
        difficulty: number
        health: number
        ammo: number
        entryHealth: number
        entryAmmo: number
        entryShotgun: boolean
        entryWeapon: number
        kills: number
        total: number
        time: number
        score: number
        constructor(kind: number, difficulty: number) {
            this.score = 0
            this.kind = kind
            this.level = 0
            this.difficulty = difficulty
            this.health = 100
            this.ammo = START_AMMO
            this.entryHealth = 100
            this.entryAmmo = START_AMMO
            this.entryShotgun = false
            this.entryWeapon = WEAPON_PISTOL
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

    // Builds the world for the session's current level with the stock (health, ammo, weapons) the
    // player entered it with.
    export function enterLevel(session: Session): World {
        const level = currentLevel(session)
        const world = createWorld(level.map, level.ang)
        setLights(world, level.lights)
        applyDifficulty(world, session.difficulty)
        world.health = session.entryHealth
        world.ammo = session.entryAmmo
        world.hasShotgun = session.entryShotgun
        world.weapon = session.entryWeapon
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
        session.score += world.score
        session.health = world.health
        session.ammo = world.ammo
        session.entryHealth = world.health
        session.entryAmmo = world.ammo
        session.entryShotgun = world.hasShotgun
        session.entryWeapon = world.weapon
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

    function freeCell(world: World, cx: number, cy: number, sx: number, sy: number): boolean {
        if (tileAt(world, cx, cy) != TILE_FLOOR) return false
        if (Math.abs(cx - sx) < 3 && Math.abs(cy - sy) < 3) return false
        for (const e of world.enemies) {
            if (e.x >> 10 == cx && e.y >> 10 == cy) return false
        }
        for (const it of world.items) {
            if (it.x >> 10 == cx && it.y >> 10 == cy) return false
        }
        return true
    }

    // Easy drops every third regular enemy; hard adds an imp next to every second one. The boss
    // and the start area (3 cells) are never touched. Damage scaling lives in hurtPlayer.
    export function applyDifficulty(world: World, difficulty: number): void {
        world.difficulty = difficulty
        if (difficulty == DIFF_NORMAL) return
        const sx = world.x >> 10
        const sy = world.y >> 10
        const kept: Enemy[] = []
        const extra: Enemy[] = []
        const n = world.enemies.length
        for (let i = 0; i < n; i++) {
            const e = world.enemies[i]
            if (e.kind == ENEMY_BOSS) {
                kept.push(e)
                continue
            }
            if (difficulty == DIFF_EASY) {
                if (i % 3 != 2) kept.push(e)
                continue
            }
            kept.push(e)
            if (i % 2 != 0) continue
            const ex = e.x >> 10
            const ey = e.y >> 10
            const dirs = [1, 0, -1, 0, 0, 1, 0, -1]
            for (let k = 0; k < 8; k += 2) {
                const cx = ex + dirs[k]
                const cy = ey + dirs[k + 1]
                if (!freeCell(world, cx, cy, sx, sy)) continue
                const imp = new Enemy(ENEMY_IMP, cx * FP + (FP >> 1), cy * FP + (FP >> 1))
                extra.push(imp)
                world.enemies.push(imp)
                break
            }
        }
        world.enemies = kept.concat(extra)
        world.total = world.enemies.length
    }

    export const PAUSE_RESUME = 0
    export const PAUSE_MUSIC = 1
    export const PAUSE_DIFFICULTY = 2
    export const PAUSE_QUIT = 3
    export const PAUSE_ITEMS = 4

    export const PACT_NONE = 0
    export const PACT_RESUME = 1
    export const PACT_QUIT = 2

    export class Pause {
        index: number
        music: boolean
        difficulty: number
        constructor(music: boolean, difficulty: number) {
            this.index = PAUSE_RESUME
            this.music = music
            this.difficulty = difficulty
        }
    }

    // B or A on RESUME closes the pause; A on QUIT leaves to the title; music and difficulty toggle in place.
    export function pauseStep(pause: Pause, pad: Pad): number {
        if (pad.tapB || pad.longB) return PACT_RESUME
        if ((pad.tapDirs & DIR_UP) != 0) pause.index = (pause.index + PAUSE_ITEMS - 1) % PAUSE_ITEMS
        if ((pad.tapDirs & DIR_DOWN) != 0) pause.index = (pause.index + 1) % PAUSE_ITEMS
        const left = (pad.tapDirs & DIR_LEFT) != 0
        const right = (pad.tapDirs & DIR_RIGHT) != 0
        if (pause.index == PAUSE_MUSIC && (left || right || pad.tapA)) pause.music = !pause.music
        if (pause.index == PAUSE_DIFFICULTY) {
            if (left) pause.difficulty = (pause.difficulty + 2) % 3
            if (right || pad.tapA) pause.difficulty = (pause.difficulty + 1) % 3
        }
        if (!pad.tapA) return PACT_NONE
        if (pause.index == PAUSE_RESUME) return PACT_RESUME
        if (pause.index == PAUSE_QUIT) return PACT_QUIT
        return PACT_NONE
    }

    // Persistent records, stored by main.ts through settings.writeNumber/readNumber.
    export const RECORD_TIME_KEYS = ["rc_time_easy", "rc_time_normal", "rc_time_hard"]
    export const RECORD_DEPTH_KEY = "rc_depth"
    export const RECORD_SCORE_KEY = "rc_score"

    export class Records {
        time: number[]
        depth: number
        score: number
        constructor() {
            this.time = [0, 0, 0]
            this.depth = 0
            this.score = 0
        }
    }

    export function loadRecords(read: (key: string) => number): Records {
        const rec = new Records()
        for (let i = 0; i < 3; i++) rec.time[i] = read(RECORD_TIME_KEYS[i])
        rec.depth = read(RECORD_DEPTH_KEY)
        rec.score = read(RECORD_SCORE_KEY)
        return rec
    }

    export function saveRecords(rec: Records, write: (key: string, value: number) => void): void {
        for (let i = 0; i < 3; i++) write(RECORD_TIME_KEYS[i], rec.time[i])
        write(RECORD_DEPTH_KEY, rec.depth)
        write(RECORD_SCORE_KEY, rec.score)
    }

    // Folds a finished campaign or an endless run into the records; true if anything improved.
    export function noteRun(rec: Records, session: Session): boolean {
        let better = false
        if (session.score > rec.score) {
            rec.score = session.score
            better = true
        }
        if (session.kind == RUN_ENDLESS) {
            if (session.level > rec.depth) {
                rec.depth = session.level
                better = true
            }
        } else if (session.level >= LEVELS.length) {
            const best = rec.time[session.difficulty]
            if (best == 0 || session.time < best) {
                rec.time[session.difficulty] = session.time
                better = true
            }
        }
        return better
    }

    export function clock(ms: number): string {
        const sec = Math.idiv(ms, 1000)
        const rest = sec % 60
        return Math.idiv(sec, 60) + ":" + (rest < 10 ? "0" : "") + rest
    }

    export function recordLines(rec: Records): string[] {
        const out: string[] = []
        for (let i = 0; i < 3; i++) out.push(DIFF_NAMES[i] + " " + (rec.time[i] > 0 ? clock(rec.time[i]) : "-"))
        out.push("DEPTH " + rec.depth)
        out.push("SCORE " + rec.score)
        return out
    }
}
