#!/usr/bin/env node
/**
 * 发布前包结构自检（Post-packaging smoke check）。
 *
 * 这个脚本不启动 DSH、不安装依赖，只静态核对一个「可发布的 DSH 插件包」需要
 * 满足的结构与元数据，供本地 `npm run check` 和 GitHub Actions 使用：
 *
 *   - package.json 的元数据、scripts 与 exports 目标真实存在；
 *   - `dsh` 清单（bundle patch / client / manifestVersion）与 `files` 白名单完整；
 *   - cordis.patch.yml 的 loader 行与包名一致；
 *   - 宿主半区与浏览器半区的入口契约（Cordis 导出 / ModuleLoader 注册）；
 *   - locale 文件可解析，README、LICENSE、AGENTS.md 与文档索引等仓库必备文件齐全；
 *   - 文档引用的界面截图已随仓库提供。
 *
 * 用法：
 *   node tools/verify-package.mjs
 *
 * 退出码：0 = 全部通过；1 = 至少一项失败（失败项逐条打印）。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
let checked = 0

/** 断言一条可读的自检项。 */
function check(label, condition, detail = '') {
  checked += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    const suffix = detail === '' ? '' : ` — ${detail}`
    failures.push(`${label}${suffix}`)
    console.log(`  FAIL ${label}${suffix}`)
  }
}

/** 判断路径是否存在（文件或目录）。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 读取文本，失败时返回 undefined。 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 展开 `files` 白名单里的目录与简单 glob（只支持单层 `*`）。 */
async function expandFilesEntry(entry) {
  const absolute = join(ROOT, entry)
  if (await exists(absolute)) return [absolute]
  if (!entry.includes('*')) return []
  const directory = join(ROOT, dirname(entry))
  if (!(await exists(directory))) return []
  const pattern = entry.slice(entry.lastIndexOf('/') + 1)
  const [prefix, suffix] = pattern.split('*')
  const names = await readdir(directory)
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => join(directory, name))
}

console.log('dsh-workflow-orchestrator · 包结构自检\n')

// ---------------------------------------------------------------------------
// 1. package.json 元数据
// ---------------------------------------------------------------------------
const manifestPath = join(ROOT, 'package.json')
const manifestText = await readText(manifestPath)
check('package.json 存在且可读', manifestText !== undefined)

let manifest
try {
  manifest = JSON.parse(manifestText ?? '{}')
} catch (error) {
  failures.push(`package.json 不是合法 JSON：${error.message}`)
  manifest = {}
}
const name = manifest.name
check('package.json name 为 dsh-workflow-orchestrator', name === 'dsh-workflow-orchestrator', String(name))
check('package.json version 符合 SemVer', typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), String(manifest.version))
check('license 为 MIT', manifest.license === 'MIT', String(manifest.license))
check('type 为 module（ESM）', manifest.type === 'module', String(manifest.type))
check('engines.node 声明 >=20', typeof manifest.engines?.node === 'string' && manifest.engines.node.includes('20'), String(manifest.engines?.node))
check('repository 指向 GitHub 仓库', typeof manifest.repository?.url === 'string' && manifest.repository.url.includes('github.com/czyt1988/dsh-workflow-orchestrator'), String(manifest.repository?.url))
check('未标记 private（允许发布）', manifest.private !== true, 'package.json 里 private=true 会阻止 npm publish')
check('scripts.test 已定义', typeof manifest.scripts?.test === 'string', String(manifest.scripts?.test))
check('scripts.check 已定义', typeof manifest.scripts?.check === 'string', String(manifest.scripts?.check))
check('keywords 非空', Array.isArray(manifest.keywords) && manifest.keywords.length > 0)

