// Pixel data as hex strings (one char = one palette index, "." = transparent), so the console
// build and the Node demo read identical art without depending on the Arcade `img` literal.
namespace corridorArt {
    // Three brightness ramps (stone, brown, red) plus accents. Slot 0 is transparent in Arcade.
    export const PALETTE = [
        0x000000,
        0xf2e6c9, // 1 bone white
        0xd8342a, // 2 red
        0x7a1a14, // 3 dark red
        0xf7d038, // 4 yellow
        0xc26a1a, // 5 orange
        0xa39b8f, // 6 stone light
        0x77706a, // 7 stone
        0x4f4944, // 8 stone dark
        0x2e2a27, // 9 stone darkest
        0x7a5a3a, // 10 brown light
        0x563f2a, // 11 brown
        0x36281c, // 12 brown dark
        0x3a62c8, // 13 blue (keys, blue door)
        0x252832, // 14 ceiling dark
        0x0b0a0a, // 15 black
    ]

    // One step darker along the colour's own ramp; used to pre-shade textures by distance.
    export const DARKER = [0, 6, 3, 9, 5, 10, 7, 8, 9, 15, 11, 12, 15, 14, 15, 15]

    // Ceiling uses 14 only, so slot 13 is free for blue.

    // [firstRow, lastRow, colour, ditherColour] for the 100-row viewport backdrop.
    export const BANDS = [
        [0, 13, 14, 14],
        [14, 15, 14, 14],
        [16, 37, 14, 14],
        [38, 39, 14, 15],
        [40, 52, 15, 15],
        [53, 55, 15, 12],
        [56, 63, 12, 12],
        [64, 65, 12, 11],
        [66, 77, 11, 11],
        [78, 79, 11, 10],
        [80, 99, 10, 10],
    ]

    export const STONE = [
        "6666666966666669",
        "7787777977778779",
        "8888888988888889",
        "9999999999999999",
        "6669666666696666",
        "7779787777797787",
        "8889888888898888",
        "9999999999999999",
        "6666666966666669",
        "7777877977777779",
        "8888888988888889",
        "9999999999999999",
        "6669666666696666",
        "7779777787797777",
        "8889888888898888",
        "9999999999999999",
    ]

    export const BRICK = [
        "aaaaaaa9aaaaaaa9",
        "bb5bbbb9bbbbb5b9",
        "ccccccc9ccccccc9",
        "9999999999999999",
        "aaa9aaaaaaa9aaaa",
        "bbb9bbbb5bb9bbbb",
        "ccc9ccccccc9cccc",
        "9999999999999999",
        "aaaaaaa9aaaaaaa9",
        "bbbbb5b9bbbbbbb9",
        "ccccccc9ccccccc9",
        "9999999999999999",
        "aaa9aaaaaaa9aaaa",
        "bbb9bbbbbbb9bb5b",
        "ccc9ccccccc9cccc",
        "9999999999999999",
    ]

    export const EXIT = [
        "5555555555555555",
        "5444444554444445",
        "5411114554111145",
        "5411114554111145",
        "5444444554444445",
        "5444444554444445",
        "5444444554444445",
        "5444444554444445",
        "5444444554444445",
        "5444444554444445",
        "5555555555555555",
        "5ff44ff44ff44ff5",
        "5f44ff44ff44ff45",
        "544ff44ff44ff445",
        "54ff44ff44ff44f5",
        "5555555555555555",
    ]

    // Floor tiles, 16x16 texels per map cell.
    export const FLOOR = [
        "abbbbbbcabbbbbbc",
        "bbbbabbcbbbbbbbc",
        "bbbbbbbcbbbabbbc",
        "bbabbbbcbbbbbbbc",
        "bbbbbbbcbbbbbabc",
        "bbbbbbbcbabbbbbc",
        "bbbbbabcbbbbbbbc",
        "cccccccccccccccc",
        "abbbbbbcabbbbbbc",
        "bbbabbbcbbbbabbc",
        "bbbbbbbcbbbbbbbc",
        "bbbbbbbcbabbbbbc",
        "babbbbbcbbbbbbbc",
        "bbbbbbbcbbbbbbbc",
        "bbbbbabcbbbabbbc",
        "cccccccccccccccc",
    ]

    // Lava, scrolled diagonally over time by the floor caster.
    export const LAVA = [
        "5552222255522222",
        "5422222554422223",
        "4222225542222233",
        "2222255422222333",
        "2222554222223332",
        "2225542222233322",
        "2255422222333222",
        "2554222223332225",
        "5542222233322255",
        "5422222333222554",
        "4222223332225542",
        "2222233322255422",
        "2222333222554222",
        "2223332225542222",
        "2233322255422222",
        "2333222554222225",
    ]

    // Door template: "x" is replaced with the door's stripe colour (yellow, red or blue).
    export const DOOR = [
        "8888888888888888",
        "8777777777777778",
        "8767777777777678",
        "8777777777777778",
        "8777777777777778",
        "8xxxxxxxxxxxxxx8",
        "8x9x9x9x9x9x9xx8",
        "8xxxxxxxxxxxxxx8",
        "8777777777777778",
        "8777766666677778",
        "8777769999677778",
        "8777766666677778",
        "8777777777777778",
        "8767777777777678",
        "8777777777777778",
        "8888888888888888",
    ]

    // Exit while the boss lives: bars over the yellow door.
    export const EXIT_BARS = [
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9999999999999999",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9999999999999999",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
        "9..9..9..9..9..9",
    ]

    // Template key sprite, "x" = key colour.
    export const KEY = [
        "........",
        "..xxx...",
        ".x...x..",
        ".x...x..",
        "..xxx...",
        "...x....",
        "...xx...",
        "...xxx..",
    ]

