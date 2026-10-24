// Campaign maps. Legend: # stone, B brick, X exit, | door, R red door, D blue door, P secret wall,
// S start, E imp, F shooter, K knight, Z boss (exit stays locked until it dies), G shotgun, H medkit, A ammo, r red key, b blue key.
namespace corridor {
    export class Level {
        name: string
        map: string[]
        ang: number
        constructor(name: string, map: string[], ang: number) {
            this.name = name
            this.map = map
            this.ang = ang
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
        "#.....#..B......B..#",
        "#.H.A.#............#",
        "#.....#............#",
        "#.....|.....BB.Z...X",
        "#..E..#...A........#",
        "#.....#............#",
        "#.....#.......H....#",
        "#.A...#..B......B..#",
        "#...H.#.F........K.#",
        "#.....#............#",
        "####################",
    ]

    export const LEVELS = [
        new Level("HANGAR", CAMPAIGN, 0),
        new Level("WAREHOUSE", WAREHOUSE, 0),
        new Level("ARENA", ARENA, 0),
    ]
}
