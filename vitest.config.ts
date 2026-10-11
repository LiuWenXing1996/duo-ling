import { defineConfig, defaultExclude } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

// 测试基建：
// - WxtVitest() 是 vite 层插件（`@` 别名解析 / #imports 虚拟模块 / chrome.* mock（extensionApiMock）/
//   wxt+vitest globals auto-import），不要在此手配 alias。
//   ⚠️ vitest projects 模式下顶层 plugins **不下传**给各 project（实测 chrome mock 全灭），
//   必须在每个 project 的 plugins 里各放一份。
// - projects 双环境分离：
//   · logic（纯逻辑测试）：node 环境，收 `src/**/*.test.ts`，exclude 掉组件测试避免重复跑；
//   · component（UI 组件测试）：happy-dom 环境，只收组件测试文件。
// - 命名约定：组件测试文件一律 `*.component.test.ts`，与纯逻辑 `*.test.ts` 并存不冲突
//   （该约定由两个 project 的 include/exclude 共同保证）。
export default defineConfig({
  test: {
    // reka-ui 对「Dialog 无 description」的 a11y 开发提示是纯噪音：用例本来就经常
    // 故意不传 description（那正是被测场景）。该提示走 console.warn（stderr 通道），
    // onConsoleLog 返回 false 即屏蔽；⚠️ 只能放根级 test——它是 NonProjectOptions，
    // 放进 project 会被忽略（同顶层 plugins 不下传是两回事，别混）。
    onConsoleLog(log) {
      if (log.includes('Missing `Description` or `aria-describedby')) return false
    },
    // 覆盖率：**只在 `npm run test:coverage` 时生效**（采集由 `--coverage` 打开，`npm run test` 不采）。
    // ⚠️ 与 onConsoleLog 同理，coverage 属根级 NonProjectOptions —— 写进 project 会被静默忽略。
    coverage: {
      provider: 'v8',
      // text-summary 给总量，html 供逐文件下钻；不要 text —— 几百行的逐文件表会刷屏
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      // **给了 include 才是「全量口径」**：没有被任何用例加载的源文件也以 0% 进报表；
      // 不给则只统计跑到的文件，盲区正好看不见。故这行是覆盖率能当盲区地图用的前提。
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        // 上游生成 / 搬运的组件（shadcn-vue 与 ai-elements）：本仓只用不改，算进分母只稀释信号
        'src/components/ui/**',
        'src/components/ai-elements/**',
      ],
    },
    projects: [
      {
        plugins: [WxtVitest()],
        test: {
          name: 'logic',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.component.test.ts', ...defaultExclude],
        },
      },
      {
        plugins: [vue(), WxtVitest()],
        test: {
          name: 'component',
          environment: 'happy-dom',
          include: ['src/**/*.component.test.ts'],
          exclude: [...defaultExclude],
        },
      },
    ],
  },
})
