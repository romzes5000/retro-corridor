// Top-down map for the live page: the level once per attempt, then a few times a second the player,
// the route the bridge follows and what the player knows. Enemies show only when in sight now or
// seen in the last MEMORY_MS, the same rule the bridge plays by; the map itself is known.
import type { LogicApi, World } from "../load-logic.ts"
import type { LivePlayer } from "./live.ts"
import { inSight, MEMORY_MS, type Memory } from "./memory.ts"
import { ENEMY_NAMES, type GoalKind, type Situation } from "./observe.ts"
import type { Snapshot } from "./protocol.ts"
import { KEY_ITEMS, type Cell } from "./route.ts"

export const OVERLAY_MS = 250

const KEY_COLOURS: Record<number, string> = { 1: "red", 2: "blue" }

// What the bridge is heading for, from the situation of its latest decision.
export interface Route {
    // `run:lvl:hash` of the snapshot it was planned on.
    key: string
    goal: GoalKind
    goalCell: Cell | null
    // "red key", "exit", "boss", "boss, last seen", "boss spawn", "none".
    what: string
    // Grid path from the player's cell to the goal.
    path: Cell[]
    // Out of sight now, seen in the last MEMORY_MS: where (cells) and when (console ms).
    remembered: Array<{ i: number; kind: string; x: number; y: number; at: number }>
}

export interface LevelMap {
    // Attempt number in the live player; a new one means a new map.
    seg: number
    level: string | null
    w: number
    h: number
    // One char per cell: # wall, . floor, ~ lava, E exit, D door.
    rows: string[]
    doors: Array<{ x: number; y: number; key: "plain" | "red" | "blue"; vertical: boolean }>
    items: Array<{ x: number; y: number; kind: string }>
}

export type DoorView = "open" | "closed" | "locked" | "moving"

export interface MapEnemy {
    i: number
    kind: string
    x: number
    y: number
}

export interface MapOverlay {
    seg: number
    player: { x: number; y: number; dir: [number, number] }
    exitLocked: boolean
    doors: DoorView[]
    taken: boolean[]
    enemies: MapEnemy[]
    remembered: Array<MapEnemy & { ago: number }>
    shots: Array<{ x: number; y: number }>
    goal: { kind: GoalKind; cell: Cell | null; what: string } | null
    // Route cells from the player's cell on.
    path: Cell[]
}

const round2 = (v: number) => Math.round(v * 100) / 100
const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]
const cellOf = (x: number, y: number): Cell => [x >> 10, y >> 10]

export function itemName(api: LogicApi, kind: number): string {
    if (kind === api.ITEM_HEALTH) return "medkit"
    if (kind === api.ITEM_AMMO) return "ammo"
    if (kind === api.ITEM_SHOTGUN) return "shotgun"
    const colour = KEY_COLOURS[KEY_ITEMS[kind]]
    return colour ? `${colour} key` : "item"
}

const BOSS_SOURCES: Record<string, string> = { seen: "boss, last seen", spawn: "boss spawn", earlier: "boss, seen before" }

// Goal kinds and boss sources are compared as strings: observe.ts grows new ones over time.
function goalWhat(api: LogicApi, world: World, sit: Situation): string {
    const goal: string = sit.goal
    if (goal === "exit") return "exit"
    if (goal === "explore") return "unexplored area"
    if (goal === "boss") return sit.bossSeen ? "boss" : BOSS_SOURCES[sit.bossSource] ?? "boss"
    if (goal === "key") {
        const item = world.items.find((it) => !it.taken && sit.goalCell && same(cellOf(it.x, it.y), sit.goalCell))
        return item ? itemName(api, item.kind) : "key"
    }
    return "none"
}

export function routeOf(api: LogicApi, world: World, sit: Situation, memory: Memory, key: string): Route {
    return {
        key,
        goal: sit.goal,
        goalCell: sit.goalCell,
        what: goalWhat(api, world, sit),
        path: sit.path,
        remembered: sit.remembered.flatMap((r) => {
            const s = memory.last.get(r.i)
            return s ? [{ i: r.i, kind: r.kind, x: round2(s.x / api.FP), y: round2(s.y / api.FP), at: s.at }] : []
        }),
    }
}