// ---------------------------------------------------------------------------
// 2. DSH 插件清单
// ---------------------------------------------------------------------------
check('dsh.manifestVersion 为 1', manifest.dsh?.manifestVersion === 1, String(manifest.dsh?.manifestVersion))
check('dsh.client.platform 为 web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
const patchEntry = manifest.dsh?.bundle?.patch
check('dsh.bundle.patch 已声明', typeof patchEntry === 'string', String(patchEntry))
if (typeof patchEntry === 'string') {
  const patchPath = join(ROOT, patchEntry)
  const patch = await readText(patchPath)
  check(`bundle patch 文件存在：${patchEntry}`, patch !== undefined)
  if (patch !== undefined) {
    check('bundle patch 包含 insert 行', patch.includes('- insert:'), patchEntry)
    const rowIds = [...patch.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((match) => match[1])
    const rowNames = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((match) => match[1].trim())
    check('bundle patch 的 loader id 与包名一致', rowIds.includes('workflow-orchestrator'), rowIds.join(','))
    check('bundle patch 的 loader name 指向本包', rowNames.includes(name), rowNames.join(','))
  }
}

// ---------------------------------------------------------------------------
// 3. 入口与导出
// ---------------------------------------------------------------------------
check('main 指向 lib/index.js', manifest.main === 'lib/index.js', String(manifest.main))
check('main 文件存在', await exists(join(ROOT, manifest.main ?? 'lib/index.js')))
const hostEntry = await readText(join(ROOT, 'lib/index.js'))
check('宿主半区导出 Cordis 插件契约', hostEntry !== undefined && /\bexport const name\b/.test(hostEntry) && /\bexport const inject\b/.test(hostEntry) && /\bexport function apply\b/.test(hostEntry))

const clientPath = join(ROOT, 'lib/client.js')
const clientEntry = await readText(clientPath)
check('浏览器半区存在', clientEntry !== undefined)
check('浏览器半区通过 __ModuleLoader__ 注册', clientEntry !== undefined && clientEntry.includes('window.__ModuleLoader__.load'), 'lib/client.js')
const clientExport = manifest.exports?.['./client']
check(
  'exports["./client"] 指向 lib/client.js',
  (typeof clientExport === 'string' ? clientExport : clientExport?.default) === './lib/client.js',
  String(typeof clientExport === 'string' ? clientExport : clientExport?.default),
)

const exportEntries = Object.entries(manifest.exports ?? {})
check('exports 非空', exportEntries.length > 0)
for (const [key, target] of exportEntries) {
  const targetPath = typeof target === 'string' ? target : target?.default
  if (typeof targetPath !== 'string') {
    failures.push(`exports["${key}"] 缺少可解析的 default 目标`)
    continue
  }
  const files = await expandFilesEntry(targetPath.replace(/^\.\//, ''))
  const wildcard = targetPath.includes('*')
  check(`exports["${key}"] 目标存在：${targetPath}`, wildcard ? files.length > 0 : await exists(join(ROOT, targetPath)))
}

// ---------------------------------------------------------------------------
// 4. npm 发布白名单
// ---------------------------------------------------------------------------
const files = Array.isArray(manifest.files) ? manifest.files : []
check('files 白名单非空', files.length > 0)
check('files 包含 LICENSE', files.includes('LICENSE'))
check('files 包含 README.md', files.includes('README.md'))
for (const entry of files) {
  const matches = await expandFilesEntry(entry)
  check(`files 条目存在：${entry}`, matches.length > 0)
}

// ---------------------------------------------------------------------------
// 5. locale 与图标
// ---------------------------------------------------------------------------
for (const locale of ['zh', 'en']) {
  const text = await readText(join(ROOT, `locale/${locale}.json`))
  let parsed
  try {
    parsed = JSON.parse(text ?? '{}')
  } catch (error) {
    parsed = undefined
    failures.push(`locale/${locale}.json 不是合法 JSON：${error.message}`)
  }
  const title = parsed?.meta?.title
  const description = parsed?.meta?.description
  check(`locale/${locale}.json 提供标题与描述`, typeof title === 'string' && title !== '' && typeof description === 'string' && description !== '')
}
const icon = await readText(join(ROOT, 'icon.svg'))
check('icon.svg 是 SVG', icon !== undefined && icon.includes('<svg'))

// ---------------------------------------------------------------------------
// 6. 仓库必备文件（GitHub 发布）
// ---------------------------------------------------------------------------
const required = [
  'README.md',
  'AGENTS.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/README.md',
  'docs/user/README.md',
  'docs/dev/README.md',
  'docs/assets/images/panel-overview.png',
  '.github/workflows/ci.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
]
for (const file of required) {
  check(`必备文件存在：${file}`, await exists(join(ROOT, file)))
}

// 文档截图至少覆盖总览、属性区、执行、网关、终止与失败六类。
const imagesDir = join(ROOT, 'docs/assets/images')
if (await exists(imagesDir)) {
  const images = (await readdir(imagesDir)).filter((file) => file.endsWith('.png'))
  check('文档截图不少于 8 张', images.length >= 8, `当前 ${images.length} 张`)
} else {
  check('文档截图目录存在', false, relative(ROOT, imagesDir))
}

// ---------------------------------------------------------------------------
// 7. 版本与变更日志
// ---------------------------------------------------------------------------
const changelog = await readText(join(ROOT, 'CHANGELOG.md'))
check('CHANGELOG 记录当前版本', changelog !== undefined && changelog.includes(`[${manifest.version}]`), `期望包含 [${manifest.version}]`)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('')
if (failures.length === 0) {
  console.log(`通过：${checked} 项自检全部成功。`)
  process.exit(0)
}
console.log(`失败：${checked} 项自检中有 ${failures.length} 项未通过：`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
