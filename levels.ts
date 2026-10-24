// Campaign maps. Legend: # stone, B brick, X exit, | door, R red door, D blue door, P secret wall,
// L lava (5 HP per second). S start, E imp, F shooter, K knight, Z boss (exit stays locked until it dies), G shotgun, H medkit, A ammo, r red key, b blue key.
namespace corridor {
    export class Level {
        name: string
        map: string[]
        ang: number
        lights: number[]
        constructor(name: string, map: string[], ang: number, lights: number[]) {
            this.name = name
            this.map = map
            this.ang = ang
            this.lights = lights
        }
    }

    export const CAMPAIGN = [
        "################",
        "#S..#....H.....#",
        "#...#.####.###.#",
        "#.A.....E#...#.#",
        "##|####.##.#.#.#",
        "#...E.#....#E#.#",
        "#.###.####.###.#",
        "#.#H#.....E....#",
        "#.#.#####|######",
        "#.....B......A.#",
        "####.BBB.#P##.##",
        "#E...B...#H#...#",
        "#.##.B.E.###.#.#",
        "#.#..BBB.#...#.#",
        "#.#...........HX",
        "################",
    ]

    export const WAREHOUSE = [
        "####################",
        "#...G.#.H....#....r#",
        "#.S...|............#",
        "#...A.#..BE..#.F...#",
        "#.....#......#.....#",
        "###|############D###",
        "#.....#......#A....#",
        "#.....R.E.B..#.....#",
        "#.E.H.#...b..#..F..#",
        "#.....#....E.#.....#",
        "###|############.###",
        "#.....#......#.....#",
        "#.....P..H...#.EB..#",
        "#.A...#....A.#.....X",
        "#.....#......#...F.#",
        "####################",
    ]

    export const ARENA = [
        "####################",
        "#.....####....######",
        "#.S...|.....E.PAH###",
        "#.....####....######",
        "#.A.A.####..A.######",
        "###########|########",
        "#######...........A#",
        "#.....#.K........F.#",
        "#.....#..B..LL..B..#",
        "#.H.A.#............#",
        "#.....#............#",
        "#.....|.....BB.Z...X",
        "#..E..#...A........#",
        "#.....#............#",
        "#.....#....LL.H....#",
        "#.A...#..B......B..#",
        "#...H.#.F........K.#",
        "#.....#............#",
        "####################",
    ]

    export const LEVELS = [
        new Level("HANGAR", CAMPAIGN, 0, [5, 1, 14, 3, 1, 1, 5, 12, 7, 2, 1, 9, 8, 14, LIGHT_FLICKER, 9, 11, 14, 14, 1]),
        new Level("WAREHOUSE", WAREHOUSE, 0, [7, 1, 12, 4, 1, 0, 6, 5, 9, 2, 14, 6, 18, 9, LIGHT_FLICKER, 7, 11, 12, 14, 3]),
        new Level("ARENA", ARENA, 0, [1, 6, 5, 17, 2, 7, 1, 13, 4, 1, 7, 6, 9, 8, LIGHT_FLICKER, 16, 15, 18, 17, LIGHT_FLICKER]),
    ]
}
