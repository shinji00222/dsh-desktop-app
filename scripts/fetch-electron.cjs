'use strict'

/**
 * 手动下载 Electron 二进制（沙箱环境 npm postinstall 无法运行时的替代方案）
 * 用法：node scripts/fetch-electron.cjs [版本]
 * 产物：.electron-cache/electron-<ver>-win32-x64.zip（并解压到 node_modules/electron/dist）
 */

const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const root = path.resolve(__dirname, '..')
const electronPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
const version = process.argv[2] || electronPkg.version
const zipPath = path.join(root, '.electron-cache', `electron-${version}-win32-x64.zip`)
const distDir = path.join(root, 'node_modules', 'electron', 'dist')

const MIRRORS = [
  `https://npmmirror.com/mirrors/electron/${version}/electron-v${version}-win32-x64.zip`,
  `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-win32-x64.zip`,
]

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= 5) return reject(new Error('too many redirects'))
          res.resume()
          return resolve(httpGet(new URL(res.headers.location, url).href, redirects + 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        resolve(res)
      })
      .on('error', reject)
  })
}

async function download(url, dest) {
  console.log(`downloading ${url}`)
  const res = await httpGet(url)
  const total = Number(res.headers['content-length'] || 0)
  let received = 0
  const ws = fs.createWriteStream(dest)
  res.on('data', (chunk) => {
    received += chunk.length
    if (total) process.stdout.write(`\r  ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`)
  })
  await new Promise((resolve, reject) => {
    ws.on('finish', resolve)
    ws.on('error', reject)
    res.pipe(ws)
  })
  console.log('\n  done')
}

function unzip(zipPath, destDir) {
  // 简易 zip 解压：只支持 store/deflate 的 zip（electron 发行包为 deflate，兼容）
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(zipPath)
    const entries = parseZip(buf)
    fs.mkdirSync(destDir, { recursive: true })
    for (const e of entries) {
      const out = path.join(destDir, e.name)
      if (e.name.endsWith('/')) {
        fs.mkdirSync(out, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(out), { recursive: true })
      let data = buf.subarray(e.offset, e.offset + e.compressedSize)
      if (e.method === 8) data = zlib.inflateRawSync(data)
      fs.writeFileSync(out, data)
    }
    resolve(entries.length)
  })
}

function parseZip(buf) {
  const entries = []
  let i = 0
  // 扫描 EOCD
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdPos < 0) throw new Error('not a zip (no EOCD)')
  const count = buf.readUInt16LE(eocdPos + 10)
  const cdStart = buf.readUInt32LE(eocdPos + 16)
  let p = cdStart
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    // 本地文件头：确保 data 起点正确（local header 可能带 extra）
    const lh = localOffset
    const lNameLen = buf.readUInt16LE(lh + 26)
    const lExtraLen = buf.readUInt16LE(lh + 28)
    const dataStart = lh + 30 + lNameLen + lExtraLen
    entries.push({ name, method, compressedSize: csize, offset: dataStart })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function main() {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  const already = fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100 * 1048576
  if (!already) {
    let lastErr
    for (const url of MIRRORS) {
      try {
        await download(url, zipPath)
        lastErr = null
        break
      } catch (e) {
        console.error(`  failed: ${e.message}`)
        lastErr = e
      }
    }
    if (lastErr) throw lastErr
  } else {
    console.log(`zip already present (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB), skipping download`)
  }
  console.log(`extracting to ${distDir}`)
  const n = await unzip(zipPath, distDir)
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe')
  console.log(`extracted ${n} entries`)
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
