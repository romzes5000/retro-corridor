// Console glue: buttons -> corridor.Input, game events -> sound, vibration and screen effects.
const SHOW_FPS = true

function applyPalette(): void {
    const buf = Buffer.create(48)
    for (let i = 0; i < 16; i++) {
        const c = corridorArt.PALETTE[i]
        buf[i * 3] = (c >> 16) & 0xff
        buf[i * 3 + 1] = (c >> 8) & 0xff
        buf[i * 3 + 2] = c & 0xff
    }
    image.setPalette(buf)
}

function sound(wave: WaveShape, from: number, to: number, volume: number, ms: number): music.SoundEffect {
    return music.createSoundEffect(wave, from, to, volume, 0, ms, SoundExpressionEffect.None, InterpolationCurve.Linear)
}

// Positional sounds come as three pre-built volume sets (near, mid, far), indexed by
// corridor.soundLevel: building a sound effect per event would allocate on every shot.
function sound3(wave: WaveShape, from: number, to: number, volume: number, ms: number): music.SoundEffect[] {
    return [
        sound(wave, from, to, volume, ms),
        sound(wave, from, to, Math.idiv(volume * 11, 20), ms),
        sound(wave, from, to, Math.idiv(volume, 4), ms),
    ]
}

const SFX_SHOOT = sound(WaveShape.Noise, 1800, 300, 200, 110)
const SFX_EMPTY = sound(WaveShape.Square, 160, 120, 120, 40)
const SFX_STEP = sound(WaveShape.Noise, 220, 120, 60, 30)
const SFX_HURT = sound(WaveShape.Noise, 400, 80, 255, 180)
const SFX_PICKUP = sound(WaveShape.Square, 660, 1320, 160, 120)
const SFX_WIN = sound(WaveShape.Square, 440, 1760, 200, 700)
const SFX_DEAD = sound(WaveShape.Sawtooth, 400, 40, 255, 900)
const SFX_LOCKED = sound(WaveShape.Square, 220, 180, 150, 160)
const SFX_KEY = sound(WaveShape.Square, 880, 1760, 180, 200)
const SFX_SECRET = sound(WaveShape.Triangle, 330, 990, 200, 500)
const SFX_BLAST = sound(WaveShape.Noise, 1400, 60, 255, 260)
const SFX_SWAP = sound(WaveShape.Square, 500, 700, 120, 80)
const SFX_WEAPON = sound(WaveShape.Square, 440, 1320, 200, 350)
const SFX_UNLOCK = sound(WaveShape.Triangle, 220, 880, 220, 700)
const SFX_HIT = sound3(WaveShape.Sawtooth, 520, 140, 200, 90)
const SFX_KILL = sound3(WaveShape.Sawtooth, 300, 50, 255, 320)
const SFX_ALERT = sound3(WaveShape.Sawtooth, 180, 110, 160, 260)
const SFX_GROWL = sound3(WaveShape.Sawtooth, 120, 70, 170, 420)
const SFX_DOOR = sound3(WaveShape.Noise, 140, 90, 140, 260)
const SFX_FIREBALL = sound3(WaveShape.Sawtooth, 300, 120, 160, 300)
const SFX_SPLASH = sound3(WaveShape.Noise, 500, 80, 120, 140)

const SONG = music.stringPlayable("E3 E3 G3 E3 A3 E3 B3 A3 E3 E3 G3 E3 D4 C4 B3 G3", 140)

function play(effect: music.SoundEffect): void {
    music.play(effect, music.PlaybackMode.InBackground)
}

function playAt(set: music.SoundEffect[], dist: number): void {
    play(set[corridor.soundLevel(dist)])
}

function playEvents(w: corridor.World): void {
    for (let i = 0; i < w.events.length; i++) {
        const ev = w.events[i]
        const dist = w.eventDist[i]
        if (ev == "shoot") play(SFX_SHOOT)
        else if (ev == "empty") play(SFX_EMPTY)
        else if (ev == "step") play(SFX_STEP)
        else if (ev == "hit") {
            playAt(SFX_HIT, dist)
            controller.vibrate(40)
        } else if (ev == "kill") {
            playAt(SFX_KILL, dist)
            controller.vibrate(80)
        } else if (ev == "hurt") {
            play(SFX_HURT)
            controller.vibrate(160)
        } else if (ev == "alert") playAt(SFX_ALERT, dist)
        else if (ev == "growl") playAt(SFX_GROWL, dist)
        else if (ev == "pickup") play(SFX_PICKUP)
        else if (ev == "win") play(SFX_WIN)
        else if (ev == "door") playAt(SFX_DOOR, dist)
        else if (ev == "locked") play(SFX_LOCKED)
        else if (ev == "key") play(SFX_KEY)
        else if (ev == "blast") {
            play(SFX_BLAST)
            controller.vibrate(60)
        } else if (ev == "fireball") playAt(SFX_FIREBALL, dist)
        else if (ev == "splash") playAt(SFX_SPLASH, dist)
        else if (ev == "swap") play(SFX_SWAP)
        else if (ev == "weapon") play(SFX_WEAPON)
        else if (ev == "unlock") play(SFX_UNLOCK)
        else if (ev == "secret") {
            play(SFX_SECRET)
            controller.vibrate(120)
        } else if (ev == "dead") {
            play(SFX_DEAD)
            controller.vibrate(400)
        }
    }
}

