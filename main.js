'use strict'

/**
 * DeepSeek Harness 桌面应用壳（主进程）
 *
 * 职责：
 *  1. 守护本地 DSH 服务（http://127.0.0.1:3080，端口可配置）
 *     - 服务未运行时：以隐藏窗口拉起 `node apps/cli/lib/bin.js web --no-open`
 *     - 服务已运行时：直接复用（如外部已启动）
 *  2. 提供独立应用窗口加载 DSH Web UI（不再打开浏览器）
 *  3. 退出时按配置停止由本应用拉起的服务
 *
 * 配置来源（优先级从高到低）：
 *  - 环境变量 DSH_APP_*（测试/临时覆盖用）
 *  - 环境变量 DSH_APP_CONFIG 指定的 JSON 文件
 *  - 打包后：resources/config.json（可改）；便携版 exe 同目录 config.json
 *  - 开发时：项目根 config.json
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

// 测试/隔离用：把应用数据目录（日志等）指到指定位置，避免写入系统 %APPDATA%
if (process.env.DSH_APP_USER_DATA) app.setPath('userData', process.env.DSH_APP_USER_DATA)

// ---------------- 小工具 ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(msg) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'app.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ---------------- 配置 ----------------

const DEFAULTS = {
  appName: 'DeepSeek Harness',
  host: '127.0.0.1',
  port: 3080,
  harnessDir: '',
  nodeExe: 'node',
  cliEntry: 'apps\\cli\\lib\\bin.js',
  waitTimeoutMs: 180000,
  stopServiceOnExit: true,
  windowWidth: 1360,
  windowHeight: 860,
}

function configCandidates() {
  const list = []
  if (process.env.DSH_APP_CONFIG) list.push(process.env.DSH_APP_CONFIG)
  if (app.isPackaged) {
    list.push(path.join(process.resourcesPath, 'config.json'))
    list.push(path.join(path.dirname(process.execPath), 'config.json'))
  } else {
    list.push(path.join(__dirname, 'config.json'))
  }
  return list
}

function loadConfig() {
  const config = { ...DEFAULTS }
  for (const p of configCandidates()) {
    if (fs.existsSync(p)) {
      try {
        Object.assign(config, JSON.parse(fs.readFileSync(p, 'utf8')))
        config.configPath = p
        break
      } catch (e) {
        log(`config parse error ${p}: ${e.message}`)
      }
    }
  }
  const envMap = {
    DSH_APP_URL: 'url',
    DSH_APP_HOST: 'host',
    DSH_APP_PORT: 'port',
    DSH_APP_HARNESS_DIR: 'harnessDir',
    DSH_APP_NODE: 'nodeExe',
    DSH_APP_CLI: 'cliEntry',
    DSH_APP_WAIT_MS: 'waitTimeoutMs',
  }
  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env] !== undefined && process.env[env] !== '') {
      if (key === 'port' || key === 'waitTimeoutMs') config[key] = Number(process.env[env])
      else config[key] = process.env[env]
    }
  }
  if (process.env.DSH_APP_STOP_ON_EXIT !== undefined) {
    config.stopServiceOnExit = !['0', 'false', 'no'].includes(String(process.env.DSH_APP_STOP_ON_EXIT).toLowerCase())
  }
  if (!config.url) config.url = `http://${config.host}:${config.port}`
  return config
}

// ---------------- 服务管理 ----------------

let serviceChild = null
let startedByUs = false
let quitting = false

function isPortOpen(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (!done) {
        done = true
        sock.destroy()
        resolve(ok)
      }
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
    sock.connect(port, host)
  })
}

function spawnService(config) {
  return new Promise((resolve, reject) => {
    const logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logPath = path.join(logDir, `service-${stamp}.log`)
    const out = fs.createWriteStream(logPath, { flags: 'a' })
    const args = [config.cliEntry, 'web', '--no-open', '--host', config.host, '--port', String(config.port)]
    log(`spawn service: ${config.nodeExe} ${args.join(' ')} cwd=${config.harnessDir}`)
    let settled = false
    let child
    try {
      child = spawn(config.nodeExe, args, {
        cwd: config.harnessDir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out],
      })
    } catch (err) {
      reject(new Error(`启动服务失败: ${err.message}`))
      return
    }
    serviceChild = child
    startedByUs = true
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(new Error(`启动服务失败: ${err.message}`))
      }
    })
    child.on('exit', (code, signal) => {
      log(`service exited code=${code} signal=${signal}`)
      if (!settled && code !== null && code !== 0) {
        settled = true
        reject(new Error(`DSH 服务启动后立即退出（code=${code}）。日志：${logPath}`))
      }
    })
    setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ pid: child.pid, logPath })
      }
    }, 1200)
  })
}

async function ensureService(config, notify) {
  if (await isPortOpen(config.host, config.port)) {
    startedByUs = false
    return { ok: true, reused: true }
  }
  notify({ phase: 'starting', message: '正在启动 DeepSeek Harness 服务…' })
  const checks = [
    [path.join(config.harnessDir, 'package.json'), `DSH 源码目录不存在：${config.harnessDir}\n请在 config.json 中修正 harnessDir`],
    [config.nodeExe, `Node 未找到：${config.nodeExe}\n请在 config.json 中修正 nodeExe`],
    [path.join(config.harnessDir, config.cliEntry), `DSH 尚未构建：${config.cliEntry}\n请先通过「应用 → 检查 DSH 更新」构建`],
  ]
  for (const [p, msg] of checks) {
    if (!fs.existsSync(p)) return { ok: false, error: msg }
  }
  try {
    await spawnService(config)
  } catch (err) {
    return { ok: false, error: err.message }
  }
  const deadline = Date.now() + (config.waitTimeoutMs || 180000)
  while (Date.now() < deadline) {
    if (await isPortOpen(config.host, config.port)) return { ok: true, reused: false }
    await sleep(700)
  }
  return { ok: false, error: `等待服务就绪超时（${config.waitTimeoutMs}ms）。请查看服务日志` }
}

function stopService() {
  if (!serviceChild || !startedByUs) return Promise.resolve()
  const pid = serviceChild.pid
  log(`stopping service pid=${pid}`)
  return new Promise((resolve) => {
    // 1) 先尝试杀进程树（覆盖可能的子进程）
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('exit', (code) => {
      if (code === 0) {
        serviceChild = null
        return resolve()
      }
      // 2) taskkill 不可用/被拒时，退化为直接结束主进程
      try {
        process.kill(pid)
      } catch {
        /* 进程可能已退出 */
      }
      serviceChild = null
      resolve()
    })
    killer.on('error', () => {
      try {
        process.kill(pid)
      } catch {
        /* 忽略 */
      }
      serviceChild = null
      resolve()
    })
  })
}

