import { DL as DLInner } from "./dl";

// `DL` 是注入体外层的挂载点（`build-user-script.ts` 里的 `var DL = undefined`）。
// 这里不声明它就只是个自由变量：打包成 IIFE 内联进注入体后，赋值落到外层那个变量上，
// 脚本正文与内核读到的是同一个对象。`declare` 只做类型标注，运行期不产生语句。
declare var DL: DLInner | undefined;
declare var registerId: string;

const mountDL = () => {
    if (!DL) {
        DL = new DLInner({
            logPrefix: 'DL',
            registerId,
        });
    }
    return DL;
}
mountDL();