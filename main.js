'use strict'

/**
 * DeepSeek Harness 桌面应用壳（主进程）
 *
 * 职责：
 *  1. 守护本地 DSH 服务（http://127.0.0.1:3080，端口可配置）
 *     - 服务未运行时：以隐藏窗口拉起 `node apps/cli/lib/bin.js web --no-open`
 *     - 服务已运行时：直接复用（如外部已启动）
 *     - 服务意外退出：自动重启（最多 3 次）
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
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

// 测试/隔离用：把应用数据目录（日志等）指到指定位置，避免写入系统 %APPDATA%
if (process.env.DSH_APP_USER_DATA) app.setPath('userData', process.env.DSH_APP_USER_DATA)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_RESTARTS = 3

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
  dshCommand: '%LOCALAPPDATA%\\pnpm\\bin\\dsh.cmd',
  dshVersion: '0.1.5-alpha.2',
  nodeExe: '',
  dshWorkingDir: process.env.USERPROFILE || process.cwd(),
  waitTimeoutMs: 90000,
  stopServiceOnExit: true,
  windowWidth: 1360,
  windowHeight: 860,
}

function loadConfig() {
  const config = { ...DEFAULTS }
  const candidates = []
  if (process.env.DSH_APP_CONFIG) candidates.push(process.env.DSH_APP_CONFIG)
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'config.json'))
    candidates.push(path.join(path.dirname(process.execPath), 'config.json'))
  } else {
    candidates.push(path.join(__dirname, 'config.json'))
  }
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(p, 'utf8')))
      config.configPath = p
      break
    } catch (e) {
      log(`config parse error ${p}: ${e.message}`)
    }
  }
  const envMap = {
    DSH_APP_URL: 'url',
    DSH_APP_HOST: 'host',
    DSH_APP_PORT: 'port',
    DSH_APP_COMMAND: 'dshCommand',
    DSH_APP_VERSION: 'dshVersion',
    DSH_APP_NODE: 'nodeExe',
    DSH_APP_NODE_EXE: 'nodeExe',
    DSH_APP_WORKDIR: 'dshWorkingDir',
    DSH_APP_WAIT_MS: 'waitTimeoutMs',
  }
  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env] === undefined || process.env[env] === '') continue
    config[key] = key === 'port' || key === 'waitTimeoutMs' ? Number(process.env[env]) : process.env[env]
  }
  if (process.env.DSH_APP_STOP_ON_EXIT !== undefined) {
    config.stopServiceOnExit = !['0', 'false', 'no'].includes(String(process.env.DSH_APP_STOP_ON_EXIT).toLowerCase())
  }
  // 展开配置值中的 %ENV_VAR%（如 %USERPROFILE%），仓库里不写死本机用户名/路径
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') config[k] = v.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
  }
  if (!config.url) config.url = `http://${config.host}:${config.port}`
  return config
}

function validateConfig(config) {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    return `端口配置无效：${config.port}（config.json 的 port）`
  }
  if (!config.dshCommand) return '未配置 dshCommand（config.json）'
  if (config.nodeExe && !fs.existsSync(config.nodeExe)) {
    return `Node 可执行文件不存在：${config.nodeExe}\n请在 config.json 中修正 nodeExe`
  }
  if (!config.dshWorkingDir || !fs.existsSync(config.dshWorkingDir)) {
    return `DSH 工作目录不存在：${config.dshWorkingDir}\n请在 config.json 中修正 dshWorkingDir`
  }
  const found = path.isAbsolute(config.dshCommand)
    ? fs.existsSync(config.dshCommand)
    : spawnSync('where.exe', [config.dshCommand], { encoding: 'utf8', windowsHide: true }).status === 0
  if (!found) {
    return `未找到全局 DSH 命令：${config.dshCommand}\n请先运行「更新 DSH.cmd」安装固定版本 ${config.dshVersion}`
  }
  return null
}

function buildServiceEnv(config) {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path'
  const prepend = []

  if (config.nodeExe) prepend.push(path.dirname(config.nodeExe))
  if (path.isAbsolute(config.dshCommand)) prepend.push(path.dirname(config.dshCommand))

  const seen = new Set()
  const unique = prepend.filter((dir) => {
    const key = dir.toLowerCase()
    if (seen.has(key) || !fs.existsSync(dir)) return false
    seen.add(key)
    return true
  })
  if (unique.length) {
    env[pathKey] = [...unique, env[pathKey]].filter(Boolean).join(path.delimiter)
    log(`service PATH prepend: ${unique.join(path.delimiter)}`)
  }
  return env
}

function resolveDshEntrypoint(config) {
  if (!config.nodeExe || !path.isAbsolute(config.dshCommand) || !fs.existsSync(config.dshCommand)) return null
  try {
    const commandDir = path.dirname(config.dshCommand)
    const text = fs.readFileSync(config.dshCommand, 'utf8')
    const match = text.match(/"%~dp0([^"]+@deepseek-ai\\dsh\\lib\\bin\.js)"/i)
    if (!match) return null
    const suffix = match[1].replace(/^[\\/]+/, '')
    const entrypoint = path.resolve(commandDir, suffix)
    return fs.existsSync(entrypoint) ? entrypoint : null
  } catch (err) {
    log(`resolve dsh entrypoint failed: ${err.message}`)
    return null
  }
}

// ---------------- 服务管理 ----------------

let serviceChild = null
let startedByUs = false
let quitting = false
let restartCount = 0

function isPortOpen(host, port, timeoutMs = 500) {
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

function extractServiceUrl(logPath, fallback) {
  try {
    const text = fs.readFileSync(logPath, 'utf8')
    const match = text.match(/dsh web:\s+(https?:\/\/\S+)/i)
    return match ? match[1].trim() : fallback
  } catch {
    return fallback
  }
}

function findLatestServiceUrl(config) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    const files = fs
      .readdirSync(logDir)
      .filter((name) => name.startsWith('service-') && name.endsWith('.log'))
      .sort()
      .reverse()
    for (const name of files) {
      const url = extractServiceUrl(path.join(logDir, name), config.url)
      if (url !== config.url) return url
    }
  } catch {
    /* The service may not have produced a log yet. */
  }
  return config.url
}

