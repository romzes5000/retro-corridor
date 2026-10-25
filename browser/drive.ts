// The browser page's mailbox. Snapshots arrive as text lines, the same ones the console prints;
// the bridge writes commands back into the box the page reads each frame.
import type { LogicApi } from "../load-logic.ts"
import { Bridge, type Transport } from "../bridge/loop.ts"
import type { JevFn } from "../bridge/jev.ts"
import { encodeBox, type BoxWrite } from "../bridge/mailbox.ts"

class BoxTransport implements Transport {
    readonly box = encodeBox({ seq: 0, obs: 0, cmd: 0, a: 0, b: 0, conf: 0, latency: 0, label: "" })
    private readonly listeners: Array<(line: string) => void> = []

    onLine(listener: (line: string) => void): void {
        this.listeners.push(listener)
    }

    feed(line: string): void {
        for (const listener of this.listeners) listener(line)
    }

    async writeBox(writes: BoxWrite[]): Promise<void> {
        for (const w of writes) this.box.set(w.data, w.offset)
    }

    reset(): void {}
}

export class BrowserDrive {
    private readonly transport = new BoxTransport()
    private readonly bridge: Bridge

    constructor(api: LogicApi, jev: JevFn) {
        this.bridge = new Bridge(api, this.transport, jev)
    }

    feed(line: string): void {
        this.transport.feed(line)
    }

    idle(): Promise<void> {
        return this.bridge.idle()
    }

    box(): number[] {
        return [...this.transport.box]
    }
}
