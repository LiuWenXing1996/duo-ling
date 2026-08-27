import { describe, expect, it } from 'vitest'
import { isAllowedToolFile } from './tool-files'

describe('isAllowedToolFile（工具目录文件白名单）', () => {
  it('放行根级固定文件', () => {
    expect(isAllowedToolFile('index.html')).toBe(true)
    expect(isAllowedToolFile('meta.json')).toBe(true)
    expect(isAllowedToolFile('archive.md')).toBe(true)
  })

  it('放行白名单子目录内的任意文件（含嵌套）', () => {
    expect(isAllowedToolFile('js/main.js')).toBe(true)
    expect(isAllowedToolFile('js/lib/util.js')).toBe(true)
    expect(isAllowedToolFile('css/style.css')).toBe(true)
    expect(isAllowedToolFile('css/themes/dark.css')).toBe(true)
    expect(isAllowedToolFile('assets/logo.png')).toBe(true)
    expect(isAllowedToolFile('assets/img/bg.jpg')).toBe(true)
  })

  it('容忍 ./ 前缀与反斜杠分隔', () => {
    expect(isAllowedToolFile('./js/main.js')).toBe(true)
    expect(isAllowedToolFile('js\\main.js')).toBe(true)
  })

  it('拒绝越界 / 版本库 / 非白名单根文件', () => {
    expect(isAllowedToolFile('../outside')).toBe(false)
    expect(isAllowedToolFile('js/../../etc/passwd')).toBe(false)
    expect(isAllowedToolFile('.git/config')).toBe(false)
    expect(isAllowedToolFile('vendor/x.js')).toBe(false)
    expect(isAllowedToolFile('root.js')).toBe(false)
    expect(isAllowedToolFile('README.md')).toBe(false)
  })

  it('拒绝空 / 非字符串', () => {
    expect(isAllowedToolFile('')).toBe(false)
    expect(isAllowedToolFile(undefined)).toBe(false)
    expect(isAllowedToolFile(null)).toBe(false)
    expect(isAllowedToolFile(123)).toBe(false)
  })
})
