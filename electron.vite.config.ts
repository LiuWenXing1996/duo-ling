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
          // 工具页（WebContentsView）独立 preload，仅暴露 window.cap.run
          tool: resolve('src/preload/tool.ts')
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
    plugins: [vue(), tailwindcss()],
    css: {
      preprocessorOptions: {
        less: {
          javascriptEnabled: true
        }
      }
    }
  }
})
