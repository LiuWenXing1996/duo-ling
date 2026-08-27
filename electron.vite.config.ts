import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 主进程入口
          index: resolve('src/main/index.ts'),
          // capability 执行进程（utilityProcess.fork 需要独立的编译产物）
          'capability-worker': resolve('src/main/capability-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 主窗口 preload
          index: resolve('src/preload/index.ts'),
          // 工具页（<webview> guest）独立 preload，仅暴露 window.cap.run
          tool: resolve('src/preload/tool.ts')
        },
        // <webview> guest 是沙箱化渲染进程，其 preload 不支持 ESM 导入，
        // 必须输出为 CJS（.cjs）才能在沙箱中加载（注入 window.cap + 心跳）。
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      // 把 <webview> 视为原生自定义元素（Electron 内嵌 webContents），避免 Vue 当作组件去解析
      vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'webview' } } }),
      tailwindcss()
    ],
    css: {
      preprocessorOptions: {
        less: {
          javascriptEnabled: true
        }
      }
    }
  }
})
