#!/usr/bin/env node
/**
 * CHANGELOG 解析与改写（发布工具共享）。
 *
 * 发布自动化需要三件事都以同一份 CHANGELOG 为准：归档 `[Unreleased]`、生成 GitHub Release
 * 正文、发布前校验版本标题与链接。所以解析逻辑放在这里，供 `release-prepare`、
 * `release-notes`、`verify-release` 与 `test/release.test.mjs` 共用；本模块不做 I/O。
 *
 * 只支持仓库实际使用的 Keep a Changelog 子集：
 *
 *   ## [Unreleased]
 *   ## [1.2.3] - 2026-01-31
 *   [Unreleased]: https://…/compare/v1.2.3...HEAD
 *   [1.2.3]: https://…/releases/tag/v1.2.3
 */

/** 严格 SemVer 2.0.0（含可选预发布与构建元数据）。 */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const HEADING = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/
const LINK = /^\[([^\]]+)\]:\s*(\S+)\s*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** 是否为合法 SemVer 版本号。 */
export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value)
}

/** 拆分版本号；调用方需先用 `isSemver` 校验。 */
function parts(version) {
  const match = SEMVER.exec(version)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4] ?? '').split('.').filter((part) => part !== ''),
  }
}

/** 比较两个版本号的 SemVer 优先级：返回 -1 / 0 / 1。 */
export function compareVersions(left, right) {
  const a = parts(left)
  const b = parts(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index]
    const other = b.prerelease[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumeric = /^\d+$/.test(one)
    const otherNumeric = /^\d+$/.test(other)
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1
    if (oneNumeric) return -1
    if (otherNumeric) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * 解析 CHANGELOG。
 *
 * @param {string} text - 文件全文。
 * @returns {{ eol: string, lines: string[], sections: Array<{ version: string, date: string | undefined, index: number, end: number, body: string }>, links: Map<string, string> }}
 */
export function parseChangelog(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const headings = []
  const links = new Map()
  lines.forEach((line, index) => {
    const heading = HEADING.exec(line)
    if (heading !== null) headings.push({ version: heading[1], date: heading[2], index })
    const link = LINK.exec(line)
    if (link !== null) links.set(link[1], link[2])
  })
  const sections = headings.map((heading, position) => {
    const next = headings[position + 1]
    const end = next === undefined ? lines.length : next.index
    return {
      version: heading.version,
      date: heading.date,
      index: heading.index,
      end,
      body: lines
        .slice(heading.index + 1, end)
        .join(eol)
        .trim(),
    }
  })
  return { eol, lines, sections, links }
}

/**
 * 把 `[Unreleased]` 的条目归档到新的版本标题下，并更新底部链接定义。
 *
 * @param {string} text - 原 CHANGELOG 全文。
 * @param {string} version - 本次要发布的版本号（不带 `v`）。
 * @param {string} date - 发布日期，`YYYY-MM-DD`。
 * @returns {string} 改写后的全文（换行符与原文件一致）。
 */
export function archiveRelease(text, version, date) {
  if (!isSemver(version)) throw new Error(`版本号不是合法 SemVer：${version}`)
  if (!DATE.test(date)) throw new Error(`发布日期应为 YYYY-MM-DD：${date}`)
  const changelog = parseChangelog(text)
  const unreleased = changelog.sections.find((section) => section.version === 'Unreleased')
  if (unreleased === undefined) throw new Error('CHANGELOG 缺少 `## [Unreleased]` 段')
  if (changelog.sections.some((section) => section.version === version)) {
    throw new Error(`CHANGELOG 已存在 \`## [${version}]\` 段`)
  }
  if (unreleased.body === '') throw new Error('`[Unreleased]` 没有内容，无需归档')
  const compareLink = changelog.links.get('Unreleased')
  if (compareLink === undefined) throw new Error('CHANGELOG 缺少 `[Unreleased]` 链接定义')
  const base = compareLink.slice(0, compareLink.indexOf('/compare/'))
  if (base === '') throw new Error(`[Unreleased] 链接不是 compare 形式：${compareLink}`)

  const rebuilt = [
    ...changelog.lines.slice(0, unreleased.index + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    unreleased.body,
    '',
    ...changelog.lines.slice(unreleased.end),
  ]
  while (rebuilt.length > 0 && rebuilt[rebuilt.length - 1].trim() === '') rebuilt.pop()

  const archived = rebuilt.join(changelog.eol) + changelog.eol
  const nextCompare = `${base}/compare/v${version}...HEAD`
  return archived
    .replace(`${compareLink}`, `${nextCompare}${changelog.eol}[${version}]: ${base}/releases/tag/v${version}`)
    .replace(/\n{3,}/g, (match) => match.slice(0, 2))
}

/** 取某个版本的发布正文；不存在时抛错。 */
export function releaseNotes(text, version) {
  const section = parseChangelog(text).sections.find((entry) => entry.version === version)
  if (section === undefined) throw new Error(`CHANGELOG 缺少 \`[${version}]\` 段`)
  return section.body
}

/**
 * 校验 CHANGELOG 是否处于「可以发布该版本」的状态。
 *
 * @param {string} text - CHANGELOG 全文。
 * @param {string} version - 待发布版本号。
 * @returns {string[]} 问题列表；空数组表示通过。
 */
export function changelogProblems(text, version) {
  const problems = []
  const changelog = parseChangelog(text)
  const matching = changelog.sections.filter((section) => section.version === version)
  if (matching.length === 0) {
    problems.push(`CHANGELOG 缺少 \`## [${version}]\` 段，先运行 npm run release:prepare -- ${version}`)
  } else if (matching.length > 1) {
    problems.push(`CHANGELOG 有 ${matching.length} 个 \`[${version}]\` 段`)
  }
  const section = matching[0]
  if (section !== undefined) {
    if (section.date === undefined) problems.push(`\`[${version}]\` 段缺少日期（格式 YYYY-MM-DD）`)
    if (section.body === '') problems.push(`\`[${version}]\` 段没有条目`)
  }
  const unreleased = changelog.sections.find((entry) => entry.version === 'Unreleased')
  if (unreleased !== undefined && unreleased.body !== '') {
    problems.push('`[Unreleased]` 仍有内容，先运行 npm run release:prepare 归档')
  }
  const compare = changelog.links.get('Unreleased')
  if (compare === undefined) {
    problems.push('CHANGELOG 缺少 `[Unreleased]` 链接定义')
  } else if (!compare.endsWith(`/compare/v${version}...HEAD`)) {
    problems.push(`\`[Unreleased]\` 的 compare 链接应指向 v${version}...HEAD，当前为 ${compare}`)
  }
  if (!changelog.links.has(version)) problems.push(`CHANGELOG 缺少 \`[${version}]\` 链接定义`)
  return problems
}
