#!/usr/bin/env node
/**
 * 发布门禁（Release gate）。
 *
 * 在打 tag 之后、往 npm 与 GitHub 发布之前运行，确认「要发布的东西」与 tag 一致：
 *
 *   - `package.json` 可解析，name / version / license / repository 齐全；
 *   - `engines.dsh` 已声明（插件市场与插件管理器都靠它判断兼容性）；
 *   - `files` 白名单包含 LICENSE、README、bundle patch、图标与 locale；
 *   - CHANGELOG 有对应版本段与日期，`[Unreleased]` 已归档，compare / release 链接指向该版本；
 *   - 传入的 tag（`--tag` / `RELEASE_TAG` / `GITHUB_REF_NAME`）与版本号一致。
 *
 * 用法：
 *   node tools/verify-release.mjs                  # 本地校验当前版本
 *   node tools/verify-release.mjs --tag v0.2.0     # CI 里带 tag 校验
 *
 * 退出码：0 = 通过；1 = 至少一项失败。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogProblems, isSemver } from './lib/changelog.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
let checked = 0

/** 断言一条可读的发布检查项。 */
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

/** 读取文本，失败时返回 undefined。 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 从命令行参数取 tag。 */
function tagArgument() {
  const index = process.argv.indexOf('--tag')
  return index === -1 ? undefined : process.argv[index + 1]
}

console.log('dsh-workflow-orchestrator · 发布门禁\n')

// ---------------------------------------------------------------------------
// 1. 清单
// ---------------------------------------------------------------------------
const manifestText = await readText(join(ROOT, 'package.json'))
check('package.json 存在且可读', manifestText !== undefined)

let manifest = {}
try {
  manifest = JSON.parse(manifestText ?? '{}')
} catch (error) {
  failures.push(`package.json 不是合法 JSON：${error.message}`)
}
const name = manifest.name
const version = manifest.version
check('name 为 dsh-workflow-orchestrator', name === 'dsh-workflow-orchestrator', String(name))
check('version 是合法 SemVer', isSemver(version), String(version))
check('license 为 MIT', manifest.license === 'MIT', String(manifest.license))
const repository = manifest.repository?.url
check('repository 指向 GitHub 仓库', typeof repository === 'string' && repository.includes('github.com/'), String(repository))

// ---------------------------------------------------------------------------
// 2. 兼容性声明
// ---------------------------------------------------------------------------
const dshRange = manifest.engines?.dsh
check(
  'engines.dsh 已声明',
  typeof dshRange === 'string' && dshRange.trim() !== '' && !dshRange.startsWith('workspace:'),
  String(dshRange),
)
check(
  'engines.dsh 是 SemVer 范围（只允许数字与范围符号）',
  typeof dshRange === 'string' && /\d/.test(dshRange) && /^[0-9A-Za-z\s<>=~^*xX.|+-]+$/.test(dshRange),
  String(dshRange),
)
check('engines.node 已声明', typeof manifest.engines?.node === 'string', String(manifest.engines?.node))
check('dsh.manifestVersion 为 1', manifest.dsh?.manifestVersion === 1, String(manifest.dsh?.manifestVersion))
check('dsh.bundle.patch 已声明', typeof manifest.dsh?.bundle?.patch === 'string', String(manifest.dsh?.bundle?.patch))
check('dsh.client.platform 为 web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))

// ---------------------------------------------------------------------------
// 3. 发布物白名单
// ---------------------------------------------------------------------------
const files = Array.isArray(manifest.files) ? manifest.files : []
for (const required of ['LICENSE', 'README.md', 'cordis.patch.yml', 'icon.svg', 'lib/index.js', 'lib/client.js']) {
  check(`files 包含 ${required}`, files.includes(required), files.join(','))
}
check('files 包含 locale', files.some((entry) => entry.startsWith('locale/')), files.join(','))
check('未标记 private', manifest.private !== true)

// ---------------------------------------------------------------------------
// 4. CHANGELOG
// ---------------------------------------------------------------------------
const changelog = await readText(join(ROOT, 'CHANGELOG.md'))
check('CHANGELOG 存在且可读', changelog !== undefined)
if (changelog !== undefined && isSemver(version)) {
  const problems = changelogProblems(changelog, version)
  for (const problem of problems) {
    checked += 1
    failures.push(problem)
    console.log(`  FAIL ${problem}`)
  }
  if (problems.length === 0) {
    checked += 1
    console.log(`  ok   CHANGELOG 的 [${version}] 段、日期、[Unreleased] 与链接均已就绪`)
  }
}

// ---------------------------------------------------------------------------
// 5. tag 与版本一致
// ---------------------------------------------------------------------------
const tag = tagArgument() ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME
if (tag === undefined) {
  console.log('  --   未提供 tag（--tag / RELEASE_TAG / GITHUB_REF_NAME），跳过 tag 比对')
} else {
  check('tag 形如 vX.Y.Z', /^v\d+\.\d+\.\d+([-+].+)?$/.test(tag), tag)
  check(`tag 与 package.json 版本一致（v${version}）`, tag === `v${version}`, tag)
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('')
if (failures.length === 0) {
  console.log(`通过：${checked} 项发布检查全部成功，可以发布 ${name}@${version}。`)
  process.exit(0)
}
console.log(`失败：${checked} 项检查中有 ${failures.length} 项未通过：`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
