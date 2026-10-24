// Builds the demo GIFs by playing scripted runs through the real logic.ts + render.ts.
// Run: npm run demo  ->  demo/out/*.gif
import fs from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { FakeImage } from "../fake-image.ts"
import { loadGame, type Game, type Input, type View, type World } from "../load-logic.ts"
import { Frame, encodeGif, paste, rgbList } from "./frames.ts"
import { DEFAULT_PALETTE, drawLegacy, legacyWorld, type LegacyWorld } from "./legacy.ts"
import { Pilot, fightingPilot, type Cell } from "./pilot.ts"

export const DT = 40
const FP = 1024

export const LEGACY_CAMPAIGN = [
    "#########",
    "#S......#",
    "#.#####.#",
    "#.#E..#.#",
    "#.#.#.#.#",
    "#...#..E#",
    "#.###.###",
    "#.....E.#",
    "#####X###",
]

interface Run {
    world: World
    drive: (dt: number) => Input
    done: () => boolean
    mapOpen?: () => boolean
}

export interface Scenario {
    name: string
    legacy?: string[]
    maxMs: number
    tailMs: number
    build: (game: Game) => Run
}

function calm(map: string[]): string[] {
    return map.map((row) => row.replace(/E/g, "."))
}

function placeAt(world: World, cell: Cell, ang: number): void {
    world.x = cell[0] * FP + FP / 2
    world.y = cell[1] * FP + FP / 2
    world.ang = ang
}

function scripted(game: Game, world: World, pilot: Pilot): Run {
    return {
        world,
        drive: (dt) => pilot.next(world, dt),
        done: () => pilot.done,
        mapOpen: () => pilot.mapOpen,
    }
}

export const SCENARIOS: Scenario[] = [
    {
        name: "01-before-after",
        legacy: LEGACY_CAMPAIGN,
        maxMs: 14000,
        tailMs: 1600,
        build: (game) => {
            const world = game.corridor.createWorld(LEGACY_CAMPAIGN, 0)
            const drive = fightingPilot(game.corridor, world, [5, 7], 256)
            return { world, drive, done: () => world.won || world.lost }
        },
    },
    {
        name: "02-turn-corner",
        maxMs: 9000,
        tailMs: 500,
        build: (game) => {
            const world = game.corridor.createWorld(calm(game.corridor.CAMPAIGN), 0)
            placeAt(world, [5, 1], 0)
            world.health = 80
            const pilot = new Pilot(game.corridor, [{ kind: "wait", ms: 300 }])
            pilot.route(world, [14, 7])
            pilot.tasks.push({ kind: "face", ang: 512 }, { kind: "wait", ms: 400 })
            return scripted(game, world, pilot)
        },
    },
    {
        name: "03-imp-fight",
        maxMs: 9000,
        tailMs: 900,
        build: (game) => {
            const api = game.corridor
            const world = api.createWorld([
                "##########",
                "#........#",
                "#........#",
                "#S...#...#",
                "#....B.E.#",
                "#........#",
                "##########",
            ], 0)
            const walker = new Pilot(api, [
                { kind: "wait", ms: 500 },
                { kind: "goto", cell: [4, 1] },
                { kind: "face", ang: 110 },
                { kind: "wait", ms: 3000 },
            ])
            let fighter: Pilot | null = null
            let spotted = -1
            let elapsed = 0
            const drive = (dt: number): Input => {
                elapsed += dt
                const imp = world.imps[0]
                if (spotted < 0 && imp.sees) spotted = elapsed
                const bitten = world.health < 100
                if (!fighter && spotted >= 0 && (bitten || elapsed - spotted > 6000) && !imp.dead) {
                    fighter = new Pilot(api, [{ kind: "fire", imp: 0, ms: 4000 }, { kind: "wait", ms: 500 }])
                }
                if (fighter && !fighter.done) return fighter.next(world, dt)
                return walker.next(world, dt)
            }
            return { world, drive, done: () => world.imps[0].dead && walker.done && (fighter?.done ?? false) }
        },
    },
    {
        name: "04-map-toggle",
        maxMs: 9000,
        tailMs: 700,
        build: (game) => {
            const world = game.corridor.createWorld(game.corridor.CAMPAIGN, 0)
            const pilot = new Pilot(game.corridor, [
                { kind: "wait", ms: 500 },
                { kind: "map", open: true },
                { kind: "wait", ms: 700 },
            ])
            pilot.route(world, [2, 5])
            pilot.tasks.push(
                { kind: "wait", ms: 500 },
                { kind: "map", open: false },
                { kind: "faceCell", cell: [4, 5] },
                { kind: "wait", ms: 400 },
            )
            return scripted(game, world, pilot)
        },
    },
    {
        name: "05-exit-door",
        maxMs: 9000,
        tailMs: 1800,
        build: (game) => {
            const world = game.corridor.createWorld(calm(game.corridor.CAMPAIGN), 0)
            placeAt(world, [3, 14], 0)
            world.health = 70
            const pilot = new Pilot(game.corridor, [
                { kind: "wait", ms: 400 },
                { kind: "goto", cell: [14, 14] },
                { kind: "face", ang: 0 },
                { kind: "push", ms: 2000 },
            ])
            return { ...scripted(game, world, pilot), done: () => world.won }
        },
    },
]

