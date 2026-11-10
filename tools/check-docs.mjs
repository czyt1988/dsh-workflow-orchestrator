#!/usr/bin/env node
/**
 * 文档自检（Docs lint）。
 *
 * 在 CI 与本地 `npm run check` 中运行，保证「文档里的东西都是真的」：
 *
 *   - 每个相对链接与图片都指向真实存在的文件；
 *   - 每个 Mermaid 代码块都有语言标注、内容非空且闭合；
 *   - 文档里不出现本机绝对路径、token / Cookie、私钥等不该公开的内容；
 *   - 文档引用的截图都位于 docs/assets/images/ 且存在。
 *
 * 用法：
 *   node tools/check-docs.mjs
 *
 * 退出码：0 = 通过；1 = 存在失效链接或违规内容。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKIP_DIRS = new Set(['node_modules', '.git', '.e2e', '.e2e-home', '.probe', 'internal', '.recovery'])

const failures = []
let documents = 0
let linksChecked = 0
let imagesChecked = 0
let mermaidBlocks = 0

/** 递归收集需要检查的 Markdown 文件。 */
async function collectMarkdown(directory, out = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collectMarkdown(join(directory, entry.name), out)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(join(directory, entry.name))
    }
  }
  return out
}

/** 路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const lineCountCache = new Map()

/** 行数缓存：用于校验 `#L12` / `#L12-L30` 形式的源码行号锚点。 */
async function lineCount(path) {
  if (lineCountCache.has(path)) return lineCountCache.get(path)
  let count = 0
  try {
    count = (await readFile(path, 'utf8')).split(/\r?\n/).length
  } catch {
    count = 0
  }
  lineCountCache.set(path, count)
  return count
}

/** 文档中禁止出现的本机 / 敏感内容。 */
const FORBIDDEN = [
  { pattern: /[A-Z]:\\(?:src|projects|repos|workspace|work)\\[^\s)"'`]+/i, label: '本机工作目录绝对路径' },
  { pattern: /C:\\Users\\(?!<|%|\$)[^\\\s)/]+/i, label: '本机用户目录路径（C:\\Users\\…）' },
  { pattern: /[A-Z]:\\Program Files\\/i, label: '本机安装路径（…\\Program Files\\）' },
  { pattern: /[?&]token=[A-Za-z0-9_-]{8,}/i, label: 'URL 中的访问 token' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i, label: 'Bearer 凭据' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, label: '私钥' },
]

/** 解析并检查一篇文档。 */
async function checkDocument(file) {
  const text = await readFile(file, 'utf8')
  const rel = relative(ROOT, file)
  documents += 1

  // ---- 1. 计算「非代码」文本：围栏代码块与行内代码不应被当成链接 ----------
  const lines = text.split(/\r?\n/)
  const maskLines = []
  let fenceMarker
  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)([^\s`]*)\s*$/)
    if (fence !== null) {
      if (fenceMarker === undefined) fenceMarker = fence[1]
      else if (fence[1] === fenceMarker) fenceMarker = undefined
      maskLines.push('')
      continue
    }
    maskLines.push(fenceMarker === undefined ? line : '')
  }
  // 行内代码：`...` / ``...`` 用空格替换，保留链接扫描的其余内容。
  const prose = maskLines.join('\n').replace(/(`+)[^`\n]*?\1/g, (span) => ' '.repeat(span.length))

  // ---- 2. 相对链接与图片 -------------------------------------------------
  const linkPattern = /(!?)\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/g
  for (const match of prose.matchAll(linkPattern)) {
    const isImage = match[1] === '!'
    const target = match[3]
    if (/^(?:https?:|mailto:|#|\/\/)/i.test(target)) continue
    if (target.startsWith('/')) {
      failures.push(`${rel}: 链接应使用相对路径，而不是根路径 ${target}`)
      continue
    }
    const withoutFragment = target.split('#')[0]
    if (withoutFragment === '') continue
    const resolved = resolve(dirname(file), decodeURIComponent(withoutFragment))
    linksChecked += 1
    if (!(await exists(resolved))) {
      failures.push(`${rel}: 链接目标不存在 ${target}`)
      continue
    }
    // 校验 `#L12` / `#L12-L30` 行号锚点是否落在文件范围内。
    const fragment = target.includes('#') ? decodeURIComponent(target.slice(target.indexOf('#') + 1)) : ''
    const anchor = fragment.match(/^L(\d+)(?:-L?(\d+))?$/)
    if (anchor !== null) {
      const total = await lineCount(resolved)
      const startLine = Number(anchor[1])
      const endLine = anchor[2] === undefined ? startLine : Number(anchor[2])
      if (startLine < 1 || endLine > total || startLine > endLine) {
        failures.push(`${rel}: 行号锚点超出文件范围 ${target}（文件共 ${total} 行）`)
      }
    }
    if (isImage) {
      imagesChecked += 1
      const imagePath = relative(ROOT, resolved).replace(/\\/g, '/')
      if (!imagePath.startsWith('docs/assets/images/')) {
        failures.push(`${rel}: 文档截图应放在 docs/assets/images/ 下，当前为 ${imagePath}`)
      }
    }
  }

  // ---- 2. 禁用内容 -------------------------------------------------------
  for (const { pattern, label } of FORBIDDEN) {
    const found = text.match(pattern)
    if (found !== null) failures.push(`${rel}: 出现${label}：${found[0].slice(0, 60)}`)
  }

  // ---- 3. Mermaid 代码块 -------------------------------------------------
  let openFence
  let mermaidStart = 0
  let mermaidContent = 0
  let mermaidLanguage = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(/^\s*(```|~~~)\s*([^\s`]*)\s*$/)
    if (fence === null) {
      if (openFence !== undefined) {
        if (mermaidLanguage === 'mermaid') mermaidContent += line.trim() === '' ? 0 : 1
        continue
      }
      continue
    }
    const marker = fence[1]
    const language = fence[2]
    if (openFence === undefined) {
      openFence = marker
      mermaidLanguage = language.toLowerCase()
      mermaidStart = index + 1
      mermaidContent = 0
      continue
    }
    if (marker !== openFence) continue
    // 关闭围栏
    if (mermaidLanguage === 'mermaid') {
      mermaidBlocks += 1
      if (mermaidContent === 0) failures.push(`${rel}:${mermaidStart} Mermaid 代码块为空`)
      if (mermaidContent > 120) failures.push(`${rel}:${mermaidStart} Mermaid 图过大（${mermaidContent} 行），建议拆分`)
    }
    openFence = undefined
    mermaidLanguage = ''
  }
  if (openFence !== undefined) failures.push(`${rel}: 存在未闭合的代码围栏（从第 ${mermaidStart} 行开始）`)
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
if (!(await exists(join(ROOT, 'docs/assets/images')))) {
  failures.push('docs/assets/images/ 目录不存在')
}

const files = await collectMarkdown(ROOT)
files.sort((left, right) => left.localeCompare(right))

if (files.length === 0) {
  console.log('没有找到 Markdown 文档。')
  process.exit(1)
}

for (const file of files) await checkDocument(file)

console.log(`文档自检：扫描 ${documents} 篇 Markdown，检查 ${linksChecked} 个链接、${imagesChecked} 张图片、${mermaidBlocks} 个 Mermaid 图。`)
if (failures.length === 0) {
  console.log('通过：所有相对链接、图片、Mermaid 块与敏感内容检查均正常。')
  process.exit(0)
}
console.log(`失败：发现 ${failures.length} 个问题：`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
