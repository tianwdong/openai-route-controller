# Codex 部署协议

本文件供 Codex 或其他本机编码代理执行。目标是完成可回滚安装，而不是只生成建议。

## 授权边界

只有用户明确要求部署时，才可以修改 Clash 全局扩展脚本、LaunchAgent 或 Windows 计划任务。不得：

- 打印、复制、上传或提交订阅 URL、节点端点、Mihomo secret、ChatGPT 凭据或 Cookie；
- 整体覆盖含有其他应用规则的全局扩展脚本；
- 把 External Controller 绑定到非回环地址；
- 修改 Codex 账号、认证方式或无关系统网络设置；
- 在测试或影子验证失败时继续安装。

## 阶段一：只读发现

先读取 `README.md`、`AGENTS.md` 和本文件，再识别操作系统。

### macOS

```bash
sw_vers
command -v node
node --version
command -v curl
lsof -U 2>/dev/null | rg 'verge-mihomo|mihomo.*sock'
scutil --proxy
lsof -nP -iTCP -sTCP:LISTEN | rg '789[0-9]|909[0-9]'
```

验证发现的 Unix Socket：

```bash
curl --silent --show-error --unix-socket "/actual/mihomo.sock" http://localhost/version
```

### Windows

```powershell
[Environment]::OSVersion.VersionString
Get-Command node.exe
node --version
Get-Command curl.exe
Get-NetTCPConnection -State Listen | Where-Object {
  $_.LocalAddress -in @("127.0.0.1", "::1") -and $_.LocalPort -in 7897,9097
}
```

Windows 不调用 Clash Verge Rev 内部命名管道。确认用户已经在 GUI 中显式开启只绑定回环地址的 External Controller；通过 `Read-Host -AsSecureString` 获取密钥，不在输出中回显。

### 两个平台都要确认

- Clash Verge Rev／Mihomo 正在运行；
- 代理模式为规则模式；
- HTTP 代理实际地址；
- 控制通道实际地址；
- Node.js 主版本至少为 22，并优先使用仍受支持的 LTS 版本；
- 当前全局扩展脚本是否还有其他业务规则；
- 是否已经存在 `OpenAI 自动选择` 或同名服务。

## 阶段二：合并 Clash 脚本

读取 `Script.openai.js`。如果现有全局脚本仅用于 OpenAI，可以替换；如果还包含其他规则，只合并以下语义：

1. `OpenAI 自动选择` 是 `select`，候选来自允许地区；
2. 开启 `store-selected`；
3. 四个 OpenAI 域名后缀进入该组；
4. OpenAI 规则位于原有兜底规则之前；
5. 删除旧的同名 OpenAI 组，其他组保持原顺序和内容；
6. 不引入第二个自动选择器。
7. 按候选去重排序，从 `127.0.0.1:17900` 起逐个建立直接绑定节点的 mixed 探测监听器，保留其他 listener；确认端口未占用。

保存并重新应用订阅后，确认组类型为 Selector、候选数大于零。候选为空时停止，报告节点命名与 `supportedRegion` 不匹配。

## 阶段三：测试和影子验证

```bash
npm run verify
```

不得删测试、降低阈值或跳过失败。

### macOS 影子验证

```bash
SHADOW_DIR=$(mktemp -d)
MIHOMO_SOCKET="/actual/mihomo.sock" \
MIHOMO_PROXY="http://127.0.0.1:7897" \
OPENAI_GROUP="OpenAI 自动选择" \
STATE_PATH="$SHADOW_DIR/state.json" \
CURL_PATH="$(command -v curl)" \
node controller.mjs --once --shadow
rm -rf "$SHADOW_DIR"
```

### Windows 影子验证

```powershell
$shadowState = Join-Path $env:TEMP "openai-route-shadow-$PID.json"
$env:MIHOMO_API = "http://127.0.0.1:9097"
$env:MIHOMO_PROXY = "http://127.0.0.1:7897"
$env:OPENAI_GROUP = "OpenAI 自动选择"
$env:STATE_PATH = $shadowState
$env:CURL_PATH = (Get-Command curl.exe).Source
$secureSecret = Read-Host "Mihomo secret" -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $env:MIHOMO_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  node .\controller.mjs --once --shadow
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Item Env:MIHOMO_SECRET -ErrorAction SilentlyContinue
  Remove-Item -Force -ErrorAction SilentlyContinue $shadowState
}
```

