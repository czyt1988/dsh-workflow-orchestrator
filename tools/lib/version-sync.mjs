/**
 * 版本描述同步规则（发布工具共享）。
 *
 * `release:prepare` 要改的不只是 `package.json` 和 `CHANGELOG.md`，还有散落在文档里的
 * 「当前版本」「支持版本」等描述。规则集中在这里，便于：
 *
 *   - 发布脚本按文件分组应用（同一文件的多条规则必须叠加，不能互相覆盖）；
 *   - `test/release.test.mjs` 直接测「多条规则叠加」这个容易写错的行为。
 *
 * 每条规则是「文件 + 正则 + 替换」。正则匹配不到即视为失败：宁可让发布停下，
 * 也不要留下过期的版本号。
 */

/** 取 `major.minor`。 */
export function majorMinor(version) {
  return version.split('.').slice(0, 2).join('.')
}

/** 需要随版本号更新的位置。 */
export const VERSION_RULES = [
  { file: 'AGENTS.md', pattern: /当前版本 `[^`]+`/g, replacement: (version) => `当前版本 \`${version}\`` },
  {
    file: 'SECURITY.md',
    pattern: /`\d+\.\d+\.x` 阶段/g,
    replacement: (version) => `\`${majorMinor(version)}.x\` 阶段`,
  },
  {
    file: 'SECURITY.md',
    pattern: /\| \d+\.\d+\.x \| ✅ 支持 \|/g,
    replacement: (version) => `| ${majorMinor(version)}.x | ✅ 支持 |`,
  },
  {
    file: 'SECURITY.md',
    pattern: /\| < \d+\.\d+\.\d+（更早版本/g,
    replacement: (version) => `| < ${version}（更早版本`,
  },
  {
    file: 'docs/user/README.md',
    pattern: /当前版本 \*\*[^*]+\*\*/g,
    replacement: (version) => `当前版本 **${version}**`,
  },
  {
    file: 'docs/user/README.md',
    pattern: /文档对应插件版本 \*\*[^*]+\*\*/g,
    replacement: (version) => `文档对应插件版本 **${version}**`,
  },
  {
    file: 'docs/user/data-and-faq.md',
    pattern: /界面与文档对应版本 \*\*[^*]+\*\*/g,
    replacement: (version) => `界面与文档对应版本 **${version}**`,
  },
  {
    file: 'docs/user/getting-started.md',
    pattern: /插件包版本为 \*\*[^*]+\*\*/g,
    replacement: (version) => `插件包版本为 **${version}**`,
  },
  {
    file: 'docs/dev/packaging-and-release.md',
    pattern: /当前版本 `[^`]+`/g,
    replacement: (version) => `当前版本 \`${version}\``,
  },
  {
    file: 'docs/dev/packaging-and-release.md',
    pattern: /\| `version` \| `[^`]+` \|/g,
    replacement: (version) => `| \`version\` | \`${version}\` |`,
  },
]

/** 把一个文件的规则按文件分组，保持声明顺序。 */
export function groupRulesByFile(rules) {
  const grouped = new Map()
  for (const rule of rules) {
    const list = grouped.get(rule.file)
    if (list === undefined) grouped.set(rule.file, [rule])
    else list.push(rule)
  }
  return grouped
}

/**
 * 依次应用同一文件的多条规则。
 *
 * 注意：必须在上一轮结果上继续替换（而不是各自基于原文替换后再挑一个结果落盘），
 * 否则同一文件的后一条规则会把前一条的改动覆盖掉。
 *
 * @param {string} text - 文件原文。
 * @param {Array<{ pattern: RegExp, replacement: (version: string, match: string) => string }>} rules - 该文件的规则。
 * @param {string} version - 新版本号。
 * @returns {{ text: string, changes: number }}
 * @throws {Error} 某条规则匹配不到时。
 */
export function applyVersionRules(text, rules, version) {
  let result = text
  let changes = 0
  for (const rule of rules) {
    const matches = result.match(rule.pattern)
    if (matches === null || matches.length === 0) {
      throw new Error(`未匹配到 ${rule.pattern}`)
    }
    changes += matches.length
    result = result.replace(rule.pattern, (match) => rule.replacement(version, match))
  }
  return { text: result, changes }
}
