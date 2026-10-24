// Jev picks a tactic; this turns it into one mailbox command the console can execute alone.
import type { LogicApi, World } from "../load-logic.ts"
import type { Action } from "./jev.ts"
import { CMD } from "./mailbox.ts"
import type { Situation } from "./observe.ts"

export interface Decision {
    // What actually runs; differs from the pick when the pick is impossible right now.
    action: Action
    cmd: number
    a: number
    b: number
    label: string
}

const LABELS: Record<Action, string> = {
    advance: "ADVANCE",
    attack: "ATTACK",
    dodge_left: "DODGE L",
    dodge_right: "DODGE R",
    retreat: "RETREAT",
    heal: "HEAL",
    ammo: "AMMO",
    open: "OPEN",
    wait: "WAIT",
}

const WAIT_TICKS = 25

function make(action: Action, cmd: number, a = 0, b = 0): Decision {
    return { action, cmd, a, b, label: LABELS[action] }
}

function attackTarget(sit: Situation): number {
    if (sit.target >= 0) return sit.target
    const seen = sit.enemies.find((e) => e.sees)
    return (seen ?? sit.enemies[0])?.i ?? -1
}

function advance(api: LogicApi, world: World, sit: Situation): Decision {
    if (sit.next) return make("advance", CMD.goto, sit.next[0], sit.next[1])
    if (sit.goal === "boss") {
        const boss = world.enemies.findIndex((e) => !e.dead && e.kind === api.ENEMY_BOSS)
        if (boss >= 0) return make("attack", CMD.attack, boss)
    }
    if (sit.doorAhead === "closed") return make("open", CMD.use)
    return make("wait", CMD.wait, WAIT_TICKS)
}

export function decide(api: LogicApi, world: World, sit: Situation, pick: Action): Decision {
    switch (pick) {
        case "advance":
            return advance(api, world, sit)
        case "attack": {
            const i = attackTarget(sit)
            if (i < 0 || world.ammo < 1) return advance(api, world, sit)
            return make("attack", CMD.attack, i)
        }
        case "dodge_left":
            return make("dodge_left", CMD.strafe, 0)
        case "dodge_right":
            return make("dodge_right", CMD.strafe, 1)
        case "retreat":
            return sit.back ? make("retreat", CMD.goto, sit.back[0], sit.back[1]) : make("wait", CMD.wait, WAIT_TICKS)
        case "heal":
            return sit.medkit ? make("heal", CMD.goto, sit.medkit.next[0], sit.medkit.next[1]) : advance(api, world, sit)
        case "ammo":
            return sit.ammo ? make("ammo", CMD.goto, sit.ammo.next[0], sit.ammo.next[1]) : advance(api, world, sit)
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
