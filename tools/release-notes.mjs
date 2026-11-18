#!/usr/bin/env node
/**
 * 从 CHANGELOG 生成 GitHub Release 正文。
 *
 * Release 工作流用它在发布时取当前版本的条目，避免正文与仓库里的 CHANGELOG 各写一份；
 * 本地也可以用来看「这次要发什么」。
 *
 * 用法：
 *   node tools/release-notes.mjs              # 取 package.json 的版本
 *   node tools/release-notes.mjs v0.2.0       # 取指定 tag
 *
 * 退出码：0 = 输出成功；1 = CHANGELOG 缺少该版本段。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseNotes } from './lib/changelog.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 去掉 tag 前缀 `v`。 */
function versionOf(value) {
  return value.replace(/^v/, '')
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const argument = process.argv[2] ?? process.env.GITHUB_REF_NAME
  const version = versionOf(argument ?? manifest.version)
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const notes = releaseNotes(changelog, version)
  process.stdout.write(`${notes}\n\n---\n\n完整变更见 [CHANGELOG.md](CHANGELOG.md)。\n`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
