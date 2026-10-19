import {
    defineMainWorldMessaging,
    type MainWorldMessenger,
} from "./messaging/main-messenger";
import { type DLProtocolMap } from "./dl-protocol";

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

export class DL {
    #config: DLConfig;
    #messaging?: MainWorldMessenger<DLProtocolMap>;
    constructor(config: DLConfig) {
        this.#config = config;
    }
    get config() {
        const str = stringifyConfig(this.#config);
        const _config = getDLConfigFromString(str);
        return _config as DLConfig;
    }
    get log() {
        const { logPrefix } = this.config;
        const log = (message: string) => {
            console.log(`[${logPrefix}]`, message);
        };
        return log;
    }
    /** 取本脚本在本 tab 的标签页对象（没存过 → undefined；跨导航存活，关 tab 即焚） */
    getTab<T = unknown>(): Promise<T | undefined> {
        return this.#messenger().sendMessage("tab.get") as Promise<T | undefined>;
    }
    /** 整体覆写本脚本在本 tab 的标签页对象（不可克隆的值会在发送前抛错） */
    async saveTab(value: unknown): Promise<void> {
        await this.#messenger().sendMessage("tab.save", value === undefined ? {} : { value });
    }
    #messenger(): MainWorldMessenger<DLProtocolMap> {
        return (this.#messaging ??= defineMainWorldMessaging<DLProtocolMap>({
            scriptId: this.#config.registerId || undefined,
        }));
    }
}
