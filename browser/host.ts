// The same game the console runs. The page owns the buttons. GIVE TO AI prints the console's
// snapshots; the page posts them and writes the bridge's mailbox back. No USB, sound or vibration.
var browserStore: { [key: string]: number } = {}

function browserRead(key: string): number {
    try {
        if (typeof localStorage !== "undefined") {
            const v = localStorage.getItem(key)
            if (v != null && v !== "") return Number(v)
        }
    } catch {
        // Private mode, or no localStorage in the test VM.
    }
    return browserStore[key] || 0
}

function browserWrite(key: string, value: number): void {
    browserStore[key] = value
    try {
        if (typeof localStorage !== "undefined") localStorage.setItem(key, String(value))
    } catch {
        // Same as the read.
    }
}

corridorRender.init()

let browserSession: any = null
let browserWorld = browserTitle()
let browserView = new corridorRender.View()
browserView.showFps = true
const browserKeys = new corridor.Input()
const browserPad = new corridor.Pad()
const browserScreen = image.create(160, 120)
const browserMap = image.create(160, 120)
let browserRecords = corridor.loadRecords(browserRead)
browserView.records = corridor.recordLines(browserRecords)
let browserLast = 0
let browserLink: any = null
let browserDriving = false
let browserLines: string[] = []
let browserSfx: string[] = []

function browserHear(): void {
    browserSfx = []
    const ev = browserWorld.events
    for (let i = 0; i < ev.length; i++) browserSfx.push(ev[i])
}
const browserBox: number[] = []
for (let i = 0; i < corridor.AI_BOX_SIZE; i++) browserBox.push(0)
for (let i = 0; i < corridor.AI_SIG.length; i++) browserBox[i] = corridor.AI_SIG.charCodeAt(i)

function browserTitle(): any {
    const w = corridor.createWorld(corridor.CAMPAIGN, 0)
    w.enemies = []
    return w
}

function browserEnter(): any {
    const world = corridor.enterLevel(browserSession)
    if (browserDriving) browserArm(world)
    return world
}

function browserArm(world: any): void {
    if (!browserLink) browserLink = new corridor.AiLink(1 + Math.floor(Math.random() * 30000))
    corridor.aiEnterLevel(browserLink, browserSession, world)
}

function browserGive(): void {
    browserArm(browserWorld)
    corridor.aiHandBack(browserLink, browserSession)
    browserDriving = true
    browserView.aiLine = corridor.aiStatus(browserLink)
}

function browserTake(): void {
    browserDriving = false
    browserLines.push(corridor.AI_HUMAN)
    browserView.aiLine = ""
    browserView.aiAlert = false
}

function browserNote(): void {
    if (!browserSession || !corridor.noteRun(browserRecords, browserSession)) return
    corridor.saveRecords(browserRecords, browserWrite)
    browserView.records = corridor.recordLines(browserRecords)
}

function browserSwitch(mode: number, next: any, now: number): void {
    const v = new corridorRender.View()
    v.mode = mode
    v.showFps = browserView.showFps
    v.colStep = browserView.colStep
    v.quality = browserView.quality
    v.menu = browserView.menu
    v.records = browserView.records
    v.session = browserSession
    corridorRender.startMelt(v, browserScreen, now)
    browserView = v
    browserWorld = next
    browserPad.aLatch = true
}

