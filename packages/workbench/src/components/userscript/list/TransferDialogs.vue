<script setup lang="ts">
// 出入库弹窗集合：导出确认（单脚本 / 全部共用）、从路径导入、粘贴导入、从链接导入、导入汇总报告。
// 状态与动作全部来自 useTransfer 的 reactive 束（prop t），本组件只负责弹窗呈现与交互转发。
import {
  AlertTriangle as UiAlertTriangle,
  Check as UiCheck,
  FileQuestion as UiFileQuestion,
  LoaderCircle as UiLoaderCircle,
  X as UiX,
} from '@lucide/vue'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle,
} from '@duoling/ui/components/ui/dialog'
import { Input as UiInput } from '@duoling/ui/components/ui/input'
import { Textarea as UiTextarea } from '@duoling/ui/components/ui/textarea'
import type { TransferState } from './use-transfer'

defineProps<{
  /** 出入库域状态束（useTransfer 返回） */
  t: TransferState
  /** 脚本总数（全部导出文案用） */
  scriptsCount: number
}>()
</script>

<template>
  <!-- 导出确认弹窗：每行导出与全部导出共用；隐私提示固定在此（文案只写一处） -->
  <ui-dialog
    :open="!!t.pendingExport"
    @update:open="
      (v: boolean) => {
        if (!v) t.pendingExport = null
      }
    "
  >
    <ui-dialog-content class="max-w-md">
      <ui-dialog-title class="text-base font-semibold">
        {{ t.pendingExport?.kind === 'all' ? '导出全部脚本' : '导出脚本' }}
      </ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        <template v-if="t.pendingExport?.kind === 'all'">
          将把全部 {{ scriptsCount }} 个脚本打包为一个 zip。
        </template>
        <template v-else>
          将把「{{ t.pendingExport?.summary.name }}」打包为 zip（含全部源码文件）。
        </template>
        <span class="mt-2 block text-amber-600 dark:text-amber-400">
          导出内容包含脚本源码明文，请注意其中是否有凭据。
        </span>
      </ui-dialog-description>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button variant="ghost" size="sm" @click="t.pendingExport = null">取消</ui-button>
        <ui-button size="sm" :disabled="t.exporting" @click="t.confirmExport"> 导出 </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>

  <!-- 从路径导入：手输 / 粘贴本地 zip 的绝对路径。取字节走 fetch('file:///…')，
       之后与文件选择器共用同一条导入动线（见 use-transfer 的 confirmPathImport） -->
  <ui-dialog
    :open="t.pathImportOpen"
    @update:open="
      (v: boolean) => {
        if (!v) t.pathImportOpen = false
      }
    "
  >
    <ui-dialog-content class="max-w-lg">
      <ui-dialog-title class="text-base font-semibold">从路径导入</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        填本地 zip 导入包的绝对路径（以 / 开头）。
      </ui-dialog-description>
      <div class="mt-3">
        <!-- placeholder 只作**动作型**轻提示，不给示例路径：示例（如 /Users/…/x.zip）
             长得像一个已填好的值，会让人直接去点「导入」，而按钮此刻正是灰的。
             要填什么由上方说明句交代，这里只提示「怎么填」 -->
        <ui-input
          v-model="t.importPath"
          placeholder="粘贴或输入绝对路径"
          aria-label="导入包文件路径"
          spellcheck="false"
          autocomplete="off"
          :disabled="t.importing"
          @keydown.enter="t.confirmPathImport"
        />
        <p v-if="t.pathError" class="mt-2 whitespace-pre-wrap break-all text-xs text-destructive">
          {{ t.pathError }}
        </p>
        <!-- 开关未开：常驻提示 + 引导入口。文案与点「导入」后的报错**是同一句**
             （共用 FILE_ACCESS_OFF_HINT），两处不一致会让人以为是两个问题 -->
        <div
          v-if="t.fileAccessAllowed === false"
          class="mt-2 rounded-md border border-amber-500/40 p-2"
        >
          <p class="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
            <ui-alert-triangle class="mt-px size-3.5 shrink-0" />
            <span>{{ t.FILE_ACCESS_OFF_HINT }}</span>
          </p>
          <!-- 步骤与「打开扩展管理页」按钮都收在引导标签页，这里只给入口（与可用性横幅同一套） -->
          <ui-button
            type="button"
            variant="outline"
            size="xs"
            class="mt-2"
            data-testid="open-guide-file-access"
            @click="t.goToGuide"
          >
            查看启用引导
          </ui-button>
        </div>
      </div>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button
          variant="ghost"
          size="sm"
          :disabled="t.importing"
          @click="t.pathImportOpen = false"
        >
          取消
        </ui-button>
        <ui-button
          size="sm"
          :disabled="t.importing || !t.importPath.trim()"
          @click="t.confirmPathImport"
        >
          <ui-loader-circle v-if="t.importing" class="size-3.5 animate-spin" />
          {{ t.importing ? '导入中…' : '导入' }}
        </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>

  <!-- 粘贴导入：把脚本源码直接粘进来落成一个脚本。解析与落盘都在 offscreen 单写方，
       成功后与 zip 导入共用同一份汇总报告与「刚导入 · 未启用」标 -->
  <ui-dialog
    :open="t.pasteImportOpen"
    @update:open="
      (v: boolean) => {
        if (!v) t.pasteImportOpen = false
      }
    "
  >
    <!-- 高度上限：DialogContent 是「视口居中 + 固定定位」，自身不封顶 ——
         窗口矮的时候光靠上面的固定高粘贴框仍可能顶出视口，这里再兜一层（超高则在弹窗内滚动） -->
    <ui-dialog-content class="max-h-[calc(100vh-2rem)] max-w-lg overflow-y-auto">
      <ui-dialog-title class="text-base font-semibold">粘贴导入</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        粘贴脚本全文；带 // ==UserScript== 块时，名称与匹配规则取其声明。
      </ui-dialog-description>
      <div class="mt-3">
        <!-- placeholder 只作**动作型**轻提示、不给示例源码：示例长得像已填好的内容，
             会让人以为框里已经装好脚本了（与「从路径导入」同一个坑）。
             高度必须**固定 + 自身滚动**：Textarea 组件自带 field-sizing-content（高度随内容增长），
             粘一段长脚本就会把弹窗撑到超出视口、标题与按钮全被顶出去 —— 不封顶不行。 -->
        <ui-textarea
          v-model="t.pasteCode"
          class="field-sizing-fixed h-40 resize-y overflow-y-auto font-mono text-xs"
          placeholder="粘贴脚本源码"
          aria-label="脚本源码"
          spellcheck="false"
          :disabled="t.importing"
        />
        <p v-if="t.pasteError" class="mt-2 whitespace-pre-wrap break-all text-xs text-destructive">
          {{ t.pasteError }}
        </p>
      </div>
      <ui-dialog-footer class="flex-none">
        <ui-button
          variant="ghost"
          size="sm"
          :disabled="t.importing"
          @click="t.pasteImportOpen = false"
        >
          取消
        </ui-button>
        <ui-button
          size="sm"
          :disabled="t.importing || !t.pasteCode.trim()"
          @click="t.confirmPasteImport"
        >
          <ui-loader-circle v-if="t.importing" class="size-3.5 animate-spin" />
          {{ t.importing ? '导入中…' : '导入' }}
        </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>

  <!-- 从链接导入：地址在别处（Gist / 仓库 / 静态托管的 .user.js），抓回来再落盘。
       与另外三条差一步：先取回、看清装的是什么（脚本名 / 匹配规则），再安装
       —— 外部来源先审后启（见 use-transfer 的 fetchFromLink / confirmLinkImport） -->
  <ui-dialog
    :open="t.linkImportOpen"
    @update:open="
      (v: boolean) => {
        if (!v) t.linkImportOpen = false
      }
    "
  >
    <ui-dialog-content class="max-h-[calc(100vh-2rem)] max-w-lg overflow-y-auto">
      <ui-dialog-title class="text-base font-semibold">从链接导入</ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        填脚本源码的直链（http / https），如 https://example.com/x.user.js。
      </ui-dialog-description>
      <div class="mt-3">
        <!-- placeholder 只作动作型轻提示、不给示例地址：示例长得像已填好的值，
             会让人直接去点「获取」（与「从路径导入」同一个坑） -->
        <ui-input
          v-model="t.importLink"
          data-testid="link-import-input"
          placeholder="粘贴或输入脚本地址"
          aria-label="脚本地址"
          spellcheck="false"
          autocomplete="off"
          :disabled="t.importing || t.linkFetching || !!t.fetchedCode"
          @keydown.enter="t.fetchedCode ? t.confirmLinkImport() : t.fetchFromLink()"
        />
        <p v-if="t.linkError" class="mt-2 whitespace-pre-wrap break-all text-xs text-destructive">
          {{ t.linkError }}
        </p>

        <!-- 已取回：先说清装的是什么（元数据摘要）；取回态下地址框锁住，
             要换地址得先「重新填写」 -->
        <div v-if="t.fetchedCode" class="mt-3 rounded-md border p-2">
          <p class="text-xs font-medium">
            {{ t.fetchedMeta?.name ?? '（源码未声明脚本名，导入后按自动编号取名）' }}
            <span v-if="t.fetchedMeta?.version" class="text-muted-foreground"
              >· {{ t.fetchedMeta.version }}</span
            >
            <span v-if="t.fetchedMeta?.author" class="text-muted-foreground"
              >· {{ t.fetchedMeta.author }}</span
            >
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            <template v-if="t.fetchedMeta?.matches.length"
              >匹配 {{ t.fetchedMeta.matches.length }} 条规则</template
            >
            <template v-else-if="t.fetchedMeta?.includes.length"
              >未写 @match，导入后按 @include 转换</template
            >
            <template v-else>未声明匹配规则：装上也不会注入任何页面</template>
          </p>
        </div>
      </div>
      <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
        <ui-button
          variant="ghost"
          size="sm"
          :disabled="t.importing || t.linkFetching"
          @click="t.linkImportOpen = false"
        >
          取消
        </ui-button>
        <ui-button
          v-if="t.fetchedCode"
          variant="ghost"
          size="sm"
          data-testid="link-import-refill"
          :disabled="t.importing"
          @click="t.onRefillLink"
        >
          重新填写
        </ui-button>
        <ui-button
          v-if="!t.fetchedCode"
          size="sm"
          data-testid="link-import-fetch"
          :disabled="t.linkFetching || !t.importLink.trim()"
          @click="t.fetchFromLink"
        >
          <ui-loader-circle v-if="t.linkFetching" class="size-3.5 animate-spin" />
          {{ t.linkFetching ? '获取中…' : '获取' }}
        </ui-button>
        <ui-button
          v-else
          size="sm"
          data-testid="link-import-install"
          :disabled="t.importing"
          @click="t.confirmLinkImport"
        >
          <ui-loader-circle v-if="t.importing" class="size-3.5 animate-spin" />
          {{ t.importing ? '导入中…' : '安装' }}
        </ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>

  <!-- 导入汇总报告：导入后统一展示（成功 / 失败 + 提示，以及未导入的文件） -->
  <ui-dialog
    :open="!!t.importReport"
    @update:open="
      (v: boolean) => {
        if (!v) t.importReport = null
      }
    "
  >
    <ui-dialog-content class="max-w-lg">
      <ui-dialog-title class="text-base font-semibold">
        导入完成：成功 {{ t.importReport?.succeeded }} 个，失败 {{ t.importReport?.failed }} 个
        <template v-if="t.importReport?.ignored.length"
          >，未导入 {{ t.importReport?.ignored.length }} 个文件</template
        >
      </ui-dialog-title>
      <ui-dialog-description class="text-sm text-muted-foreground">
        新导入的脚本默认停用——审过源码后再手动启用。
        <!-- 路径导入复述一下来源：文件选择器那条给不了真路径，就不显示 -->
        <span v-if="t.importedFrom" class="mt-1 block break-all text-xs"
          >来源：{{ t.importedFrom }}</span
        >
      </ui-dialog-description>
      <ul class="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
        <li
          v-for="(r, i) in t.importReport?.results"
          :key="i"
          class="flex items-start gap-2 text-xs"
        >
          <ui-check
            v-if="r.status === 'ok'"
            class="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
          <ui-x v-else class="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div class="min-w-0 flex-1">
            <p class="font-medium">{{ r.name }}</p>
            <p v-if="r.status === 'ok'" class="mt-0.5 text-muted-foreground">
              已导入 · 未启用
              <template v-if="r.duplicateOf">
                · 与现有脚本「{{ r.duplicateOf }}」内容相同（仍已导入）
              </template>
            </p>
            <p v-else class="mt-0.5 break-all text-destructive">{{ r.reason }}</p>
            <!-- 导入期提示：非阻塞警告（不阻断导入） -->
            <ul v-if="r.status === 'ok' && r.notes?.length" class="mt-1 flex flex-col gap-1">
              <li
                v-for="(n, ni) in r.notes"
                :key="ni"
                class="flex items-start gap-1 text-amber-600 dark:text-amber-400"
              >
                <ui-alert-triangle class="mt-px size-3 shrink-0" />
                <span class="min-w-0 whitespace-pre-wrap break-words">{{ n }}</span>
              </li>
            </ul>
          </div>
        </li>
      </ul>
      <template v-if="t.importReport?.ignored.length">
        <p class="mt-3 border-t pt-3 text-xs font-medium text-muted-foreground">以下文件未导入</p>
        <ul class="mt-2 flex max-h-40 flex-col gap-2 overflow-y-auto">
          <li
            v-for="(f, i) in t.importReport?.ignored"
            :key="i"
            class="flex items-start gap-2 text-xs"
          >
            <ui-file-question class="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div class="min-w-0 flex-1">
              <p class="break-all font-medium">{{ f.path }}</p>
              <p class="mt-0.5 break-all text-muted-foreground">{{ f.reason }}</p>
            </div>
          </li>
        </ul>
      </template>
      <ui-dialog-footer class="flex-none sm:justify-end">
        <ui-button size="sm" @click="t.importReport = null">好的</ui-button>
      </ui-dialog-footer>
    </ui-dialog-content>
  </ui-dialog>
</template>
