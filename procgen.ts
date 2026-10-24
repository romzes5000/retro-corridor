// Endless mode: depth N is the level built from seed N. A 24x24 maze (recursive backtracker on the
// odd lattice) with rooms cut on top for loops, the exit next to the cell farthest from the start,
// keyed doors only where they cut the start-exit route (so the key always lies before its door),
// and enemies and supplies that grow with depth.
namespace corridor {
    export const GEN_SIZE = 24
    const GEN_LATTICE = (GEN_SIZE - 2) >> 1
    const GEN_WALL = 1
    const GEN_FLOOR = 0

    class Gen {
        grid: number[]
        marks: string[]
        lava: number[]
        rng: Rng
        rooms: number[]
        constructor(seed: number) {
            this.grid = []
            this.marks = []
            this.lava = []
            for (let i = 0; i < GEN_SIZE * GEN_SIZE; i++) {
                this.grid.push(GEN_WALL)
                this.marks.push("")
                this.lava.push(0)
            }
            this.rng = new Rng(seed * 7919 + 13)
            this.rooms = []
        }
    }

    function at(x: number, y: number): number {
        return y * GEN_SIZE + x
    }

    function open(g: Gen, cell: number): boolean {
        return g.grid[cell] == GEN_FLOOR && g.lava[cell] == 0
    }

    // Breadth-first distances from `from`; `shut` cells (doors under test) count as walls.
    function reach(g: Gen, from: number, shut: number[]): number[] {
        const dist: number[] = []
        for (let i = 0; i < g.grid.length; i++) dist.push(-1)
        if (!open(g, from)) return dist
        const queue = [from]
        dist[from] = 0
        let head = 0
        while (head < queue.length) {
            const c = queue[head++]
            const x = c % GEN_SIZE
            const y = Math.idiv(c, GEN_SIZE)
            const next = [x > 0 ? c - 1 : -1, x < GEN_SIZE - 1 ? c + 1 : -1, y > 0 ? c - GEN_SIZE : -1, y < GEN_SIZE - 1 ? c + GEN_SIZE : -1]
            for (const n of next) {
                if (n < 0 || dist[n] >= 0 || !open(g, n) || shut.indexOf(n) >= 0) continue
                dist[n] = dist[c] + 1
                queue.push(n)
            }
        }
        return dist
    }

    // Walks back down the distance field from `to` to the start: one shortest path, start first.
    function pathTo(dist: number[], to: number): number[] {
        const path = [to]
        let c = to
        while (dist[c] > 0) {
            const x = c % GEN_SIZE
            const y = Math.idiv(c, GEN_SIZE)
            const next = [x > 0 ? c - 1 : -1, x < GEN_SIZE - 1 ? c + 1 : -1, y > 0 ? c - GEN_SIZE : -1, y < GEN_SIZE - 1 ? c + GEN_SIZE : -1]
            for (const n of next) {
                if (n >= 0 && dist[n] == dist[c] - 1) {
                    c = n
                    break
                }
            }
            path.unshift(c)
        }
        return path
    }

    function carveMaze(g: Gen): void {
        const seen: boolean[] = []
        for (let i = 0; i < GEN_LATTICE * GEN_LATTICE; i++) seen.push(false)
        const stack = [0]
        seen[0] = true
        g.grid[at(1, 1)] = GEN_FLOOR
        const dx = [1, -1, 0, 0]
        const dy = [0, 0, 1, -1]
        while (stack.length > 0) {
            const top = stack[stack.length - 1]
            const lx = top % GEN_LATTICE
            const ly = Math.idiv(top, GEN_LATTICE)
            const options: number[] = []
            for (let k = 0; k < 4; k++) {
                const nx = lx + dx[k]
                const ny = ly + dy[k]
                if (nx < 0 || ny < 0 || nx >= GEN_LATTICE || ny >= GEN_LATTICE) continue
                if (!seen[ny * GEN_LATTICE + nx]) options.push(k)
            }
            if (options.length == 0) {
                stack.pop()
                continue
            }
            const k = options[g.rng.next(options.length)]
            const nx = lx + dx[k]
            const ny = ly + dy[k]
            seen[ny * GEN_LATTICE + nx] = true
            g.grid[at(1 + lx * 2 + dx[k], 1 + ly * 2 + dy[k])] = GEN_FLOOR
            g.grid[at(1 + nx * 2, 1 + ny * 2)] = GEN_FLOOR
            stack.push(ny * GEN_LATTICE + nx)
        }
    }

