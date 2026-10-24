// Control situations for Jev: a small map, a tweak of the live state, and which picks count as
// right. Used offline by the tests (fake picks) and against the real model by `npm run ai:eval`.
import type { LogicApi, World } from "../load-logic.ts"
import type { Action } from "./jev.ts"
import { activeLesson, lessonText, type ActiveLesson, type Lesson } from "./lessons.ts"
import { Memory } from "./memory.ts"
import { facts, situate, type Situation } from "./observe.ts"

export interface Scenario {
    name: string
    map: string[]
    ang: number
    setup?: (api: LogicApi, world: World) => void
    // A death lesson kept from before; in force when its conditions hold here.
    lesson?: Lesson
    // A pick is right when it is in `allowed` (if given) and not in `forbidden`.
    allowed?: Action[]
    forbidden?: Action[]
}

const EAST = 0
const SIDE_ROOM = ["#########", "#S.....X#", "#.#######", "#.#######", "#?#######", "#########"]
const sideRoom = (item: string) => SIDE_ROOM.map((row) => row.replace("?", item))

export const SCENARIOS: Scenario[] = [
    {
        name: "low hp, medkit 3 steps off the route",
        map: sideRoom("H"),
        ang: EAST,
        setup: (_api, w) => { w.health = 25 },
        allowed: ["heal"],
    },
    {
        name: "full hp, medkit 3 steps off the route",
        map: sideRoom("H"),
        ang: EAST,
        forbidden: ["heal"],
    },
    {
        name: "pistol, shotgun 3 steps off the route",
        map: sideRoom("G"),
        ang: EAST,
        allowed: ["weapon" as Action],
    },
    {
        name: "imp in bite range, low hp",
        map: ["##########", "#S.....X.#", "##########"],
        ang: EAST,
        setup: (api, w) => {
            w.health = 20
            w.enemies.push(new api.Enemy(api.ENEMY_IMP, w.x + 800, w.y))
            Object.assign(w.enemies[0], { awake: true, sees: true, hunting: true })
        },
        forbidden: ["advance", "wait", "heal", "ammo"],
    },
    {
        name: "fireball ahead, safe side left",
        map: ["#########", "#.......#", "#..S....#", "#.......#", "#######X#"],
        ang: EAST,
        setup: (api, w) => { w.shots.push(new api.Shot(w.x + 1000, w.y + 150, -2000, 0)) },
        allowed: ["dodge_left"],
    },
    {
        name: "closed door right ahead",
        map: ["#########", "#S|....X#", "#########"],
        ang: EAST,
        allowed: ["open", "advance"],
    },
    {
        name: "empty corridor to the exit",
        map: ["##########", "#S......X#", "##########"],
        ang: EAST,
        allowed: ["advance"],
    },
    {
        // The D3 loop from the console log: hurt, route behind, nothing in sight, imp asleep behind a wall.
        name: "hurt, route behind, imp asleep behind a wall",
        map: ["##########", "#X.....S.#", "##########", "#.....E..#", "##########"],
        ang: EAST,
        setup: (_api, w) => { w.health = 27 },
        forbidden: ["retreat", "wait"],
    },
    {
        name: "imp behind a wall, route ahead",
        map: ["##########", "#S......X#", "##########", "#...E....#", "##########"],
        ang: EAST,
        forbidden: ["attack", "retreat", "dodge_left", "dodge_right"],
    },
    {
        // Without the lesson Jev shoots it out with the knight (0 of 12 retreats in probe --lessons).
        name: "knight closing in at half health, lesson says retreat",
        map: ["############", "#S........X#", "############"],
        ang: EAST,
        setup: (api, w) => {
            w.health = 50
            w.enemies.push(new api.Enemy(api.ENEMY_KNIGHT, w.x + 2600, w.y))
            Object.assign(w.enemies[0], { awake: true, sees: true, hunting: true })
        },
        lesson: {
            id: "E1", key: "global", scope: "global", zone: null, when: ["biter_near", "health_below_60"], do: "retreat",
            why: "knight bit to death from 50 HP", deaths: 1, wins: 0, failed: 0, at: 0, source: "rule",
        },
        allowed: ["retreat"],
    },
]

export function scenarioWorld(api: LogicApi, sc: Scenario): World {
    const world = api.createWorld(sc.map, sc.ang)
    sc.setup?.(api, world)
    return world
}

// The player knows only what it has seen: in a scenario it has turned around once where it stands.
function scenarioSituation(api: LogicApi, world: World): Situation {
    const memory = new Memory()
    memory.lookAround("eval", api, world, 0)
    return situate(api, world, memory)
}

export function scenarioLesson(api: LogicApi, sc: Scenario): ActiveLesson | null {
    if (!sc.lesson) return null
    const world = scenarioWorld(api, sc)
    return activeLesson(api, world, scenarioSituation(api, world), [sc.lesson], "eval")
}

// The facts Jev gets for the scenario, the same way the bridge builds them.
export function scenarioState(api: LogicApi, sc: Scenario): Record<string, unknown> {
    const world = scenarioWorld(api, sc)
    const lesson = scenarioLesson(api, sc)
    return facts(api, world, scenarioSituation(api, world), [], "new goal", { lesson: lesson ? lessonText(lesson) : undefined })
}

export function judge(sc: Scenario, pick: string): boolean {
    if (sc.allowed && !(sc.allowed as string[]).includes(pick)) return false
    return !(sc.forbidden ?? []).includes(pick as Action)
}
