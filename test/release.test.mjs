#!/usr/bin/env node
/**
 * 发布工具的单元测试。
 *
 * 这些函数决定「发布出去的东西对不对」——归档错了会丢 CHANGELOG 条目，校验漏了会把
 * 版本号与实际内容不一致的包发出去。因此和引擎/存储一样纳入 `npm test`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  archiveRelease,
  changelogProblems,
  compareVersions,
  isSemver,
  parseChangelog,
  releaseNotes,
} from '../tools/lib/changelog.mjs'
import { applyVersionRules } from '../tools/lib/version-sync.mjs'

const SAMPLE = `# Changelog

本文件记录变更。

## [Unreleased]

### Added

- 新功能 A。
- 新功能 B。

### Fixed

- 修复 C。

## [0.1.0] - 2026-11-10

### Added

- 首个版本。

[Unreleased]: https://github.com/czyt1988/dsh-workflow-orchestrator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/czyt1988/dsh-workflow-orchestrator/releases/tag/v0.1.0
`

test('parseChangelog 解析版本段、日期与链接', () => {
  const changelog = parseChangelog(SAMPLE)
  assert.deepEqual(
    changelog.sections.map((section) => section.version),
    ['Unreleased', '0.1.0'],
  )
  assert.equal(changelog.sections[0].date, undefined)
  assert.equal(changelog.sections[1].date, '2026-11-10')
  assert.match(changelog.sections[0].body, /新功能 A/)
  assert.equal(
    changelog.links.get('0.1.0'),
    'https://github.com/czyt1988/dsh-workflow-orchestrator/releases/tag/v0.1.0',
  )
})

test('archiveRelease 归档条目、清空 Unreleased 并改链接', () => {
  const archived = archiveRelease(SAMPLE, '0.2.0', '2026-11-18')
  assert.match(archived, /## \[0\.2\.0\] - 2026-11-18/)
  assert.match(archived, /新功能 A/)
  // Unreleased 段必须清空：新版本标题紧跟在它后面。
  assert.match(archived, /## \[Unreleased\]\n+## \[0\.2\.0\] - 2026-11-18/)
  // compare 链接前移到新版本，并新增 release 链接。
  assert.match(archived, /\[Unreleased\]: .*\/compare\/v0\.2\.0\.\.\.HEAD/)
  assert.match(archived, /\[0\.2\.0\]: .*\/releases\/tag\/v0\.2\.0/)
  // 旧版本仍然保留。
  assert.match(archived, /## \[0\.1\.0\] - 2026-11-10/)
  assert.doesNotMatch(archived, /\n{3,}/)

  const parsed = parseChangelog(archived)
  assert.deepEqual(
    parsed.sections.map((section) => section.version),
    ['Unreleased', '0.2.0', '0.1.0'],
  )
  assert.equal(parsed.sections[0].body, '')
})

test('archiveRelease 拒绝无内容、重复版本与非法日期', () => {
  assert.throws(() => archiveRelease(SAMPLE, '0.1.0', '2026-11-18'), /已存在/)
  assert.throws(() => archiveRelease(SAMPLE, '0.2.0', '2026/11/18'), /YYYY-MM-DD/)
  const empty = SAMPLE.replace(/### Added[\s\S]*?(?=## \[0\.1\.0\])/, '')
  assert.throws(() => archiveRelease(empty, '0.2.0', '2026-11-18'), /没有内容/)
})

test('releaseNotes 只输出指定版本段', () => {
  const archived = archiveRelease(SAMPLE, '0.2.0', '2026-11-18')
  const notes = releaseNotes(archived, '0.2.0')
  assert.match(notes, /新功能 A/)
  assert.doesNotMatch(notes, /首个版本/)
  assert.throws(() => releaseNotes(archived, '9.9.9'), /缺少/)
})

test('changelogProblems 指出未归档、缺日期与坏链接', () => {
  assert.deepEqual(changelogProblems(SAMPLE, '0.1.0'), [
    '`[Unreleased]` 仍有内容，先运行 npm run release:prepare 归档',
  ])

  const wrongLink = [
    '## [Unreleased]',
    '',
    '## [0.2.0] - 2026-11-18',
    '',
    '- 条目',
    '',
    '[Unreleased]: https://example.com/compare/v0.1.0...HEAD',
    '[0.2.0]: https://example.com/releases/tag/v0.2.0',
    '',
  ].join('\n')
  assert.deepEqual(changelogProblems(wrongLink, '0.2.0'), [
    '`[Unreleased]` 的 compare 链接应指向 v0.2.0...HEAD，当前为 https://example.com/compare/v0.1.0...HEAD',
  ])

  const archived = archiveRelease(SAMPLE, '0.2.0', '2026-11-18')
  assert.deepEqual(changelogProblems(archived, '0.2.0'), [])

  const noDate = archived.replace('## [0.2.0] - 2026-11-18', '## [0.2.0]')
  assert.deepEqual(changelogProblems(noDate, '0.2.0'), ['`[0.2.0]` 段缺少日期（格式 YYYY-MM-DD）'])
})

test('版本号解析与比较', () => {
  assert.equal(isSemver('0.2.0'), true)
  assert.equal(isSemver('v0.2.0'), false)
  assert.equal(isSemver('0.2'), false)
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.1'), 1)
  assert.equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.9'), 1)
})

test('applyVersionRules 在同一文件上叠加多条规则', () => {
  // 回归：早期实现按规则逐条「基于原文」生成结果再落盘，同一文件的后一条规则
  // 会把前一条覆盖掉，导致 SECURITY 的支持矩阵与正文版本号对不上。
  const text = '# 安全政策\n\n| 0.1.x | ✅ 支持 |\n\n本插件目前处于 `0.1.x` 阶段。\n'
  const rules = [
    { pattern: /`\d+\.\d+\.x` 阶段/g, replacement: (version) => `\`${version.split('.').slice(0, 2).join('.')}.x\` 阶段` },
    { pattern: /\| \d+\.\d+\.x \| ✅ 支持 \|/g, replacement: (version) => `| ${version.split('.').slice(0, 2).join('.')}.x | ✅ 支持 |` },
  ]
  const result = applyVersionRules(text, rules, '0.2.0')
  assert.equal(result.changes, 2)
  assert.match(result.text, /`0\.2\.x` 阶段/)
  assert.match(result.text, /\| 0\.2\.x \| ✅ 支持 \|/)
  assert.doesNotMatch(result.text, /0\.1\.x/)
})

test('applyVersionRules 在规则匹配不到时报错', () => {
  assert.throws(
    () => applyVersionRules('没有版本号', [{ pattern: /当前版本 `[^`]+`/g, replacement: () => '' }], '0.2.0'),
    /未匹配到/,
  )
})