    function carveRooms(g: Gen): void {
        const count = 3 + g.rng.next(3)
        for (let r = 0; r < count; r++) {
            const rw = 3 + g.rng.next(3)
            const rh = 3 + g.rng.next(3)
            const x0 = 1 + g.rng.next(GEN_SIZE - 2 - rw)
            const y0 = 1 + g.rng.next(GEN_SIZE - 2 - rh)
            for (let y = y0; y < y0 + rh; y++) {
                for (let x = x0; x < x0 + rw; x++) g.grid[at(x, y)] = GEN_FLOOR
            }
            g.rooms.push(x0)
            g.rooms.push(y0)
            g.rooms.push(x0 + rw - 1)
            g.rooms.push(y0 + rh - 1)
        }
    }

    // A one-cell passage: floor along one axis, walls on both sides of the other.
    function passage(g: Gen, c: number): boolean {
        const x = c % GEN_SIZE
        const y = Math.idiv(c, GEN_SIZE)
        if (x < 1 || y < 1 || x > GEN_SIZE - 2 || y > GEN_SIZE - 2) return false
        const wallsNS = g.grid[c - GEN_SIZE] == GEN_WALL && g.grid[c + GEN_SIZE] == GEN_WALL
        const wallsEW = g.grid[c - 1] == GEN_WALL && g.grid[c + 1] == GEN_WALL
        const floorEW = g.grid[c - 1] == GEN_FLOOR && g.grid[c + 1] == GEN_FLOOR
        const floorNS = g.grid[c - GEN_SIZE] == GEN_FLOOR && g.grid[c + GEN_SIZE] == GEN_FLOOR
        return (wallsNS && floorEW) || (wallsEW && floorNS)
    }

    function nearStart(c: number): boolean {
        return c % GEN_SIZE < 4 && Math.idiv(c, GEN_SIZE) < 4
    }

    function free(g: Gen, c: number): boolean {
        return open(g, c) && g.marks[c] == "" && !nearStart(c)
    }

    // First passage between 40% and 95% of the route (after `after`) whose closing cuts off `goal`,
    // falling back to anywhere past the first quarter.
    function cutDoor(g: Gen, path: number[], after: number, start: number, goal: number, shut: number[]): number {
        const found = cutBetween(g, path, Math.max(after + 3, Math.idiv(path.length * 2, 5)), start, goal, shut)
        return found >= 0 ? found : cutBetween(g, path, Math.max(after + 3, path.length >> 2), start, goal, shut)
    }

    function cutBetween(g: Gen, path: number[], from: number, start: number, goal: number, shut: number[]): number {
        const to = path.length - 1 - Math.idiv(path.length, 20)
        for (let i = from; i < to; i++) {
            const c = path[i]
            if (!passage(g, c) || g.marks[c] != "" || nearStart(c)) continue
            const test = shut.concat([c])
            if (reach(g, start, test)[goal] < 0) return i
        }
        return -1
    }

    // Farthest free cell reachable from the start with `shut` closed, preferring cells that
    // `before` (the previous door closed) cannot reach, i.e. between the two doors.
    function keySpot(g: Gen, start: number, shut: number[], before: number[]): number {
        const dist = reach(g, start, shut)
        const prior = before.length > 0 ? reach(g, start, before) : null
        let best = -1
        let bestScore = -1
        for (let c = 0; c < dist.length; c++) {
            if (dist[c] < 0 || !free(g, c)) continue
            const score = dist[c] + (prior && prior[c] < 0 ? 1000 : 0)
            if (score > bestScore) {
                best = c
                bestScore = score
            }
        }
        return best
    }

    function scatter(g: Gen, mark: string, count: number): void {
        for (let tries = 0; count > 0 && tries < 400; tries++) {
            const c = g.rng.next(g.grid.length)
            if (!free(g, c)) continue
            g.marks[c] = mark
            count--
        }
    }

    // Lava only where it costs no reachability: every other floor cell must stay connected, and the
    // cell in front of the exit (a dead end, so the count alone would allow it) stays clear.
    function pourLava(g: Gen, start: number, far: number, pools: number): void {
        const floors = () => {
            let n = 0
            for (let i = 0; i < g.grid.length; i++) if (open(g, i)) n++
            return n
        }
        for (let tries = 0; pools > 0 && tries < 60; tries++) {
            const c = g.rng.next(g.grid.length)
            if (c == far || !free(g, c) || passage(g, c)) continue
            g.lava[c] = 1
            const dist = reach(g, start, [])
            let reached = 0
            for (const d of dist) if (d >= 0) reached++
            if (reached != floors()) {
                g.lava[c] = 0
                continue
            }
            pools--
        }
    }