applyPalette()
scene.setBackgroundColor(15)
corridorRender.init()

const FPS_LOG_MS = 5000

let session: corridor.Session = null
let world = titleWorld()
let view = new corridorRender.View()
view.showFps = SHOW_FPS
const keys = new corridor.Input()
const pad = new corridor.Pad()
let last = game.runtime()
let fpsLog = 0
const MUSIC_KEY = "rc_music"

function readSetting(key: string): number {
    return settings.exists(key) ? settings.readNumber(key) : 0
}

const records = corridor.loadRecords(readSetting)
view.records = corridor.recordLines(records)
let musicOn = !settings.exists(MUSIC_KEY) || settings.readNumber(MUSIC_KEY) == 1

function setMusic(on: boolean): void {
    musicOn = on
    settings.writeNumber(MUSIC_KEY, on ? 1 : 0)
    if (on) music.play(SONG, music.PlaybackMode.LoopingInBackground)
    else music.stopAllSounds()
}

function noteRecords(): void {
    if (!session || !corridor.noteRun(records, session)) return
    corridor.saveRecords(records, function (key: string, value: number) {
        settings.writeNumber(key, value)
    })
    view.records = corridor.recordLines(records)
}

if (musicOn) music.play(SONG, music.PlaybackMode.LoopingInBackground)

function titleWorld(): corridor.World {
    const w = corridor.createWorld(corridor.CAMPAIGN, 0)
    w.enemies = []
    return w
}

function nextView(mode: number): corridorRender.View {
    const v = new corridorRender.View()
    v.mode = mode
    v.showFps = view.showFps
    v.colStep = view.colStep
    v.quality = view.quality
    v.menu = view.menu
    v.records = view.records
    v.session = session
    return v
}

// Every screen change melts the frame currently on screen into the next one.
function switchTo(mode: number, next: corridor.World): void {
    const v = nextView(mode)
    corridorRender.startMelt(v, screen, game.runtime())
    view = v
    world = next
    pad.aLatch = true
}

scene.createRenderable(0, function (target: Image, camera: scene.Camera) {
    corridorRender.draw(target, world, view)
})

game.onUpdate(function () {
    const now = game.runtime()
    const dt = now - last
    last = now
    corridorRender.tick(view, dt)
    corridorRender.meltTick(view, dt)
    corridorRender.adapt(view, dt)
    fpsLog += dt
    if (fpsLog >= FPS_LOG_MS) {
        fpsLog = 0
        console.log("fps " + view.fps + " q" + view.quality + " step " + view.colStep)
    }
    corridor.readPad(pad, keys, now,
        controller.up.isPressed(), controller.down.isPressed(),
        controller.left.isPressed(), controller.right.isPressed(),
        controller.A.isPressed(), controller.B.isPressed())
    if (view.meltOn) return
    if (view.mode == corridorRender.MODE_TITLE) {
        world.ang = (world.ang + 1) & (corridor.ANGLES - 1)
        const act = corridor.menuStep(view.menu, pad)
        if (act != corridor.ACT_NONE) {
            const kind = act == corridor.ACT_ENDLESS ? corridor.RUN_ENDLESS : corridor.RUN_CAMPAIGN
            session = corridor.startSession(kind, view.menu.difficulty)
            switchTo(corridorRender.MODE_PLAY, corridor.enterLevel(session))
        }
        return
    }
    if (view.mode == corridorRender.MODE_VICTORY) {
        if (pad.tapA) switchTo(corridorRender.MODE_TITLE, titleWorld())
        return
    }
    if (world.won) {
        if (!pad.tapA) return
        const more = corridor.completeLevel(session, world)
        if (!more || session.kind == corridor.RUN_ENDLESS) noteRecords()
        if (more) switchTo(corridorRender.MODE_PLAY, corridor.enterLevel(session))
        else switchTo(corridorRender.MODE_VICTORY, world)
        return
    }
    if (world.lost) {
        if (pad.tapA) switchTo(corridorRender.MODE_PLAY, corridor.enterLevel(session))
        return
    }
    if (view.pause) {
        const pause = view.pause
        const act = corridor.pauseStep(pause, pad)
        if (pause.music != musicOn) setMusic(pause.music)
        if (pause.difficulty != session.difficulty) {
            session.difficulty = pause.difficulty
            world.difficulty = pause.difficulty
        }
        if (act == corridor.PACT_RESUME) {
            view.pause = null
        } else if (act == corridor.PACT_QUIT) {
            view.pause = null
            noteRecords()
            switchTo(corridorRender.MODE_TITLE, titleWorld())
        }
        return
    }
    if (pad.longB) {
        view.pause = new corridor.Pause(musicOn, session.difficulty)
        view.mapOpen = false
        return
    }
    if (pad.tapB) view.mapOpen = !view.mapOpen
    corridor.update(world, keys, dt)
    corridorRender.react(view, world.events)
    playEvents(world)
})
