# Corridor

A Doom-style raycaster for MakeCode Arcade consoles on the STM32F401 (tested on the ELECFREAKS Retro
Arcade: 160×120 screen, 84 MHz Cortex-M4, 96 KB RAM). Written in MakeCode Static TypeScript with
fixed-point math, no floats in the hot loop.

![Before and after](demo/out/01-before-after.gif)

| | |
|---|---|
| ![Key and door](demo/out/06-key-door.gif) | ![Shotgun against shooters](demo/out/07-shotgun-shooter.gif) |
| ![Level summary and melt](demo/out/08-melt-summary.gif) | ![Floor, light and lava](demo/out/09-floor-light.gif) |
| ![Endless mode](demo/out/10-endless.gif) | ![Imp fight](demo/out/03-imp-fight.gif) |
| ![Boss fight](demo/out/11-boss-fight.gif) | ![Jev plays the hangar](demo/out/12-ai-player.gif) |

## What is in it

- **Campaign** of three hand-made levels: hangar, warehouse, arena with a boss. Red and blue keys,
  sliding doors, secret walls, level summary (kills, items, secrets, time) and a Doom-style melt between
  screens. **Levels** on the title screen starts the campaign from any of the three; starting past
  the warehouse hands over its shotgun. Only a full run from the hangar sets a time record.
- **Endless mode**: depth N is a 24×24 maze generated from seed N, with rooms, keyed doors placed on
  the only way to the exit (the key is always on your side of its door), lava, and more and tougher
  enemies the deeper you go. A boss guards every fifth depth.
- **Enemies**: imp, fireball shooter that keeps its distance, fast knight, boss with a fan of
  fireballs. Death animations, blood and scorch decals, growls from behind corners.
- **Weapons**: pistol and shotgun (spread, damage falls off with range).
- **Rendering**: textured walls, doors and floor, per-cell light with flickering lamps, lava, sprites
  sorted against a z-buffer, automap. A quality ladder steps down (floor 2×2 → floor bands → 80 rays)
  after 3 s below 20 FPS.
- **Feel**: distance-attenuated sound, music, pause menu, difficulty (easy / normal / hard), records
  saved on the console.
- **AI player**: `PLAYER AI` on the title screen hands the controls to Jev, a fast decision model,
  running on a Mac connected over USB. See below.

## Controls

| Button | Action |
|---|---|
| D-pad | Walk and turn |
| A | Fire, open doors |
| B + left/right | Strafe |
| B tap | Automap |
| B double tap | Switch weapon |
| B hold | Pause menu (music, difficulty, quit) |
| Menu | System menu of the console |

## Build and flash

```bash
npm ci
npm test               # unit and feature tests in Node (logic, render, pilot playthroughs)
npx makecode build     # -> built/stm32f401/binary.uf2
npm run demo           # re-renders demo/out/*.gif from scripted runs of the real game code
```

