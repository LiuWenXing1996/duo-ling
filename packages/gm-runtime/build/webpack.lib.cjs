// gm-runtime 的产物构建入口。
//
// 两条产出路径，都**不改 VM 的源码与它的 scripts/**（只在外层拿它的配置改造或筛选）：
//
//   --source=lib --entry=<name>      我们的薄 entry（entry/*.js），克隆 VM 的 `sw` config 当模板
//   --source=vm  --entry=<n1,n2>     直接用 VM 自带的 entry（如 injected / injected-web），只改 output
//
// 为什么 lib 模式挑 `sw` 那个 config 当模板：这类产物由扩展的 service worker 使用，需要 VM 构建期
// 注入的 `__.SW=1` / `__.BG=1`，以及 `common` 作用域的 safe globals（VM 的 ownWrappers 会把
// `src/common/safe-globals*.js` 的内容经 BannerPlugin 粘到产物头尾，VM 代码大量使用那些裸标识符）。
//
// 为什么 lib 模式的产物不用 `output.library` 导出：VM 的 wrapper 把整个 bundle 包进一个块作用域
// （header 开 `{`、footer 收 `}`，globals 正定义在块内），导出语句也会被封在块里、外部拿不到。
// 所以 entry 里改为运行时挂到 `globalThis`，宿主 import 产物后从那里取（见 entry/*.js）。

const path = require('node:path')
const fs = require('node:fs')

const pkgRoot = path.join(__dirname, '..')
const vmRoot = path.join(pkgRoot, 'vendor', 'violentmonkey')
const distRoot = path.join(pkgRoot, 'dist')

const args = process.argv.slice(2)
const getArg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const source = getArg('source', 'lib')
const entryNames = getArg('entry', source === 'lib' ? 'probe' : '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function fail(msg) {
  console.error(`[gm-runtime] ${msg}`)
  process.exit(1)
}

if (!['lib', 'vm'].includes(source)) fail(`--source 只支持 lib | vm（收到 ${source}）`)
if (!entryNames.length) fail('--entry= 必填（多个用逗号分隔，如 --entry=injected,injected-web）')
if (source === 'lib' && entryNames.length > 1) fail('lib 模式一次只能产出一个 entry')
if (!fs.existsSync(path.join(vmRoot, 'scripts', 'webpack.conf.js'))) {
  fail('vendor/violentmonkey 不存在 —— 按 README.md 拉取 VM 源码后再构建')
}

// ★ duo-ling 覆盖 VM 默认（不改 VM 源码仓库，fork 不可控；落在 duo-ling 构建流程里）：
// VM 把「页面右键菜单命令」(pageMenuCommands) 默认关，但 duo-ling 定位跑用户脚本、要对齐
// Tampermonkey/Greasemonkey「注册即显示」，故在打包前强制为 true。vendor 重新拉取也会自动重施加，
// 无需手动维护。若 VM 升级改了 key 名 / 默认值写法，下面会 loudly 失败，避免静默带「默认关」发布。
{
  const defaultsFile = path.join(vmRoot, 'src/common/options-defaults.js')
  if (fs.existsSync(defaultsFile)) {
    const KEY = '[kPageMenuCommands]:'
    let src = fs.readFileSync(defaultsFile, 'utf8')
    if (src.includes(`${KEY} false`)) {
      fs.writeFileSync(defaultsFile, src.replace(`${KEY} false`, `${KEY} true`))
      console.error('[gm-runtime] 覆盖 VM 默认：pageMenuCommands → true（duo-ling 行为对齐 TM/GM）')
    } else if (!src.includes(`${KEY} true`)) {
      fail(`options-defaults.js 未找到预期的 ${KEY} 默认值 —— VM 可能升级改了写法，请复查右键菜单默认开关`)
    }
  }
}

const libEntryFile = source === 'lib' ? path.join(pkgRoot, 'entry', `${entryNames[0]}.js`) : ''
if (source === 'lib' && !fs.existsSync(libEntryFile)) fail(`没有这个 entry：entry/${entryNames[0]}.js`)

process.env.MV3 = '1'
// 注入件按 production 出（更接近 VM 真实发布形态、体积小）；lib 产物用 development（便于调试）
process.env.NODE_ENV = process.env.NODE_ENV || (source === 'vm' ? 'production' : 'development')