    function floorSides(g: Gen, c: number): number {
        const x = c % GEN_SIZE
        const y = Math.idiv(c, GEN_SIZE)
        let n = 0
        if (x > 0 && g.grid[c - 1] == GEN_FLOOR) n++
        if (x < GEN_SIZE - 1 && g.grid[c + 1] == GEN_FLOOR) n++
        if (y > 0 && g.grid[c - GEN_SIZE] == GEN_FLOOR) n++
        if (y < GEN_SIZE - 1 && g.grid[c + GEN_SIZE] == GEN_FLOOR) n++
        return n
    }

    // A wall next to `far` that touches no other floor, so the exit is only reachable through `far`.
    function exitWall(g: Gen, far: number): number {
        const sides = [far + 1, far - 1, far + GEN_SIZE, far - GEN_SIZE]
        for (const c of sides) {
            if (g.grid[c] == GEN_WALL && floorSides(g, c) == 1) return c
        }
        return -1
    }

    // The farthest cell from the start that can host an exit wall.
    function exitCell(g: Gen, dist: number[]): number {
        let far = -1
        for (let c = 0; c < dist.length; c++) {
            if (dist[c] > 0 && (far < 0 || dist[c] > dist[far]) && exitWall(g, c) >= 0) far = c
        }
        return far
    }

    function enemyMark(g: Gen, depth: number): string {
        const roll = g.rng.next(10)
        if (depth >= 3 && roll < 2) return "K"
        if (depth >= 2 && roll < 5) return "F"
        return "E"
    }

    export function generateLevel(depth: number): Level {
        const g = new Gen(depth)
        carveMaze(g)
        carveRooms(g)
        const start = at(1, 1)
        const fromStart = reach(g, start, [])
        const far = exitCell(g, fromStart)
        const path = pathTo(fromStart, far)
        g.marks[exitWall(g, far)] = "X"

        const shut: number[] = []
        const red = cutDoor(g, path, 0, start, far, shut)
        const key = red >= 0 ? keySpot(g, start, [path[red]], []) : -1
        if (key >= 0) {
            g.marks[key] = "r"
            g.marks[path[red]] = "R"
            shut.push(path[red])
            if (depth >= 3) {
                const blue = cutDoor(g, path, red, start, far, [])
                if (blue >= 0) {
                    const bkey = keySpot(g, start, [path[blue]], [path[red]])
                    if (bkey >= 0) {
                        g.marks[bkey] = "b"
                        g.marks[path[blue]] = "D"
                    }
                }
            }
        }
        for (let tries = 0, doors = 2 + Math.idiv(depth, 3); doors > 0 && tries < 200; tries++) {
            const c = g.rng.next(g.grid.length)
            if (c == far || g.grid[c] != GEN_FLOOR || g.marks[c] != "" || nearStart(c) || !passage(g, c)) continue
            g.marks[c] = "|"
            doors--
        }
        if (depth >= 2) pourLava(g, start, far, 1 + g.rng.next(3))

        if (depth % 5 == 0) {
            const dist = reach(g, start, [])
            let boss = -1
            for (let c = 0; c < dist.length; c++) {
                if (dist[c] >= 0 && free(g, c) && c != far && (boss < 0 || dist[c] > dist[boss])) boss = c
            }
            if (boss >= 0) g.marks[boss] = "Z"
        }
        const enemies = Math.min(14, 3 + depth)
        for (let i = 0; i < enemies; i++) scatter(g, enemyMark(g, depth), 1)
        scatter(g, "H", 2 + g.rng.next(2))
        scatter(g, "A", Math.min(7, 3 + (depth >> 1)))
        if (depth == 2) scatter(g, "G", 1)
        g.marks[start] = "S"

        const rows: string[] = []
        for (let y = 0; y < GEN_SIZE; y++) {
            let row = ""
            for (let x = 0; x < GEN_SIZE; x++) {
                const c = at(x, y)
                if (g.marks[c] != "") row += g.marks[c]
                else if (g.lava[c] == 1) row += "L"
                else row += g.grid[c] == GEN_WALL ? "#" : "."
            }
            rows.push(row)
        }
        const lights: number[] = []
        for (let i = 0; i + 3 < g.rooms.length; i += 4) {
            const roll = g.rng.next(4)
            if (roll == 0) continue
            for (let k = 0; k < 4; k++) lights.push(g.rooms[i + k])
            lights.push(roll == 3 ? LIGHT_FLICKER : roll)
        }
        const ang = g.grid[at(2, 1)] == GEN_FLOOR ? 0 : 256
        return new Level("DEPTH " + depth, rows, ang, lights)
    }
}
