
export const SW_BRIDGE_WITH_SW_PORT_NAME = 'SW_BRIDGE_WITH_SW';

export interface SWBridgeMssage {
    data: unknown;
    scriptId?: string;
    seq?: number;
}

/** tab 存取命令（走 data 字段）：MAIN 侧 DL.getTab/saveTab 发出，installSWBridgeScript 里的 handler 消费 */
export interface TabStoreCommand {
    t: "getTab" | "saveTab";
    value?: unknown;
}

export class SWBridge {
    #mainPagePortMap: Map<string, MessagePort> = new Map();
    #swPort: chrome.runtime.Port;
    constructor() {
        const swPort = chrome.runtime.connect({ name: SW_BRIDGE_WITH_SW_PORT_NAME });
        this.#swPort = swPort;
        window.addEventListener('message', (e: MessageEvent) => {
            if (e.source !== window) return;
            const msg = e.data as SWBridgeMssage | undefined;
            if (!msg) return;
            const { scriptId } = msg;
            if (!scriptId) return;
            if (this.#mainPagePortMap.has(scriptId)) {
                return;
            }
            const port = e.ports[0];
            if (!port) return;
            this.#mainPagePortMap.set(scriptId, port);
            port.onmessage = (ev: MessageEvent) => {
                const msg = ev.data;
                console.log('[relay] recv', msg);
                this.#swPort.postMessage(msg);
            };
        });
        swPort.onMessage.addListener((msg) => {
            console.log('[relay] recv from SW', msg);
            if (!msg) return;
            const { scriptId } = msg as SWBridgeMssage;
            if (!scriptId) return;
            const port = this.#mainPagePortMap.get(scriptId);
            if (!port) return;
            port.postMessage(msg);
        });
    }
}