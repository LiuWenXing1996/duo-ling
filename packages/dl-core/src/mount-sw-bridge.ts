import { SWBridge } from "./sw-bridge";

const mountSWBridge = () => {
    const swBridge = new SWBridge();
    return swBridge;
}
mountSWBridge();