async function waitForServiceUrl(logPath, fallback) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const url = extractServiceUrl(logPath, fallback)
    if (url !== fallback) return url
    await sleep(100)
  }
  return fallback
}

function quoteCmdArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

function startService(config) {
  const logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logDir, `service-${stamp}.log`)
  const out = fs.createWriteStream(logPath, { flags: 'a' })
  const args = ['web', '--no-open', '--host', config.host, '--port', String(config.port)]
  const entrypoint = resolveDshEntrypoint(config)
  const serviceCommand = entrypoint ? config.nodeExe : config.dshCommand
  const serviceArgs = entrypoint ? [entrypoint, ...args] : args
  log(`spawn service: ${[serviceCommand, ...serviceArgs].map(quoteCmdArg).join(' ')} cwd=${config.dshWorkingDir}`)
  // createWriteStream 是异步打开文件（fd 初始为 null），必须等 open 事件后再 spawn，
  // 否则 spawn 会因 stdio 流的 fd 未就绪而抛错
  return new Promise((resolve, reject) => {
    out.once('error', reject)
    out.once('open', () => {
      try {
        const child = spawn(serviceCommand, serviceArgs, {
          cwd: config.dshWorkingDir,
          env: buildServiceEnv(config),
          detached: true,
          windowsHide: true,
          shell: !entrypoint,
          stdio: ['ignore', out, out],
        })
        resolve({ child, logPath })
      } catch (err) {
        reject(err)
      }
    })
  })
}

async function ensureService(config) {
  if (await isPortOpen(config.host, config.port)) {
    startedByUs = false
    config.url = findLatestServiceUrl(config)
    return { ok: true, reused: true }
  }
  const checkErr = validateConfig(config)
  if (checkErr) return { ok: false, error: checkErr }
  notify({ phase: 'starting', message: '正在启动 DeepSeek Harness 服务…' })
  let exited = null
  let svc
  try {
    svc = await startService(config)
  } catch (err) {
    log(`startService failed: ${err.message}`)
    return { ok: false, error: `启动服务失败：${err.message}\n请查看日志` }
  }
  serviceChild = svc.child
  startedByUs = true
  svc.child.on('error', (err) => {
    log(`service error: ${err.message}`)
    exited = { code: -1, signal: err.message }
  })
  svc.child.on('exit', (code, signal) => {
    log(`service exited code=${code} signal=${signal}`)
    exited = { code, signal }
    handleServiceExit(code, signal)
  })
  const deadline = Date.now() + (config.waitTimeoutMs || 90000)
  while (Date.now() < deadline) {
    if (exited) return { ok: false, error: `DSH 服务未能保持运行（${describeExit(exited)}）\n请通过「应用 → 检查 DSH 更新」修复或查看日志` }
    if (await isPortOpen(config.host, config.port)) {
      config.url = await waitForServiceUrl(svc.logPath, config.url)
      return { ok: true, reused: false }
    }
    await sleep(300)
  }
  return { ok: false, error: `等待服务就绪超时（${config.waitTimeoutMs}ms）\n请查看日志` }
}

