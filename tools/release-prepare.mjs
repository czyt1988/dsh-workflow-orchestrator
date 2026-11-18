#!/usr/bin/env node
/**
 * 发布准备：把 `[Unreleased]` 归档成新版本，并同步所有需要改版本号的地方。
 *
 * 一次发布要动的东西分散在多个文件里（CHANGELOG 标题与链接、package.json、
 * 文档里的「当前版本」、SECURITY 的支持矩阵）。手工改容易漏，所以集中成一条命令：
 *
 *   npm run release:prepare -- 0.2.0
 *   npm run release:prepare -- 0.2.0 --dry-run
 *   npm run release:prepare -- 0.2.0 --date 2026-12-01
 *
 * 脚本只改版本号与 CHANGELOG 结构，不提交、不打 tag、不发布。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveRelease, compareVersions, isSemver, parseChangelog } from './lib/changelog.mjs'
import { applyVersionRules, groupRulesByFile, VERSION_RULES } from './lib/version-sync.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 今天的本地日期（YYYY-MM-DD）。 */
function today() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 读取命令行参数。 */
function argumentsOf(argv) {
  const options = { version: undefined, date: today(), dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--dry-run') options.dryRun = true
    else if (value === '--date') options.date = argv[(index += 1)]
    else if (!value.startsWith('-') && options.version === undefined) options.version = value
  }
  return options
}

const options = argumentsOf(process.argv.slice(2))
if (options.version === undefined) {
  console.error('用法：npm run release:prepare -- <version> [--date YYYY-MM-DD] [--dry-run]')
  process.exit(1)
}
if (!isSemver(options.version)) {
  console.error(`版本号不是合法 SemVer：${options.version}`)
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
  console.error(`发布日期应为 YYYY-MM-DD：${options.date}`)
  process.exit(1)
}

console.log(`dsh-workflow-orchestrator · 准备发布 ${options.version}\n`)

// ---------------------------------------------------------------------------
// 1. package.json：版本必须递增
// ---------------------------------------------------------------------------
const manifestPath = join(ROOT, 'package.json')
const manifestText = await readFile(manifestPath, 'utf8')
const manifest = JSON.parse(manifestText)
const current = manifest.version
if (compareVersions(options.version, current) <= 0) {
  console.error(`新版本 ${options.version} 必须大于当前版本 ${current}`)
  process.exit(1)
}
const nextManifestText = manifestText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${options.version}$2`)
if (nextManifestText === manifestText) {
  console.error('未能在 package.json 中定位 `"version"` 字段')
  process.exit(1)
}
console.log(`  ok   package.json: ${current} → ${options.version}`)

// ---------------------------------------------------------------------------
// 2. CHANGELOG：归档 [Unreleased]
// ---------------------------------------------------------------------------
const changelogPath = join(ROOT, 'CHANGELOG.md')
const changelogText = await readFile(changelogPath, 'utf8')
let nextChangelogText
try {
  nextChangelogText = archiveRelease(changelogText, options.version, options.date)
} catch (error) {
  console.error(`  FAIL CHANGELOG 归档失败：${error.message}`)
  process.exit(1)
}
const archived = parseChangelog(nextChangelogText).sections.find((section) => section.version === options.version)
const entryCount = archived.body.split(/\r?\n/).filter((line) => line.startsWith('- ')).length
console.log(`  ok   CHANGELOG.md: [Unreleased] → [${options.version}] - ${options.date}（${entryCount} 条）`)

// ---------------------------------------------------------------------------
// 3. 文档里的版本描述（同一文件的多条规则要叠加）
// ---------------------------------------------------------------------------
const writes = [
  { path: manifestPath, before: manifestText, after: nextManifestText },
  { path: changelogPath, before: changelogText, after: nextChangelogText },
]

for (const [file, rules] of groupRulesByFile(VERSION_RULES)) {
  const path = join(ROOT, file)
  const before = await readFile(path, 'utf8')
  let result
  try {
    result = applyVersionRules(before, rules, options.version)
  } catch (error) {
    console.error(`  FAIL ${file}: ${error.message}`)
    process.exit(1)
  }
  console.log(`  ok   ${file}: ${result.changes} 处版本描述已同步`)
  if (result.text !== before) writes.push({ path, before, after: result.text })
}

// ---------------------------------------------------------------------------
// 4. 落盘
// ---------------------------------------------------------------------------
if (options.dryRun) {
  console.log('\n--dry-run：未写入任何文件。')
  process.exit(0)
}
for (const write of writes) await writeFile(write.path, write.after, 'utf8')
console.log(`\n已写入 ${writes.length} 个文件。下一步：`)
console.log('  1. npm test && npm run check')
console.log(`  2. git add -A && git commit -m "chore(release): v${options.version}"`)
console.log(`  3. git tag v${options.version} && git push origin main v${options.version}`)