Prebuilt `corridor.uf2` is attached to each [release](https://github.com/romzes5000/retro-corridor/releases).
To flash: connect the console over USB, double-press Reset until the `ARCADE-F4` drive appears, copy
the UF2 onto it. The console reboots into the game.

The game logs `fps N qQ step S` to the console once every 5 s (readable over HF2), handy for checking
performance on real hardware.

## AI player over USB (Jev)

With `PLAYER AI` selected, the console plays by itself while a bridge on the computer decides what to
do next. The game never waits for it: it keeps running at full speed and executes the last command.

1. Every 250 ms the console prints a snapshot over the HF2 serial channel: player, live enemies,
   fireballs, doors, picked-up items (`AI S ...` to `AI END`). The map never goes over the wire.
2. The bridge rebuilds the same level from the game code (`load-logic.ts`) and checks the console's
   map hash, then works out the route (key, its door, the exit, or the boss while the exit is locked).
3. It describes the situation in plain English (goal, visible enemies, the safe side of an incoming
   fireball, medkit and ammo distance, the outcome of the last commands) and asks
   Jev (TypeSafe System One, `/api/v1/systemone` on OpenRouter) to pick one tactic: advance, attack,
   dodge left or right, retreat, heal, ammo, open, wait.
4. The tactic becomes one short command (go to a cell up to 2 tiles away in a straight line, attack
   enemy N, strafe, use, wait), written straight into a 32-byte mailbox in the console's RAM.
   Commands answering a snapshot older than 1.2 s of game time are dropped.

The screen shows `JEV ATTACK 84% 230MS` (tactic, confidence, model latency), or `NO LINK` after 3 s
without commands. AI runs never set records; after a death the level restarts by itself, after a win
the next one starts. Hold B for the pause menu, `QUIT` returns control to you.

```bash
export OPENROUTER_KEY=...            # an OpenRouter API key; never commit it
npm run ai -- --check                # console only: finds the mailbox, listens for 3 s
npm run ai                           # play on the console (pick PLAYER AI, start a level)
npm run ai -- --sim HANGAR --runs 5  # same protocol against the game running in Node
npm run ai -- --sim HANGAR --fake --fast   # rule-based picks, no key, virtual time
npm run ai:probe                     # latency and cost of 30 Jev calls
```

`JEV_MODEL` overrides the model (default `~typesafe/jev-latest`). Every decision goes to
`bridge/out/run-*.jsonl` with the facts, the answer, the latency and the cost.

On five simulated runs of the hangar on normal Jev won 5 of 5, at 488 ms median latency
(591 ms p95), about 2 decisions per second and $0.00003 per decision, roughly $0.03 for ten minutes
of play. The GIF above is one of those runs replayed from `demo/ai-hangar.json` at 3x.

## Layout

| File | What |
|---|---|
| `logic.ts` | World, ray casting, movement, combat, input gestures |
| `doors.ts`, `enemies.ts` | Doors and keys; enemy kinds, AI, fireballs |
| `levels.ts`, `procgen.ts` | Campaign maps; endless-mode generator |
| `game.ts` | Sessions, menus, difficulty, records |
| `render.ts`, `art.ts` | Renderer; walls, weapons, items and font drawn in code |
| `art-enemies.ts` | Enemy and fireball frames, generated from `art-src/demons.png` |
| `tools/` | Sprite sheet importer |
| `ai.ts` | AI link on the console: snapshots, mailbox, command executor, status line |
| `main.ts` | Device glue: loop, sound, music, settings, AI mailbox |
| `bridge/` | AI bridge on the computer: HF2 transport, shadow world, route, facts, Jev, simulator |
| `demo/` | Pilot bot, GIF recorder, legacy renderer for the before/after clip |

## Art

Walls, weapons, items, HUD and font are hex strings in `art.ts`, drawn by hand in the 16-colour palette.

Enemies come from a sprite sheet, `art-src/demons.png`: imp, shooter, knight and boss, eight frames each
(walk A, walk B, attack, hurt, three death frames, corpse), plus two fireball frames.
`npm run sprites` turns it into `art-enemies.ts`:

- cell boxes are a fixed table in `tools/sprite-import.ts`; `demo/out/sheet-cells.png` draws them over the
  sheet for checking;
- the background is removed by a flood fill from the cell edges;
- every pixel is snapped to the game palette first (each kind has its own colour set), then the cell is
  shrunk to 16x16 (boss 24x24, fireball 8x8) with one scale per kind, anchored at the bottom centre;
- `OVERRIDES` patches single pixels after the import;
- `demo/out/sheet-enemies.png` is a preview of the result.

Do not edit `art-enemies.ts` by hand: change the sheet or the importer and run `npm run sprites` again.

## Disclaimer

Corridor is a fan homage to the 1993 game DOOM. It is not affiliated with, endorsed by or connected
to id Software, ZeniMax or Bethesda. DOOM is a trademark of id Software LLC. No code, graphics, sounds
or levels from DOOM are used: all art, maps and music in this repository are original.
The enemy sprite sheet was generated by a neural network from our own prompt; it contains no DOOM assets.

## License

[MIT](LICENSE)