// 坑 1（spike 记录）：VM 的 `offscreen` entry 在**配置构造期**就 `mkdirSync('<DIST>/offscreen')`
// （非 recursive）。我们并不打包它，但 require 整个配置数组时它照样执行 —— DIST 相对 cwd 解析，
// 父目录不存在会以 ENOENT 失败。
fs.mkdirSync(path.join(vmRoot, 'dist-mv3'), { recursive: true })

// 坑 2（spike 记录）：webpack 的 mkdirp 靠 `EEXIST` 忽略「目录已存在」，但本机沙箱的 fs shim
// 会把 EEXIST 包装成策略拒绝。故让 output.path 指向一个**此前不存在**的子目录 —— 每次构建只清
// 本次 entry 的子目录（不能清整个输出根，否则会把别的 entry 的产物一起删掉）。
fs.mkdirSync(distRoot, { recursive: true })
for (const name of entryNames) fs.rmSync(path.join(distRoot, name), { recursive: true, force: true })

// ★ 必须在 require VM 配置之前切 cwd：VM 的 `scripts/common.js` 里 `alias['@'] = path.resolve('src')`，
// 配置里的 entry 路径同样是相对 cwd 的。
process.chdir(vmRoot)

const webpack = require('webpack')
const configs = require(path.join(vmRoot, 'scripts', 'webpack.conf.js'))

/** @type {Array<[string, object]>} [entry 名, config] */
const picked = []

if (source === 'vm') {
  for (const name of entryNames) {
    const hit = configs.find((c) => c.entry && c.entry[name] && Object.keys(c.entry).length === 1)
    if (!hit) fail(`VM 的 scripts/webpack.conf.js 里没有这个 entry：${name}`)
    picked.push([name, hit])
  }
} else {
  const tpl = configs.find((c) => c.entry && c.entry.sw)
  if (!tpl) fail('未从 VM 的 scripts/webpack.conf.js 里找到 sw config（配置结构可能已变）')
  // 剔掉 tld 的 MV3 替换插件：VM 的 sw 走 `common/tld-mv3`，它靠 SW 里的 importScripts 去加载
  // 打包在 `public/lib/tld.js` 的 tldts。我们的 library 需要自包含（宿主侧不便再挂全局库），
  // 故保留原版 `common/tld`（直接打进 tldts）。
  tpl.plugins = tpl.plugins.filter((p) => !(p instanceof webpack.NormalModuleReplacementPlugin))
  tpl.entry = { [entryNames[0]]: libEntryFile }
  picked.push([entryNames[0], tpl])
}

for (const [name, c] of picked) {
  c.output.path = path.join(distRoot, name)
  // 保持 entry 原名：VM 的 registerInjector 硬编码 `injected-web.js` / `injected.js` 两个文件名，
  // 产物名跟着 entry 名走，注册侧就不用另做映射。
  c.output.filename = '[name].js'
  c.output.publicPath = ''
  const kind = source === 'vm' ? 'VM 自带 entry' : '模板 sw + 我们的 entry'
  console.error(`[gm-runtime] ${name} ｜ ${kind} ｜ 输出 dist/${name}/`)
}

webpack(
  picked.map(([, c]) => c),
  (err, stats) => {
    if (err) return fail(err.stack || String(err))
    const subs = Array.isArray(stats.stats) ? stats.stats : [stats]
    let errors = 0
    let warnings = 0
    const done = []
    for (const sub of subs) {
      const info = sub.toJson({ all: false, errors: true, warnings: true, assets: true })
      errors += info.errors.length
      warnings += info.warnings.length
      for (const e of info.errors.slice(0, 6)) console.error(`[gm-runtime] 错误：${e.message || e}`)
      for (const w of info.warnings.slice(0, 4)) console.error(`[gm-runtime] 警告：${w.message || w}`)
      if (!info.errors.length) done.push(...info.assets.map((a) => `${a.name} (${a.size}B)`))
    }
    if (errors) return fail(`构建失败（${errors} 个错误）`)
    console.error(`[gm-runtime] 构建完成${warnings ? `，${warnings} 个警告` : ''} → ${done.join(', ')}`)
  },
)