export function levelMap(api: LogicApi, world: World, seg: number, level: string | null): LevelMap {
    const rows: string[] = []
    for (let cy = 0; cy < world.h; cy++) {
        let row = ""
        for (let cx = 0; cx < world.w; cx++) {
            const tile = api.tileAt(world, cx, cy)
            if (api.isDoor(tile)) row += "D"
            else if (tile === api.TILE_EXIT) row += "E"
            else if (tile === api.TILE_FLOOR) row += api.lavaAt(world, cx, cy) ? "~" : "."
            else row += "#"
        }
        rows.push(row)
    }
    return {
        seg,
        level,
        w: world.w,
        h: world.h,
        rows,
        doors: Array.from(world.doors as any[], (d) => ({ x: d.cx, y: d.cy, key: (KEY_COLOURS[d.key] ?? "plain") as LevelMap["doors"][number]["key"], vertical: !!d.vertical })),
        items: Array.from(world.items, (it) => ({ x: it.x >> 10, y: it.y >> 10, kind: itemName(api, it.kind) })),
    }
}

function doorView(api: LogicApi, world: World, door: any): DoorView {
    if (door.state === api.DOOR_OPEN) return "open"
    if (door.state !== api.DOOR_CLOSED) return "moving"
    return door.key !== 0 && (world.keys & door.key) === 0 ? "locked" : "closed"
}

// `route` is used only when it was planned on this map; `snap` is the latest snapshot, its clock
// ages the remembered enemies.
export function mapOverlay(api: LogicApi, world: World, seg: number, snap: Snapshot, route: Route | null): MapOverlay {
    const key = `${snap.run}:${snap.lvl}:${snap.hash}`
    const r = route && route.key === key ? route : null
    const at = cellOf(world.x, world.y)
    const enemies = Array.from(world.enemies, (e, i) => ({ e, i }))
        .filter(({ e }) => !e.dead && inSight(api, world, e.x, e.y))
        .map(({ e, i }) => ({ i, kind: ENEMY_NAMES[e.kind] ?? "enemy", x: round2(e.x / api.FP), y: round2(e.y / api.FP) }))
    const seen = new Set(enemies.map((e) => e.i))
    const remembered = (r?.remembered ?? [])
        .filter((m) => !seen.has(m.i) && world.enemies[m.i] && !world.enemies[m.i].dead && snap.t - m.at <= MEMORY_MS)
        .map((m) => ({ i: m.i, kind: m.kind, x: m.x, y: m.y, ago: Math.round((snap.t - Math.min(m.at, snap.t)) / 100) / 10 }))
    const path = r?.path ?? []
    const from = path.findIndex((c) => same(c, at))
    return {
        seg,
        player: { x: round2(world.x / api.FP), y: round2(world.y / api.FP), dir: [round2(api.cos(world.ang) / 1024), round2(api.sin(world.ang) / 1024)] },
        exitLocked: !!world.exitLocked,
        doors: Array.from(world.doors as any[], (d) => doorView(api, world, d)),
        taken: Array.from(world.items, (it) => it.taken),
        enemies,
        remembered,
        shots: Array.from(world.shots as any[]).filter((s) => inSight(api, world, s.x, s.y)).map((s) => ({ x: round2(s.x / api.FP), y: round2(s.y / api.FP) })),
        goal: r ? { kind: r.goal, cell: r.goalCell, what: r.what } : null,
        path: from > 0 ? path.slice(from) : path,
    }
}

// The map of the attempt the live player is on, and the overlay on its world as last drawn.
export class LiveMap {
    route: () => Route | null = () => null
    private readonly api: LogicApi
    private readonly player: LivePlayer
    private cached: LevelMap | null = null

    constructor(api: LogicApi, player: LivePlayer) {
        this.api = api
        this.player = player
    }

    map(): LevelMap | null {
        const world = this.player.world
        if (!world) return null
        if (this.cached?.seg !== this.player.segment) this.cached = levelMap(this.api, world, this.player.segment, this.levelName())
        return this.cached
    }

    overlay(): MapOverlay | null {
        const world = this.player.world
        const snap = this.player.latest
        if (!world || !snap) return null
        return mapOverlay(this.api, world, this.player.segment, snap, this.route())
    }

    private levelName(): string | null {
        const lvl = this.player.latest?.lvl ?? null
        if (lvl === null) return null
        return /^\d+$/.test(lvl) ? (this.api.LEVELS[Number(lvl)]?.name ?? lvl) : lvl
    }
}

export const MAP_STYLE = `
  #map-panel { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; }
  #map { flex: none; max-width: 100%; height: auto; background: #000; }
  #map-info { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 8px; }
  #map-goal div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #map-legend { display: flex; flex-direction: column; gap: 2px; color: #888; }
  #map-legend i { display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: -1px; }
`

