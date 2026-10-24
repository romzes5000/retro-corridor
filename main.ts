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

const SFX_SHOOT = sound(WaveShape.Noise, 1800, 300, 200, 110)
const SFX_EMPTY = sound(WaveShape.Square, 160, 120, 120, 40)
const SFX_STEP = sound(WaveShape.Noise, 220, 120, 60, 30)
const SFX_HIT = sound(WaveShape.Sawtooth, 520, 140, 200, 90)
const SFX_KILL = sound(WaveShape.Sawtooth, 300, 50, 255, 320)
const SFX_HURT = sound(WaveShape.Noise, 400, 80, 255, 180)
const SFX_ALERT = sound(WaveShape.Sawtooth, 180, 110, 160, 260)
const SFX_PICKUP = sound(WaveShape.Square, 660, 1320, 160, 120)
const SFX_WIN = sound(WaveShape.Square, 440, 1760, 200, 700)
const SFX_DEAD = sound(WaveShape.Sawtooth, 400, 40, 255, 900)

function play(effect: music.SoundEffect): void {
    music.play(effect, music.PlaybackMode.InBackground)
}

function playEvents(events: string[]): void {
    for (const ev of events) {
        if (ev == "shoot") play(SFX_SHOOT)
        else if (ev == "empty") play(SFX_EMPTY)
        else if (ev == "step") play(SFX_STEP)
        else if (ev == "hit") {
            play(SFX_HIT)
            controller.vibrate(40)
        } else if (ev == "kill") {
            play(SFX_KILL)
            controller.vibrate(80)
        } else if (ev == "hurt") {
            play(SFX_HURT)
            controller.vibrate(160)
        } else if (ev == "alert") play(SFX_ALERT)
        else if (ev == "pickup") play(SFX_PICKUP)
        else if (ev == "win") play(SFX_WIN)
        else if (ev == "dead") {
            play(SFX_DEAD)
            controller.vibrate(400)
        }
    }
}

applyPalette()
scene.setBackgroundColor(15)
corridorRender.init()

let world = corridor.createWorld(corridor.CAMPAIGN, 0)
let view = new corridorRender.View()
view.showFps = SHOW_FPS
const keys = new corridor.Input()
const pad = new corridor.Pad()
let last = game.runtime()

function freshView(): corridorRender.View {
    const v = new corridorRender.View()
    v.mode = corridorRender.MODE_PLAY
    v.showFps = view.showFps
    v.colStep = view.colStep
    return v
}

function restart(): void {
    world = corridor.createWorld(corridor.CAMPAIGN, 0)
    view = freshView()
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
    corridorRender.adapt(view, dt)
    corridor.readPad(pad, keys, now,
        controller.up.isPressed(), controller.down.isPressed(),
        controller.left.isPressed(), controller.right.isPressed(),
        controller.A.isPressed(), controller.B.isPressed())
    if (view.mode == corridorRender.MODE_TITLE) {
        if (pad.tapA) {
            view.mode = corridorRender.MODE_PLAY
            pad.aLatch = true
        }
        return
    }
    if (world.won || world.lost) {
        if (pad.tapA) restart()
        return
    }
    if (pad.tapB) view.mapOpen = !view.mapOpen
    corridor.update(world, keys, dt)
    corridorRender.react(view, world.events)
    playEvents(world.events)
})
