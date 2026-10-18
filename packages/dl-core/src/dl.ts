import { type SWBridgeMssage, type TabStoreCommand } from "./sw-bridge";

export interface DLConfig {
    logPrefix: string;
    registerId: string;
}

export const defaultConfig: DLConfig = {
    logPrefix: 'DL',
    registerId: ""
}

export const stringifyConfig = (config: DLConfig) => {
    let str = ''
    try {
        str = JSON.stringify(config);
    } catch (error) {
        str = ''
    }
    return str;
}

export const getDLConfigFromString = (configString: string) => {
    let _config: DLConfig | undefined = undefined
    try {
        _config = JSON.parse(configString) as DLConfig;
    } catch (error) {
        _config = undefined;
    }
    return _config;
}

type SWBridgePortListener = (data: unknown) => void;

class SWBridgePort {
    #port: MessagePort;
    listeners: SWBridgePortListener[] = [];
    #seq = 0;
    // 在飞请求表：seq → 该请求的 resolve。回包到达即取用并删除；
    // 永远等不到回包的 seq 会留在表里，随页面导航与上下文一起回收（一期不做超时）
    #pending = new Map<number, (data: unknown) => void>();
    #registerId: string;
    constructor(config: {
        registerId: string;
    }) {
        this.#registerId = config.registerId;
        const ch = new MessageChannel();
        const port = ch.port1;
        const message: SWBridgeMssage = {
            scriptId: config.registerId,
            data: null,
        }
        window.postMessage(message, '*', [ch.port2]);
        port.onmessage = (e: MessageEvent) => {
            const msg = e.data as SWBridgeMssage | undefined;
            if (!msg) return;
            const { seq, data } = msg;
            if (typeof seq === "number") {
                const resolve = this.#pending.get(seq);
                if (resolve) {
                    this.#pending.delete(seq);
                    resolve(data);
                }
                return;
            }
            // 不带 seq → 一般推送，广播给订阅方
            this.listeners.forEach(listener => listener(data));
        };
        this.#port = port;
    }
    send(data: unknown) {
        const msg: SWBridgeMssage = {
            scriptId: this.#registerId,
            data,
        }
        this.#port.postMessage(msg);
    }
    /** 发一条带 seq 的请求，Promise 在 seq 配对的回包数据上 resolve */
    call(data: unknown): Promise<unknown> {
        const seq = ++this.#seq;
        return new Promise((resolve) => {
            this.#pending.set(seq, resolve);
            const msg: SWBridgeMssage = {
                scriptId: this.#registerId,
                data,
                seq,
            }
            this.#port.postMessage(msg);
        });
    }
    on(cb: SWBridgePortListener) {
        const _listener: SWBridgePortListener = (...args) => {
            cb(...args);
        }
        const unlisten = () => {
            this.listeners = this.listeners.filter(listener => listener !== _listener);
        }
        this.listeners.push(_listener);
        return unlisten
    }
}

export class DL {
    #config: DLConfig;
    #swBridgePort: SWBridgePort;
    constructor(config: DLConfig) {
        this.#config = config;
        this.#swBridgePort = new SWBridgePort({ registerId: config.registerId });
    }
    get config() {
        const str = stringifyConfig(this.#config);
        const _config = getDLConfigFromString(str);
        return _config as DLConfig;
    }
    get log() {
        const { logPrefix } = this.config;
        const log = (message: string) => {
            console.log(`[${logPrefix}] ${message}`);
        };
        return log;
    }
    /** 取本脚本在本 tab 的标签页对象（没存过 → undefined；跨导航存活，关 tab 即焚） */
    getTab<T = unknown>(): Promise<T | undefined> {
        const cmd: TabStoreCommand = { t: "getTab" };
        return this.#swBridgePort.call(cmd) as Promise<T | undefined>;
    }
    /** 整体覆写本脚本在本 tab 的标签页对象（非结构化可克隆的值会在 postMessage 处直接抛出） */
    async saveTab(value: unknown): Promise<void> {
        const cmd: TabStoreCommand = { t: "saveTab", value };
        await this.#swBridgePort.call(cmd);
    }
}