export const MAP_PANEL = `<div id="map-panel">
  <canvas id="map" width="480" height="480"></canvas>
  <div id="map-info">
  <h2>Map and route</h2>
  <div id="map-goal">waiting for a level...</div>
  <h2>Legend</h2>
  <div id="map-legend">
    <span><i style="background:#5f5;border-radius:50%"></i>player</span>
    <span><i style="background:#f33;border-radius:50%"></i>enemy in sight</span>
    <span><i style="border:1px dashed #f93;border-radius:50%;width:7px;height:7px"></i>seen lately</span>
    <span><i style="background:#fa0;border-radius:50%;width:5px;height:5px"></i>fireball</span>
    <span><i style="background:#0df"></i>path</span>
    <span><i style="border:2px solid #f5d;width:5px;height:5px"></i>goal</span>
    <span><i style="background:#b8905a"></i>door</span>
    <span><i style="background:#e44"></i><i style="background:#48f"></i>keyed door, key</span>
    <span><i style="background:#a83010"></i>lava</span>
    <span><i style="background:#1f8a35"></i>exit</span>
    <span><i style="background:#eee"></i>medkit</span>
    <span><i style="background:#e8c840"></i>ammo</span>
    <span><i style="background:#c87830"></i>shotgun</span>
  </div>
  </div>
</div>`