    export const BLOOD = [
        "........",
        "...22...",
        ".232232.",
        "..3223..",
    ]

    export const SCORCH = [
        "........",
        "..9889..",
        ".989989.",
        "..9999..",
    ]

    export const MEDKIT = [
        "........",
        ".111111.",
        ".112211.",
        ".122221.",
        ".122221.",
        ".112211.",
        ".666666.",
        "........",
    ]

    export const AMMO = [
        "........",
        ".4.4.4..",
        ".5.5.5..",
        "aaaaaaa.",
        "abbbbba.",
        "ab55bba.",
        "accccca.",
        "........",
    ]

    export const GUN = [
        "..........8668..........",
        "..........8778..........",
        "..........8778..........",
        "..........8778..........",
        ".........886688.........",
        ".........877778.........",
        ".........877778.........",
        "........88777788........",
        "........89999998........",
        ".......8a999999a8.......",
        "......8aab9999baa8......",
        ".....aaabbb99bbbaaa.....",
        "....a1aabbbbbbbbaa1a....",
        "...aa1aaabbbbbbaaa1aa...",
        "..aaaaaaabbbbbbaaaaaaa..",
        ".aaaaaaaaabbbbaaaaaaaaa.",
        "aaaaaaaaaaabbaaaaaaaaaaa",
        "aaaaaaaaaaaaaaaaaaaaaaaa",
    ]

    export const SHOTGUN = [
        "...........8998998998...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "...........8778998778...........",
        "..........899999999998..........",
        "..........899997799998..........",
        "..........899999999998..........",
        ".........baaabaaaabaaab.........",
        ".......111aabaaaabaaaa111.......",
        ".....b111aabaaaabaaaaba111b.....",
        "...ba1111abaaaabaaaabaa1111ab...",
        ".baa1111abaaaabaaaabaaaa1111abb.",
        "aaa11111baaaabaaaabaaaab11111aaa",
    ]

    export const SHOTGUN_ITEM = [
        "................",
        "................",
        "..8888888877....",
        ".899999999aaab..",
        "..8888888aaabb..",
        "........aab.....",
        ".......aab......",
        "................",
    ]

    export const FLASH = [
        "....4..4....",
        ".4..44.4..4.",
        "..4.4114.4..",
        "...441144...",
        "..44111144..",
        ".4441111444.",
        "..44111144..",
        "...445544...",
        "....4554....",
        ".....55.....",
    ]

    export const FACE_OK = [
        "....cccccccc....",
        "...cbbbbbbbbc...",
        "..cbaaaaaaaabc..",
        "..caaaaaaaaaac..",
        "..aa1faaaa1faa..",
        "..aaaaaaaaaaaa..",
        "..aaaaabbaaaaa..",
        "..aaaaabbaaaaa..",
        "..aaaaaaaaaaaa..",
        "..aaab3333baaa..",
        "...aaabbbbaaa...",
        "....aaaaaaaa....",
        ".....bbbbbb.....",
        "...8888888888...",
        "..888888888888..",
        ".88888888888888.",
    ]

    export const FACE_HURT = [
        "....cccccccc....",
        "...cbbbbbbbbc...",
        "..cbaaaaaaaabc..",
        "..caaaaaaaaaac..",
        "..aaffaaaaffaa..",
        "..a2aaaaaaaa2a..",
        "..aaaaabbaaaaa..",
        "..aaaaabbaaaaa..",
        "..a2aaaaaaa2aa..",
        "..aaaffffffaaa..",
        "...aaabbbbaaa...",
        "....aaaaaaaa....",
        ".....bbbbbb.....",
        "...8888888888...",
        "..888888888888..",
        ".88888888888888.",
    ]

    export const FACE_GRIN = [
        "....cccccccc....",
        "...cbbbbbbbbc...",
        "..cbaaaaaaaabc..",
        "..caaaaaaaaaac..",
        "..aa1faaaa1faa..",
        "..aaaaaaaaaaaa..",
        "..aaaaabbaaaaa..",
        "..aaaaabbaaaaa..",
        "..aaaaaaaaaaaa..",
        "..aab111111baa..",
        "...aab1111baa...",
        "....aaaaaaaa....",
        ".....bbbbbb.....",
        "...8888888888...",
        "..888888888888..",
        ".88888888888888.",
    ]

    export const FACE_DEAD = [
        "....cccccccc....",
        "...cbbbbbbbbc...",
        "..cbaaaaaaaabc..",
        "..caaaaaaaaaac..",
        "..afafaaaafafa..",
        "..aafaaaaaafaa..",
        "..afafabbafafa..",
        "..aaaaabbaaaaa..",
        "..a2aaaaaaaaaa..",
        "..aaa333333aaa..",
        "...aaa3333aaa...",
        "....aaaaaaaa....",
        ".....bbbbbb.....",
        "...8888888888...",
        "..888888888888..",
        ".88888888888888.",
    ]

    export const GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:!/-.>+%"
    // 3x5 glyphs in GLYPHS order, one per line (15 bits and a newline): rows top to bottom, 3 bits
    // per row. One string rather than an array: every array element costs flash to build.
    export const FONT = `111101101101111
010110010010111
111001111100111
111001111001111
101101111001001
111100111001111
111100111101111
111001010010010
111101111101111
111101111001111
010101111101101
110101110101110
011100100100011
110101101101110
111100110100111
111100110100100
011100101101011
101101111101101
111010010010111
001001001101010
101101110101101
100100100100111
101111111101101
110101101101101
010101101101010
110101110100100
010101101110011
110101110101101
011100010001110
111010010010010
101101101101111
101101101101010
101101111111101
101101010101101
101101010010010
111001010100111
000010000010000
010010010000010
001001010100100
000000111000000
000000000000010
100010001010100
000010111010000
101001010100101
`
}