function label(game: Game, img: FakeImage, s: string, c: number): void {
    const r = game.corridorRender
    const x = img.width - r.textWidth(s, 1) - 4
    r.text(img as never, s, x + 1, 5, 15, 1)
    r.text(img as never, s, x, 4, c, 1)
}

const LEGACY_DIR: Record<string, number> = { N: 0, E: 1, S: 2, W: 3 }

function syncLegacy(game: Game, lw: LegacyWorld, world: World, startImps: Array<[number, number]>): void {
    lw.x = world.x >> 10
    lw.y = world.y >> 10
    lw.dir = LEGACY_DIR[game.corridor.heading(world.ang)]
    lw.imps = startImps.filter((_, i) => !world.imps[i].dead).map(([x, y]) => ({ x, y }))
    lw.lives = Math.max(0, Math.ceil(world.health / 34))
}

export interface Recording {
    frames: Frame[]
    palette: number[][]
    world: World
}

export function record(scenario: Scenario, game: Game = loadGame()): Recording {
    const c = game.corridor
    const r = game.corridorRender
    const run = scenario.build(game)
    const view: View = new r.View()
    view.mode = r.MODE_PLAY
    const startImps = run.world.imps.map((imp): [number, number] => [imp.x >> 10, imp.y >> 10])
    const lw = scenario.legacy ? legacyWorld(scenario.legacy, 1) : null
    const frames: Frame[] = []
    const img = new FakeImage(160, 120)
    const old = new FakeImage(160, 120)
    let endAt = -1
    for (let t = 0; t < scenario.maxMs; t += DT) {
        const input = run.drive(DT)
        c.update(run.world, input, DT)
        r.react(view, run.world.events)
        r.tick(view, DT)
        view.mapOpen = run.mapOpen ? run.mapOpen() : false
        r.draw(img as never, run.world, view)
        if (lw) {
            syncLegacy(game, lw, run.world, startImps)
            drawLegacy(old, lw)
            label(game, old, "BEFORE", 5)
            label(game, img, "AFTER", 4)
            const frame = new Frame(640, 240)
            paste(frame, old, 0, 0, 2, 16)
            paste(frame, img, 320, 0, 2)
            frames.push(frame)
        } else {
            const frame = new Frame(320, 240)
            paste(frame, img, 0, 0, 2)
            frames.push(frame)
        }
        if (endAt < 0 && run.done()) endAt = t + scenario.tailMs
        if (endAt >= 0 && t >= endAt) break
    }
    const palette = rgbList(game.corridorArt.PALETTE)
    if (lw) palette.push(...rgbList(DEFAULT_PALETTE))
    return { frames, palette, world: run.world }
}

export function frameHash(frame: Frame): string {
    return createHash("sha256").update(frame.pixels).digest("hex")
}

function main(): void {
    const out = new URL("./out/", import.meta.url)
    fs.mkdirSync(out, { recursive: true })
    const only = process.argv[2]
    for (const scenario of SCENARIOS) {
        if (only && !scenario.name.startsWith(only)) continue
        const rec = record(scenario)
        const bytes = encodeGif(rec.frames, rec.palette, DT)
        const file = new URL(`${scenario.name}.gif`, out)
        fs.writeFileSync(file, bytes)
        const w = rec.world
        console.log(`${scenario.name}.gif  ${rec.frames.length} кадров  ${(bytes.length / 1024).toFixed(0)} КБ  `
            + `won=${w.won} lost=${w.lost} hp=${w.health} kills=${w.kills}/${w.total}`)
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