function browserTick(now: number, up: boolean, down: boolean, left: boolean, right: boolean, a: boolean, b: boolean): void {
    const dt = browserLast ? Math.min(100, now - browserLast) : 20
    browserLast = now
    corridorRender.tick(browserView, dt)
    corridorRender.meltTick(browserView, dt)
    corridorRender.adapt(browserView, dt)
    corridor.readPad(browserPad, browserKeys, now, up, down, left, right, a, b)
    if (!browserView.meltOn) {
        if (browserView.mode == corridorRender.MODE_TITLE) {
            browserWorld.ang = (browserWorld.ang + 1) & (corridor.ANGLES - 1)
            const act = corridor.menuStep(browserView.menu, browserPad)
            if (act != corridor.ACT_NONE) {
                const difficulty = browserView.menu.difficulty
                if (act == corridor.ACT_LEVEL) browserSession = corridor.startAtLevel(difficulty, browserView.menu.level)
                else browserSession = corridor.startSession(act == corridor.ACT_ENDLESS ? corridor.RUN_ENDLESS : corridor.RUN_CAMPAIGN, difficulty)
                browserView.menu.levels = false
                browserDriving = browserView.menu.ai
                browserSession.ai = browserDriving
                if (browserDriving) browserLink = new corridor.AiLink(1 + Math.floor(Math.random() * 30000))
                browserSwitch(corridorRender.MODE_PLAY, browserEnter(), now)
            }
        } else if (browserView.mode == corridorRender.MODE_VICTORY) {
            if (browserPad.tapA) browserSwitch(corridorRender.MODE_TITLE, browserTitle(), now)
        } else if (browserWorld.won || browserWorld.lost) {
            if (browserDriving && browserLink) {
                const end = corridor.aiEndStep(browserLink, browserWorld, dt, function (line: string) { browserLines.push(line) })
                if (end == corridor.AI_REPLAY) browserSwitch(corridorRender.MODE_PLAY, browserEnter(), now)
                else if (end == corridor.AI_ADVANCE) {
                    const more = corridor.completeLevel(browserSession, browserWorld)
                    if (!more || browserSession.kind == corridor.RUN_ENDLESS) browserNote()
                    if (more) browserSwitch(corridorRender.MODE_PLAY, browserEnter(), now)
                    else browserSwitch(corridorRender.MODE_VICTORY, browserWorld, now)
                }
            } else if (browserWorld.won && browserPad.tapA) {
                const more = corridor.completeLevel(browserSession, browserWorld)
                if (!more || browserSession.kind == corridor.RUN_ENDLESS) browserNote()
                if (more) browserSwitch(corridorRender.MODE_PLAY, browserEnter(), now)
                else browserSwitch(corridorRender.MODE_VICTORY, browserWorld, now)
            } else if (browserWorld.lost && browserPad.tapA) {
                browserSwitch(corridorRender.MODE_PLAY, browserEnter(), now)
            }
        } else if (browserView.pause) {
            const pause = browserView.pause
            const act = corridor.pauseStep(pause, browserPad)
            if (pause.difficulty != browserSession.difficulty) {
                browserSession.difficulty = pause.difficulty
                browserWorld.difficulty = pause.difficulty
            }
            if (act == corridor.PACT_RESUME) browserView.pause = null
            else if (act == corridor.PACT_PILOT) {
                browserView.pause = null
                browserPad.aLatch = true
                if (browserDriving) browserTake()
                else browserGive()
            } else if (act == corridor.PACT_QUIT) {
                browserView.pause = null
                if (browserDriving) browserTake()
                browserNote()
                browserSwitch(corridorRender.MODE_TITLE, browserTitle(), now)
            }
        } else if (browserPad.longB) {
            browserView.pause = new corridor.Pause(true, browserSession.difficulty, browserDriving)
            browserView.mapOpen = false
        } else if (browserDriving && browserLink) {
            const input = corridor.aiFrame(browserLink, browserWorld, dt, function (i: number) { return browserBox[i] })
            if (corridor.aiSnapshotDue(browserLink)) {
                const shot = corridor.aiSnapshot(browserLink, browserWorld, browserSession.difficulty)
                for (let i = 0; i < shot.length; i++) browserLines.push(shot[i])
            }
            browserView.aiLine = corridor.aiStatus(browserLink)
            browserView.aiAlert = corridor.aiAlarm(browserLink, browserWorld)
            corridor.update(browserWorld, input, dt)
            corridorRender.react(browserView, browserWorld.events)
            browserHear()
        } else {
            if (browserPad.tapB) browserView.mapOpen = !browserView.mapOpen
            browserView.aiLine = ""
            browserView.aiAlert = false
            corridor.update(browserWorld, browserKeys, dt)
            corridorRender.react(browserView, browserWorld.events)
            browserHear()
        }
    }
    corridorRender.draw(browserScreen, browserWorld, browserView)
    browserMap.fill(0)
    if (browserView.mode == corridorRender.MODE_PLAY) corridorRender.paintMap(browserMap, browserWorld)
}

var corridorBrowser = {
    screen: browserScreen,
    map: browserMap,
    palette: corridorArt.PALETTE,
    tick: browserTick,
    // Lines for the bridge since the last take: snapshots, AI HUMAN, AI WON, AI DEAD.
    takeLines: function () {
        if (browserLines.length == 0) return null
        const lines = browserLines
        browserLines = []
        return lines
    },
    // Events of the last tick: shoot, hurt, pickup, ... The page plays them once.
    takeEvents: function () {
        const ev = browserSfx
        browserSfx = []
        return ev
    },
    setBox: function (bytes: number[]) {
        if (bytes.length < 10) return
        const seq = bytes[8] | (bytes[9] << 8)
        const cur = browserBox[8] | (browserBox[9] << 8)
        if (seq == 0) return
        if (cur != 0) {
            const ahead = (seq - cur) & 0xffff
            if (ahead == 0 || ahead > 0x8000) return
        }
        for (let i = 0; i < bytes.length && i < browserBox.length; i++) browserBox[i] = bytes[i]
    },
    place: function () {
        const seq = browserBox[8] | (browserBox[9] << 8)
        return { mode: browserView.mode, x: browserWorld.x, y: browserWorld.y, hp: browserWorld.health, ai: browserDriving, seq: seq }
    },
}
