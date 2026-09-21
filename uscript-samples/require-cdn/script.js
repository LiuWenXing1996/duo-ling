// ==UserScript==
// @name         require-cdn 探针
// @namespace    duoling
// @version      1.0.0
// @description  验证 @require 外部依赖被正确前置注入到 USER_SCRIPT 世界
// @match        https://example.com/*
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// ==/UserScript==

GM_registerMenuCommand('检查 jQuery 是否已注入', () => {
  const ok = typeof window.jQuery === 'function'
  console.log('[require-cdn] window.jQuery =', typeof window.jQuery, ok ? 'OK' : 'MISSING')
})