// Client side; `stream` is the page's EventSource. No backticks or dollar-braces: it is pasted
// into the page template.
export const MAP_SCRIPT = `
  function mapView(stream) {
    const canvas = document.getElementById("map")
    const ctx = canvas.getContext("2d")
    const goalEl = document.getElementById("map-goal")
    const TILE = { "#": "#4a4a55", ".": "#16161c", "~": "#a83010", "E": "#1f8a35", "D": "#16161c" }
    const KEY = { plain: "#b8905a", red: "#e44", blue: "#48f" }
    const ITEM = { medkit: "#eee", ammo: "#e8c840", shotgun: "#c87830", "red key": "#e44", "blue key": "#48f" }
    const LETTER = { imp: "I", shooter: "S", knight: "K", boss: "B" }
    let map = null
    let base = null
    let last = null
    let exits = []
    let cell = 16
    const c = (v) => v * cell
    const mid = (v) => v * cell + cell / 2
    const dot = (x, y, r, fill, stroke) => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      if (fill) { ctx.fillStyle = fill; ctx.fill() }
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke() }
    }
    stream.addEventListener("map", (e) => {
      map = JSON.parse(e.data)
      cell = Math.max(6, Math.min(30, Math.floor(480 / Math.max(map.w, map.h))))
      canvas.width = map.w * cell
      canvas.height = map.h * cell
      base = document.createElement("canvas")
      base.width = canvas.width
      base.height = canvas.height
      const b = base.getContext("2d")
      exits = []
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          const ch = map.rows[y][x]
          if (ch === "E") exits.push([x, y])
          b.fillStyle = TILE[ch] || TILE["#"]
          b.fillRect(c(x), c(y), cell, cell)
          if (ch !== "#") { b.strokeStyle = "rgba(255,255,255,0.05)"; b.strokeRect(c(x) + 0.5, c(y) + 0.5, cell - 1, cell - 1) }
        }
      }
      ctx.drawImage(base, 0, 0)
      goalEl.textContent = (map.level || "level") + ": waiting for the route"
      if (last && last.seg === map.seg) draw(last)
    })
    stream.addEventListener("overlay", (e) => {
      last = JSON.parse(e.data)
      if (map && last.seg === map.seg) draw(last)
    })
    function door(d, state) {
      const thick = Math.max(3, cell * 0.3)
      const len = state === "moving" ? cell / 2 : cell
      const x = d.vertical ? mid(d.x) - thick / 2 : c(d.x)
      const y = d.vertical ? c(d.y) : mid(d.y) - thick / 2
      const w = d.vertical ? thick : len
      const h = d.vertical ? len : thick
      ctx.lineWidth = 2
      if (state === "open") {
        ctx.strokeStyle = KEY[d.key]
        ctx.globalAlpha = 0.6
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
        ctx.globalAlpha = 1
        return
      }
      ctx.fillStyle = KEY[d.key]
      ctx.fillRect(x, y, w, h)
      if (state === "locked") {
        ctx.beginPath()
        ctx.moveTo(c(d.x) + 3, c(d.y) + 3); ctx.lineTo(c(d.x + 1) - 3, c(d.y + 1) - 3)
        ctx.moveTo(c(d.x + 1) - 3, c(d.y) + 3); ctx.lineTo(c(d.x) + 3, c(d.y + 1) - 3)
        ctx.strokeStyle = KEY[d.key]
        ctx.stroke()
      }
    }
    function item(it) {
      const x = mid(it.x)
      const y = mid(it.y)
      const s = cell * 0.5
      ctx.fillStyle = ITEM[it.kind] || "#ccc"
      if (it.kind === "medkit") {
        ctx.fillRect(x - s / 2, y - s / 2, s, s)
        ctx.fillStyle = "#d22"
        ctx.fillRect(x - s / 2 + s * 0.4, y - s / 2 + 2, s * 0.2, s - 4)
        ctx.fillRect(x - s / 2 + 2, y - s / 2 + s * 0.4, s - 4, s * 0.2)
      } else if (it.kind === "ammo") {
        ctx.fillRect(x - s * 0.35, y - s * 0.3, s * 0.7, s * 0.6)
      } else if (it.kind === "shotgun") {
        ctx.fillRect(x - s * 0.7, y - s * 0.15, s * 1.4, s * 0.3)
      } else {
        ctx.beginPath()
        ctx.moveTo(x, y - s / 2); ctx.lineTo(x + s / 2, y); ctx.lineTo(x, y + s / 2); ctx.lineTo(x - s / 2, y)
        ctx.closePath()
        ctx.fill()
        ctx.strokeStyle = "#fff"
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    function enemy(e, seen) {
      const r = cell * 0.36
      ctx.lineWidth = 2
      if (seen) {
        dot(c(e.x), c(e.y), r, e.kind === "boss" ? "#c0f" : "#f33", "#000")
      } else {
        ctx.setLineDash([3, 3])
        ctx.globalAlpha = Math.max(0.35, 1 - e.ago / 5)
        dot(c(e.x), c(e.y), r, null, "#f93")
        ctx.setLineDash([])
      }
      ctx.fillStyle = seen ? "#fff" : "#f93"
      ctx.font = "bold " + Math.round(cell * 0.45) + "px ui-monospace, Menlo, monospace"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(LETTER[e.kind] || "?", c(e.x), c(e.y) + 1)
      ctx.globalAlpha = 1
    }
    function draw(o) {
      ctx.drawImage(base, 0, 0)
      if (o.exitLocked) {
        ctx.strokeStyle = "#f33"
        ctx.lineWidth = 2
        for (const [x, y] of exits) {
          ctx.strokeRect(c(x) + 2, c(y) + 2, cell - 4, cell - 4)
          ctx.beginPath(); ctx.moveTo(c(x) + 3, c(y) + 3); ctx.lineTo(c(x + 1) - 3, c(y + 1) - 3); ctx.stroke()
        }
      }
      map.doors.forEach((d, i) => door(d, o.doors[i] || "closed"))
      map.items.forEach((it, i) => { if (!o.taken[i]) item(it) })
      if (o.path.length > 1) {
        ctx.strokeStyle = "rgba(0, 221, 255, 0.85)"
        ctx.lineWidth = Math.max(2, cell / 7)
        ctx.lineJoin = "round"
        ctx.beginPath()
        ctx.moveTo(c(o.player.x), c(o.player.y))
        for (const [x, y] of o.path.slice(1)) ctx.lineTo(mid(x), mid(y))
        ctx.stroke()
        for (const [x, y] of o.path.slice(1)) dot(mid(x), mid(y), Math.max(1.5, cell / 10), "#0df")
      }
      if (o.goal && o.goal.cell) {
        const [x, y] = o.goal.cell
        ctx.strokeStyle = "#f5d"
        ctx.lineWidth = 3
        ctx.strokeRect(c(x) + 1.5, c(y) + 1.5, cell - 3, cell - 3)
      }
      for (const s of o.shots) dot(c(s.x), c(s.y), Math.max(2, cell / 8), "#fa0")
      for (const e of o.remembered) enemy(e, false)
      for (const e of o.enemies) enemy(e, true)
      const px = c(o.player.x)
      const py = c(o.player.y)
      ctx.strokeStyle = "#5f5"
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px + o.player.dir[0] * cell * 0.9, py + o.player.dir[1] * cell * 0.9)
      ctx.stroke()
      ctx.lineWidth = 1
      dot(px, py, cell * 0.3, "#5f5", "#000")
      const goal = o.goal ? (o.goal.cell ? o.goal.what + " at " + o.goal.cell.join(",") : o.goal.what) : "none yet"
      const lines = [
        "level " + (map.level || "-"),
        "goal: " + goal,
        "path: " + (o.path.length > 1 ? (o.path.length - 1) + " steps" : "-"),
        "enemies in sight " + o.enemies.length + ", seen lately " + o.remembered.length,
      ]
      goalEl.replaceChildren(...lines.map((t) => { const d = document.createElement("div"); d.textContent = t; return d }))
    }
  }
`

export const MAP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corridor - AI map</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 13px/1.4 ui-monospace, Menlo, monospace; padding: 16px; }
  h2 { margin: 0; font-size: 11px; font-weight: normal; color: #888; text-transform: uppercase; letter-spacing: 1px; }
${MAP_STYLE}
</style>
</head>
<body>
${MAP_PANEL}
<script>
${MAP_SCRIPT}
  mapView(new EventSource("/stream?only=map"))
</script>
</body>
</html>
`