// ---------------- 窗口 ----------------

let win = null
let mainConfig = null

function isSameOrigin(url, config) {
  try {
    const u = new URL(url)
    const base = new URL(config.url)
    return u.origin === base.origin
  } catch {
    return false
  }
}

function openExternalWindow(url) {
  const w = new BrowserWindow({
    width: 1100,
    height: 780,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'app.ico'),
    backgroundColor: '#0b0f17',
  })
  w.loadURL(url).catch(() => {})
  return w
}

function createWindow(config) {
  win = new BrowserWindow({
    width: config.windowWidth,
    height: config.windowHeight,
    minWidth: 960,
    minHeight: 620,
    icon: path.join(__dirname, 'assets', 'app.ico'),
    title: config.appName,
    backgroundColor: '#0b0f17',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'loading.html'))

  // 新窗口请求：同源 → 本窗口导航；其他 http(s) → 应用内新窗口；其余拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url, config)) {
      win.loadURL(url)
      return { action: 'deny' }
    }
    if (/^https?:/i.test(url)) openExternalWindow(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url, config)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) openExternalWindow(url)
  })

  win.on('closed', () => {
    win = null
  })
  return win
}

function buildMenu(config) {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '应用',
      submenu: [
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '检查 DSH 更新…', click: () => runDshUpdate() },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() },
      ],
    },
    { role: 'editMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function updaterScriptPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'scripts', 'update-dsh.cmd')
  return path.join(__dirname, 'scripts', 'update-dsh.cmd')
}

function runDshUpdate() {
  const updater = updaterScriptPath()
  if (!fs.existsSync(updater)) {
    dialog.showErrorBox('检查更新', `找不到更新脚本：\n${updater}`)
    return
  }
  dialog
    .showMessageBox(win, {
      type: 'question',
      title: '检查 DSH 更新',
      message: '将打开一个命令行窗口执行：git pull → 安装依赖 → 构建 DSH。\n期间请保持窗口打开，构建完成后关闭窗口，再重新打开本应用。',
      buttons: ['开始更新', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response !== 0) return
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${updater}"`], { detached: true, stdio: 'ignore' })
      child.unref()
    })
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  ipcMain.handle('open-log-dir', async () => {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    shell.openPath(dir)
  })

  app.whenReady().then(async () => {
    mainConfig = loadConfig()
    log(`config: ${JSON.stringify({ ...mainConfig, configPath: mainConfig.configPath })}`)
    buildMenu(mainConfig)
    createWindow(mainConfig)
    const notify = (status) => {
      if (win && !win.isDestroyed()) win.webContents.send('app-status', status)
    }
    const result = await ensureService(mainConfig, notify)
    if (result.ok) {
      notify({ phase: 'ready', message: '服务已就绪' })
      if (win && !win.isDestroyed()) {
        win.loadURL(mainConfig.url).catch(() => {
          // 服务刚就绪偶发未完全可用时重试一次
          setTimeout(() => {
            if (win && !win.isDestroyed()) win.loadURL(mainConfig.url).catch(() => {})
          }, 2000)
        })
      }
      // 测试钩子：就绪后自动正常退出（用于验证「退出时停止服务」）
      if (process.env.DSH_APP_TEST_EXIT_AFTER_READY) {
        setTimeout(() => {
          log('test hook: auto quit after ready')
          app.quit()
        }, 4000)
      }
    } else {
      notify({ phase: 'error', message: result.error })
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    if (startedByUs && serviceChild && mainConfig && mainConfig.stopServiceOnExit !== false) {
      event.preventDefault()
      quitting = true
      stopService().finally(() => app.quit())
    }
  })
}