合格结果：

- `controller_started.mode` 为 `shadow`；
- `type` 为 `Selector`；
- `candidates` 大于零；
- 出现 `current_probe`；
- `hot_standby_radar.successful` 包含通过独立完整路径探测的节点，且没有 `candidate_probe_unavailable`；
- Selector 的当前节点没有变化。

`current_probe.ok=false` 时先报告实际状态、状态码和错误类别，不进入安装阶段。

## 阶段四：安装

### macOS

将只读发现的真实值作为环境变量传入：

```bash
MIHOMO_SOCKET="/actual/mihomo.sock" \
MIHOMO_PROXY="http://127.0.0.1:7897" \
OPENAI_GROUP="OpenAI 自动选择" \
sh scripts/install-macos.sh
```

若用户明确要求支持有线与 Wi-Fi 热切换，先分别读取相关网络服务的 HTTP、HTTPS 和 SOCKS 代理状态。只有在代理端口已经确认、用户授权控制器持续维护系统代理时，才追加：

```bash
MACOS_SYSTEM_PROXY_SYNC=1 \
MACOS_PROXY_SERVICES="Wi-Fi" \
sh scripts/install-macos.sh
```

服务名必须来自 `networksetup -listallnetworkservices`，多个名称用逗号分隔。不要擅自把所有网络服务纳入维护，也不要修改 DNS、网关或代理绕过列表。

安装器会在覆盖同名文件前建立时间戳备份。不得手工删除旧文件。

### Windows

```powershell
$env:MIHOMO_API = "http://127.0.0.1:9097"
$env:MIHOMO_PROXY = "http://127.0.0.1:7897"
$env:OPENAI_GROUP = "OpenAI 自动选择"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

使用当前用户计划任务，不提升到管理员或 SYSTEM。密钥必须由安装器用 DPAPI 加密保存。

## 阶段五：上线观察

观察至少 10 分钟，不以“进程在运行”作为唯一验收。

### macOS

```bash
launchctl print "gui/$(id -u)/com.local.openai-route-controller"
tail -n 160 "$HOME/Library/Application Support/OpenAI Route Controller/controller.log"
tail -n 80 "$HOME/Library/Application Support/OpenAI Route Controller/controller.error.log"
```

### Windows

```powershell
$root = Join-Path $env:LOCALAPPDATA "OpenAI Route Controller"
Get-ScheduledTask -TaskName "OpenAI Route Controller"
Get-ScheduledTaskInfo -TaskName "OpenAI Route Controller"
Get-Content (Join-Path $root "controller.log") -Tail 160
Get-Content (Join-Path $root "controller.error.log") -Tail 80
```

验收证据：

- 服务没有重启循环；
- `current_probe` 按预期间隔出现；
- 热备探针没有持续拖垮当前连接；
- 稳定采样后出现非空 `hot_standby_radar.fastReady`；仅 `ready` 非空不能证明完整路径热备已建立；
- 当前节点没有被无证据反复切换；
- macOS 切换默认网卡时出现 `network_path_changed`，过渡失败不处罚节点，原节点复核成功后出现 `network_transition_recovered`；
- 显式开启系统代理同步时，列出的网络服务三类代理均指向 `MIHOMO_PROXY`；
- 若发生恢复，候选先通过独立完整路径资格验证和 `candidate_preflight`，再修改正式 Selector，随后完成切换后复核；
- 候选复核失败时出现回滚，Selector 不停留在坏候选；
- 错误日志没有持续增长。

## 阶段六：交付报告

只汇报：

- 操作系统、Node 版本；
- 控制通道类型，不包含密钥；
- OpenAI 组类型和候选数量；
- 备份与安装位置；
- `npm run verify` 结果；
- 影子验证结果；
- 服务状态；
- 10 分钟观察期内的探针、切换、回滚和错误数量；
- 对应平台的卸载命令。

不要粘贴未经脱敏的状态文件或原始日志。
