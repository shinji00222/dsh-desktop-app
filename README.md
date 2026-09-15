# DeepSeek Harness 桌面应用

把 DeepSeek Harness 打包成 Windows 桌面应用：**独立窗口加载，不再打开浏览器标签页**。

应用只是一个"壳"：它负责拉起/守护全局 npm DSH 服务（默认 `http://127.0.0.1:3080`），并用独立窗口展示界面。
**它不打包 DSH 本体**，因此 DSH 更新后应用无需重新安装——打开即是新版本。
新版本 DSH 会给本地 Web 地址附加一次性 token；桌面壳会自动从服务日志读取 token URL，不要手动删掉查询参数。

## 目录结构

```
project dsh桌面应用/
├── main.js              # Electron 主进程（服务守护 + 窗口）
├── preload.js           # 安全桥（加载页状态通信）
├── loading.html         # 服务启动等待页
├── config.json          # 应用配置（路径、端口、窗口等，可改）
├── package.json         # 依赖与打包配置
├── assets/app.ico       # 应用图标
├── scripts/
│   ├── update-dsh.cmd   # 一键更新 DSH 本体（git pull + 装依赖 + 构建）
│   └── build-app.cmd    # 重新打包桌面应用（改壳代码后运行）
└── dist/                # 打包产物（DeepSeek-Harness-*-portable.exe）
```

## 使用

- **启动**：双击桌面「DeepSeek-Harness.exe」（`dist\` 里打包产物的桌面副本）。
  - 若 3080 端口已有 DSH 服务 → 直接打开窗口复用；
  - 若没有 → 自动以隐藏窗口启动服务（`dsh.cmd web --no-open`），就绪后载入界面；
  - 关闭应用时，若服务是本应用拉起的，默认一并停止（`stopServiceOnExit` 可关）。
- **首次运行注意**：DSH 数据（配置、凭据、会话）位于 `%USERPROFILE%\.dsh`，与之前浏览器方式完全一致，不会丢失。

## 更新 DSH 本体（重点）

应用内菜单「应用 → 检查 DSH 更新…」，或双击 `scripts\update-dsh.cmd`：

```
  备份 .dsh → pnpm add -g @deepseek-ai/dsh@0.1.5-alpha.2
```

完成后**重新打开应用**即是新版本，**无需重新打包/重装应用**。
更新脚本不会使用 `@latest`，因为 npm 的 latest 可能指向更旧的发行线。更新前会在 `backups\` 保存设置、会话、存储、profile 配置和旧版本记录；不会把备份提交到 Git。

需要回退时运行：

```text
scripts\rollback-dsh.cmd 0.1.5-alpha.1
```

## 配置说明（config.json）

| 字段 | 说明 |
|---|---|
| `url` / `host` / `port` | 服务地址（默认 127.0.0.1:3080） |
| `dshCommand` | 全局 DSH 命令（默认 `%LOCALAPPDATA%\\pnpm\\bin\\dsh.cmd`） |
| `dshVersion` | 当前固定的 DSH 版本 |
| `nodeExe` | 启动 DSH 时补进 PATH 的 Node 可执行文件；用于避免桌面双击环境找不到 `node` |
| `dshWorkingDir` | DSH 工作目录 |
| `waitTimeoutMs` | 等待服务就绪超时（毫秒） |
| `stopServiceOnExit` | 关闭应用时是否停止由本应用拉起的服务 |
| `windowWidth` / `windowHeight` | 窗口尺寸 |

配置文件优先级：环境变量 `DSH_APP_*` > `DSH_APP_CONFIG` 指定文件 > 打包内 `resources/config.json` > exe 同目录 `config.json`（开发时为项目根 `config.json`）。

常用环境变量覆盖：`DSH_APP_PORT`、`DSH_APP_COMMAND`、`DSH_APP_NODE`、`DSH_APP_WORKDIR`、`DSH_APP_STOP_ON_EXIT`。

## 重新打包应用

改了壳代码（main.js 等）后，双击 `scripts\build-app.cmd`，产物在 `dist\`。
打包完成后，把 `dist\` 下新的 portable exe **复制到桌面替换** `DeepSeek-Harness.exe` 即可（桌面上的就是 `dist\` 产物的副本）。
打包缓存放在项目内（`.npm-cache` / `.electron-cache` / `.electron-builder-cache`），可随时删除重下。

## 日志

应用日志与服务日志在：`%APPDATA%\DeepSeek Harness\logs\`（等待页失败时可点「打开日志目录」）。

## 常见问题

- **双击无反应**：先运行 `scripts\update-dsh.cmd` 安装固定版 DSH；看 `%APPDATA%\DeepSeek Harness\logs\app.log`。
- **服务启动失败/超时**：查看 `%APPDATA%\DeepSeek Harness\logs\service-*.log`；确认 `where dsh.cmd` 能找到全局命令。
- **双击后 code=1，但 PowerShell 手动运行正常**：检查 `config.json` 的 `nodeExe` 是否仍指向有效 Node；桌面壳会把该目录补进服务启动 PATH。
- **想用旧浏览器方式**：原启动脚本仍在 `%LOCALAPPDATA%\dsh-launcher\open-dsh.cmd`，可自行创建快捷方式。
