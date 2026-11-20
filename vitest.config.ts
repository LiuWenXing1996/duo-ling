import { defineConfig, defaultExclude } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

export default defineConfig({
  test: {
    // reka-ui 对「Dialog 无 description」的 a11y 开发提示是纯噪音：用例本来就经常
    // 故意不传 description（那正是被测场景）。该提示走 console.warn（stderr 通道），
    // onConsoleLog 返回 false 即屏蔽；⚠️ 只能放根级 test——它是 NonProjectOptions，
    // 放进 project 会被忽略（同顶层 plugins 不下传是两回事，别混）。
    onConsoleLog(log) {
      if (log.includes('Missing `Description` or `aria-describedby')) return false
    },
    // 覆盖率：**只在 `pnpm run test:coverage` 时生效**（采集由 `--coverage` 打开，`pnpm run test` 不采）。
    // ⚠️ 与 onConsoleLog 同理，coverage 属根级 NonProjectOptions —— 写进 project 会被静默忽略。
    coverage: {
      provider: 'v8',
      // text-summary 给总量，html 供逐文件下钻；不要 text —— 几百行的逐文件表会刷屏
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,vue}', 'packages/{ui,workbench,popup}/src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'packages/*/src/**/*.test.ts',
        // 上游生成 / 搬运的组件（shadcn-vue 与 ai-elements）：本仓只用不改，算进分母只稀释信号
        'packages/ui/src/components/ui/**',
        'packages/ui/src/components/ai-elements/**',
      ],
    },
    projects: [
      {
        plugins: [WxtVitest()],
        test: {
          name: 'logic',
          environment: 'node',
          include: [
            'src/**/*.test.ts',
            'packages/{ui,workbench,popup}/src/**/*.test.ts',
            // 内置件的单测（registry / install）：与逻辑测试同档，node 环境直跑
            'packages/user-scripts/src/builtin/**/*.test.ts',
          ],
          exclude: ['**/*.component.test.ts', ...defaultExclude],
        },
      },
      {
        plugins: [vue(), WxtVitest()],
        test: {
          name: 'component',
          environment: 'happy-dom',
          include: [
            'src/**/*.component.test.ts',
            'packages/{ui,workbench,popup}/src/**/*.component.test.ts',
          ],
          exclude: [...defaultExclude],
        },
      },
    ],
  },
})
