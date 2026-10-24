// Sliding doors (Wolfenstein-style plane through the cell middle) and push-to-open secret walls.
namespace corridor {
    export const DOOR_CLOSED = 0
    export const DOOR_OPENING = 1
    export const DOOR_OPEN = 2
    export const DOOR_CLOSING = 3

    export class Door {
        cx: number
        cy: number
        key: number
        vertical: boolean
        progress: number
        state: number
        hold: number
        constructor(cx: number, cy: number, key: number, vertical: boolean) {
            this.cx = cx
            this.cy = cy
            this.key = key
            this.vertical = vertical
            this.progress = 0
            this.state = DOOR_CLOSED
            this.hold = 0
        }
    }

    export class Push {
        cx: number
        cy: number
        left: number
        constructor(cx: number, cy: number) {
            this.cx = cx
            this.cy = cy
            this.left = SECRET_MS
        }
    }

    function keyFor(tile: number): number {
        if (tile == TILE_DOOR_RED) return KEY_RED
        if (tile == TILE_DOOR_BLUE) return KEY_BLUE
        return 0
    }

    // Door plane orientation follows the passage: walls above and below mean an east-west passage,
    // so the plane is vertical (x = const) and rays crossing it step along x.
    export function setupDoors(world: World): void {
        world.doors = []
        world.doorIndex = []
        for (let i = 0; i < world.w * world.h; i++) world.doorIndex.push(-1)
        for (let cy = 0; cy < world.h; cy++) {
            for (let cx = 0; cx < world.w; cx++) {
                const tile = tileAt(world, cx, cy)
                if (!isDoor(tile)) continue
                const vertical = tileAt(world, cx, cy - 1) != TILE_FLOOR && tileAt(world, cx, cy + 1) != TILE_FLOOR
                world.doorIndex[cy * world.w + cx] = world.doors.length
                world.doors.push(new Door(cx, cy, keyFor(tile), vertical))
            }
        }
    }

    export function doorAt(world: World, cx: number, cy: number): Door {
        if (!isDoor(tileAt(world, cx, cy))) return null
        return world.doors[world.doorIndex[cy * world.w + cx]]
    }

    function overlaps(x: number, y: number, r: number, cx: number, cy: number): boolean {
        const half = (FP >> 1) + r
        return Math.abs(x - (cx * FP + (FP >> 1))) < half && Math.abs(y - (cy * FP + (FP >> 1))) < half
    }

    export function doorOccupied(world: World, door: Door): boolean {
        if (overlaps(world.x, world.y, PLAYER_RADIUS, door.cx, door.cy)) return true
        for (const enemy of world.enemies) {
            if (!enemy.dead && overlaps(enemy.x, enemy.y, IMP_RADIUS, door.cx, door.cy)) return true
        }
        return false
    }

    export function openDoor(world: World, door: Door): void {
        if (door.state == DOOR_OPENING || door.state == DOOR_OPEN) return
        door.state = DOOR_OPENING
        emit(world, "door")
    }

    // Enemies open plain doors they walk into; keyed doors stay shut for them.
    export function nudgeDoor(world: World, x: number, y: number): void {
        const door = doorAt(world, x >> 10, y >> 10)
        if (door && door.key == 0) openDoor(world, door)
    }

    // A pressed right in front of a door or secret wall; true when the press was spent on it.
    export function useAhead(world: World): boolean {
        const ax = world.x + ((cos(world.ang) * USE_REACH) >> 10)
        const ay = world.y + ((sin(world.ang) * USE_REACH) >> 10)
        const cx = ax >> 10
        const cy = ay >> 10
        const door = doorAt(world, cx, cy)
        if (door) {
            if (door.key != 0 && (world.keys & door.key) == 0) {
                emit(world, "locked")
                return true
            }
            if (door.state == DOOR_OPEN || door.state == DOOR_OPENING) return false
            openDoor(world, door)
            return true
        }
        if (tileAt(world, cx, cy) == TILE_SECRET) {
            for (const p of world.pushes) {
                if (p.cx == cx && p.cy == cy) return true
            }
            world.pushes.push(new Push(cx, cy))
            world.found += 1
            emit(world, "secret")
            return true
        }
        return false
    }

    export function updateDoors(world: World, dt: number): void {
        const step = Math.idiv(FP * dt + DOOR_OPEN_MS - 1, DOOR_OPEN_MS)
        for (const door of world.doors) {
            if (door.state == DOOR_OPENING) {
                door.progress += step
                if (door.progress >= FP) {
                    door.progress = FP
                    door.state = DOOR_OPEN
                    door.hold = DOOR_HOLD_MS
                }
            } else if (door.state == DOOR_OPEN) {
                door.hold -= dt
                if (door.hold <= 0) {
                    if (doorOccupied(world, door)) {
                        door.hold = 500
                    } else {
                        door.state = DOOR_CLOSING
                        emit(world, "door")
                    }
                }
            } else if (door.state == DOOR_CLOSING) {
                if (doorOccupied(world, door)) {
                    door.state = DOOR_OPENING
                } else {
                    door.progress -= step
                    if (door.progress <= 0) {
                        door.progress = 0
                        door.state = DOOR_CLOSED
                    }
                }
            }
        }
        for (let i = world.pushes.length - 1; i >= 0; i--) {
            const p = world.pushes[i]
            p.left -= dt
            if (p.left <= 0) {
                world.grid[p.cy * world.w + p.cx] = TILE_FLOOR
                world.pushes.splice(i, 1)
            }
        }
    }
}
