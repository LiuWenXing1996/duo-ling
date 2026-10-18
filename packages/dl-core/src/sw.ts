import { SW_BRIDGE_WITH_SW_PORT_NAME, type SWBridgeMssage } from "./sw-bridge";

export type SWBridgeManagerListener = (msg: unknown, tabId: number, cb: (data: unknown) => void) => void;

export class SWBridgeManager {
    #swBridgePorts: Map<number, chrome.runtime.Port> = new Map();
    listeners: SWBridgeManagerListener[] = [];
    constructor() {
        chrome.runtime.onConnect.addListener((port) => {
            const protName = port.name;
            if (!protName) {
                return;
            }
            if (protName !== SW_BRIDGE_WITH_SW_PORT_NAME) return;

            const tabId = port.sender?.tab?.id;
            if (tabId == null) return; // 非 tab 来源（如扩展自身页面）
            if (this.#swBridgePorts.has(tabId)) {
                return;
            }
            this.#swBridgePorts.set(tabId, port);
            // 收（中继件 → SW）
            port.onMessage.addListener((msg) => {
                console.log('[sw] 从 SWBridge 收到消息', tabId, msg);
                if (!msg) return;
                const { seq, scriptId } = msg as SWBridgeMssage;
                const cb = (data: unknown) => {
                    if (typeof seq !== "number") {
                        return
                    }
                    if (!scriptId) {
                        return
                    }
                    this.postMessage({ seq, scriptId, data }, tabId);
                }
                this.listeners.forEach(listener => listener(msg, tabId, cb));
            });

            port.onDisconnect.addListener(() => {
                this.#swBridgePorts.delete(tabId);
            });
        });
    }
    postMessage(msg: SWBridgeMssage, tabId: number) {
        this.#swBridgePorts.get(tabId)?.postMessage(msg);
    }
    onMessage(listener: SWBridgeManagerListener) {
        const _listener: SWBridgeManagerListener = (...args) => {
            listener(...args);
        }
        const unlisten = () => {
            this.listeners = this.listeners.filter(listener => listener !== _listener);
        }
        this.listeners.push(_listener);
        return unlisten
    }
}