import fs from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { FakeImage, imageApi } from "./fake-image.ts"

export interface Enemy {
    kind: number
    [k: string]: any
    x: number
    y: number
    hp: number
    dead: boolean
    awake: boolean
    sees: boolean
    cool: number
    hurt: number
    attack: number
    walk: number
    hunting: boolean
    lastX: number
    lastY: number
}

export interface Item {
    [k: string]: any
    x: number
    y: number
    kind: number
    taken: boolean
}

export interface Input {
    fwd: number
    strafe: number
    turn: number
    fire: boolean
}

export interface World {
    [k: string]: any
    grid: number[]
    w: number
    h: number
    x: number
    y: number
    ang: number
    health: number
    ammo: number
    score: number
    kills: number
    total: number
    time: number
    fireCool: number
    stride: number
    turnHold: number
    won: boolean
    lost: boolean
    enemies: Enemy[]
    items: Item[]
    events: string[]
}

export interface Hit {
    dist: number
    side: number
    tile: number
    texX: number
    cellX: number
    cellY: number
}

export interface Proj {
    depth: number
    screenX: number
    size: number
    visible: boolean
}

export interface Pad {
    [k: string]: any
    aWas: boolean
    aLatch: boolean
    bWas: boolean
    bStart: number
    bStrafed: boolean
    tapA: boolean
    tapB: boolean
}

export interface LogicApi {
    [k: string]: any
    FP: number
    ANGLES: number
    VIEW_W: number
    VIEW_H: number
    TILE_FLOOR: number
    TILE_STONE: number
    TILE_BRICK: number
    TILE_EXIT: number
    ITEM_HEALTH: number
    ITEM_AMMO: number
    PLAYER_RADIUS: number
    IMP_DAMAGE: number
    IMP_HP: number
    START_AMMO: number
    AMMO_PICKUP: number
    HEALTH_PICKUP: number
    CAMPAIGN: string[]
    CAMX: number[]
    MAP_TAP_MS: number
    Input: new () => Input
    Pad: new () => Pad
    Hit: new () => Hit
    Proj: new () => Proj
    createWorld: (source: string[], ang: number) => World
    tileAt: (world: World, cx: number, cy: number) => number
    solidAt: (world: World, x: number, y: number) => boolean
    fits: (world: World, x: number, y: number, r: number) => boolean
    castRay: (world: World, rdx: number, rdy: number, hit: Hit) => void
    castColumn: (world: World, col: number, hit: Hit) => void
    wallHeight: (dist: number) => number
    shadeFor: (dist: number, side: number, tile: number) => number
    project: (world: World, sx: number, sy: number, out: Proj) => void
    canSee: (world: World, ax: number, ay: number, bx: number, by: number) => boolean
    distance: (ax: number, ay: number, bx: number, by: number) => number
    target: (world: World) => number
    update: (world: World, input: Input, dt: number) => void
    readPad: (pad: Pad, input: Input, now: number, up: boolean, down: boolean,
        left: boolean, right: boolean, a: boolean, b: boolean) => void
    heading: (ang: number) => string
    sin: (a: number) => number
    cos: (a: number) => number
}

export interface View {
    [k: string]: any
    mode: number
    mapOpen: boolean
    flash: number
    recoil: number
    hurt: number
    shake: number
    pickup: number
    face: number
    faceTime: number
    showFps: boolean
    fps: number
    frames: number
    acc: number
    colStep: number
    slowFor: number
}

export interface RenderApi {
    [k: string]: any
    MODE_TITLE: number
    MODE_PLAY: number
    View: new () => View
    init: () => void
    draw: (target: FakeImage, world: World, view: View) => void
    react: (view: View, events: string[]) => void
    SLOW_FPS: number
    SLOW_MS: number
    tick: (view: View, dt: number) => void
    adapt: (view: View, dt: number) => void
}

export interface ArtApi {
    PALETTE: number[]
}

export interface Game {
    corridor: LogicApi
    corridorArt: ArtApi
    corridorRender: RenderApi
}

const FILES = ["art.ts", "art-enemies.ts", "logic.ts", "doors.ts", "enemies.ts", "levels.ts", "procgen.ts", "game.ts", "ai.ts", "render.ts"]

// One transpile over all files, like the MakeCode compiler: namespace members declared in another
// file only get qualified (corridor.x) when TypeScript sees the merged namespace in the same unit.
function transpileAll(): string {
    const source = FILES.map((file) => fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).join("\n")
    return ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText
}

let compiled = ""

// Each call gets a fresh VM context, so module-level state in render.ts never leaks between tests.
export function loadGame(): Game {
    const math = Object.create(Math)
    math.idiv = (a: number, b: number) => (a / b) | 0
    const context: Record<string, unknown> = { Math: math, image: imageApi }
    vm.createContext(context)
    if (!compiled) compiled = transpileAll()
    vm.runInContext(compiled, context, { filename: "corridor.js" })
    vm.runInContext("this.__game = { corridor, corridorArt, corridorRender }", context)
    return context.__game as Game
}

export function loadLogic(): LogicApi {
    return loadGame().corridor
}