function describeExit({ code, signal }) {
  return code !== null && code !== -1 ? `code=${code}` : `signal=${signal}`
}

/** 服务意外退出时的守护：自动重启（最多 MAX_RESTARTS 次），成功后重置计数 */
function handleServiceExit(code, signal) {
  if (quitting || !startedByUs) return
  if (restartCount >= MAX_RESTARTS) {
    notify({
      phase: 'error',
      message: `DSH 服务连续异常退出（已自动重启 ${MAX_RESTARTS} 次），请查看日志`,
    })
    return
  }
  restartCount++
  notify({ phase: 'starting', message: `DSH 服务意外退出（${describeExit({ code, signal })}），2 秒后自动重启（${restartCount}/${MAX_RESTARTS}）…` })
  setTimeout(async () => {
    if (quitting) return
    const result = await ensureService(mainConfig)
    if (result.ok) {
      restartCount = 0
      if (win && !win.isDestroyed()) loadApp(mainConfig)
    } else {
      notify({ phase: 'error', message: result.error })
    }
  }, 2000)
}

function stopService() {
  if (!serviceChild || !startedByUs) return Promise.resolve()
  const pid = serviceChild.pid
  log(`stopping service pid=${pid}`)
  return new Promise((resolve) => {
    // 1) 先尝试杀进程树（覆盖可能的子进程）
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    const fallback = () => {
      try {
        process.kill(pid)
      } catch {
        /* 进程可能已退出 */
      }
      serviceChild = null
      resolve()
    }
    killer.on('exit', (code) => {
      if (code === 0) {
        serviceChild = null
        resolve()
      } else {
        fallback()
      }
    })
    killer.on('error', fallback)
  })
}

// ---------------- 窗口 ----------------

let win = null
let mainConfig = null
let loadFailCount = 0

function notify(status) {
  if (win && !win.isDestroyed()) win.webContents.send('app-status', status)
}

function isSameOrigin(url, config) {
  try {
    return new URL(url).origin === new URL(config.url).origin
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
}

async function loadApp(config) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await win.loadURL(config.url)
      win.setTitle(config.appName)
      return true
    } catch (err) {
      log(`loadURL attempt ${attempt} failed: ${err.message}`)
      if (attempt < 3) await sleep(1500)
    }
  }
  return false
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

  // 可靠性：加载失败/渲染进程崩溃自动重载；无响应给出选择
  win.webContents.on('did-finish-load', () => {
    loadFailCount = 0
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (!isSameOrigin(url, config) || loadFailCount >= 3) return
    loadFailCount++
    log(`did-fail-load (${code}) ${desc}, retry ${loadFailCount}/3`)
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reload()
    }, 1200)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`renderer gone: ${details.reason}`)
    if (details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.reload()
      }, 1000)
    }
  })
  let unresponsivePrompt = false
  win.on('unresponsive', () => {
    if (unresponsivePrompt) return
    unresponsivePrompt = true
    dialog
      .showMessageBox(win, {
        type: 'warning',
        title: '界面无响应',
        message: '界面无响应，是否重新加载？',
        buttons: ['重新加载', '继续等待'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        unresponsivePrompt = false
        if (response === 0 && win && !win.isDestroyed()) win.webContents.reload()
      })
  })
  win.on('responsive', () => {
    unresponsivePrompt = false
  })

  win.on('closed', () => {
    win = null
  })
}

// ---------------- 菜单 ----------------

function openLogDir() {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  shell.openPath(dir)
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
        { label: '打开日志目录', click: () => openLogDir() },
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

function runDshUpdate() {
  const updater = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'update-dsh.cmd')
    : path.join(__dirname, 'scripts', 'update-dsh.cmd')
  if (!fs.existsSync(updater)) {
    dialog.showErrorBox('检查更新', `找不到更新脚本：\n${updater}`)
    return
  }
  dialog
    .showMessageBox(win, {
      type: 'question',
      title: '检查 DSH 更新',
      message: `将打开一个命令行窗口安装固定版 DSH ${config.dshVersion}，并在更新前备份本地数据。\n完成后重新打开本应用即可。`,
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  ipcMain.handle('open-log-dir', () => openLogDir())

  app.whenReady().then(async () => {
    mainConfig = loadConfig()
    log(`config: ${JSON.stringify({ ...mainConfig, configPath: mainConfig.configPath })}`)
    buildMenu(mainConfig)
    createWindow(mainConfig)
    const result = await ensureService(mainConfig)
    if (result.ok) {
      notify({ phase: 'ready', message: '服务已就绪' })
      if (win && !win.isDestroyed()) loadApp(mainConfig)
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
