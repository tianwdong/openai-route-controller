# OpenAI Route Controller

面向 Clash Verge Rev／Mihomo 的 OpenAI、ChatGPT 与 Codex 本地路由熔断器。

它不把“延迟绿色”当成可用结论，而是持续验证真实 OpenAI 路径，在当前出口失效时，从完整候选池中自动选择、严格验真、切换、复核；失败则回滚并隔离节点。macOS 和 Windows 均可部署。

> 这不是 VPN，也不能改善机场本身的上游质量。它解决的是：节点在几分钟内频繁波动时，尽量减少手动测速和手动切换。

## 适用场景

- Clash Verge Rev 的节点延迟正常，但 ChatGPT Usage 页面打不开；
- Codex 出现 `Reconnecting... waiting for network`、`error decoding response body` 或流式响应中断；
- Mihomo 自动组切到页面已显示 `Timeout` 的节点；
- 只有手动测速或手动换节点后才能恢复；
- 希望保留全部候选，但只让一套控制逻辑负责切换。

本项目只处理 OpenAI／ChatGPT／Codex 域名，不包含 Grok、远程桌面、音乐应用或其他个人规则。

## 核心熔断规则

| 环节 | 默认规则 |
|---|---|
| 当前路径 | 每 20 秒检查 Codex 入口，并完整读取 ChatGPT Usage 响应体；活跃会话降低到每 30 秒一次 |
| Mihomo `alive:false` | 若 60 秒内完整路径刚成功，先做真实链路确认；确认失败才剔除，避免单次误报 |
| 空闲连续失败 | 3 次失败且首个失败已持续 45 秒才恢复 |
| 活跃会话失败 | 2 次失败后追加确认；仍失败则恢复，3 次失败可突破保持期 |
| 被动传输错误 | 60 秒内出现 2 条不同 OpenAI 连接错误，立即恢复 |
| 间歇故障 | 当前选中任期内，5 分钟累计 3 次或 10 分钟累计 4 次完整路径失败，触发恢复 |
| 手动／首次选择 | 连续 2 次完整路径成功后才建立保持；2 次失败或 30 秒未完成则自动接管 |
| 热备 | 持续维护 2 个热备；只有最近完整路径历史干净的节点才能快速接管 |
| 普通候选 | 先做 3 次分离资格探针，切换后再做 4 次完整路径复核 |
| 切换失败 | 回滚至恢复前节点，不把失败候选留在选择器上 |
| 节点隔离 | 15、30、60 分钟递增；同一冷却期不会被重复延长 |
| 冷却池脱困 | 硬故障且普通候选耗尽时，最多取 3 个仍被 Mihomo 标记可达的冷却节点，重新完成严格 3＋4 验证；不是直接复活 |
| 恢复退避 | 全部候选失败后按 10、30、60、300 秒退避重试 |
| 旧连接 | 切换时记录旧出口连接并自然排水；旧连接后续错误不归罪于新节点 |

完整状态机见 [架构与熔断设计](docs/ARCHITECTURE.md)，环境变量见 [配置参考](docs/CONFIGURATION.md)。

## 为什么不用原生 `url-test`／`fallback`

短延迟测试通常只能证明某个 URL 在某一刻返回，不能证明：

- `chatgpt.com` 的 TLS 和响应体能完整读取；
- 一条 Codex 长流不会中途断开；
- 五分钟前可用的节点现在仍可用；
- 自动组不会与外部控制器同时争抢选择权。

因此 `Script.openai.js` 创建的是普通 `select` 组。Mihomo 继续提供节点健康信号，但只有本控制器会自动修改该组的当前节点。

## 最省事：直接交给 Codex 配置

将下面整段发给目标电脑上的 Codex。它会先只读确认环境，条件匹配时再安装；不会覆盖其他应用规则。

```text
请使用 https://github.com/tianwdong/openai-route-controller 为这台电脑部署 OpenAI Route Controller。

我授权你完成以下本机操作：读取 Clash Verge Rev／Mihomo 的本地运行状态，备份现有 OpenAI 相关全局扩展脚本和同名用户服务，安装本仓库文件，并创建当前用户级的 macOS LaunchAgent 或 Windows 计划任务。不要上传或打印订阅地址、节点端点、Mihomo secret、ChatGPT 凭据、Cookie、日志原文或个人路径；不要改动与 OpenAI 无关的代理组和规则。

严格按此顺序执行：
1. 阅读仓库 README.md、AGENTS.md 和 docs/CODEX_SETUP.md。
2. 只读确认操作系统、Node.js >= 22、curl、Clash Verge Rev／Mihomo、代理模式、HTTP 代理端口、Mihomo 控制通道、OpenAI 组名和候选数量。
3. 如果现有全局扩展脚本还有其他规则，只合并 Script.openai.js 的 OpenAI 组与四条 OpenAI 域名规则，不要整文件覆盖。
4. 确认 OpenAI 组最终为 Selector，候选不为空，并且只有本控制器负责自动切换。
5. 运行 npm run verify，再使用临时状态文件执行 controller.mjs --once --shadow。影子验证必须找到组、看到 current_probe，且不改变当前选择。
6. macOS 使用 Unix Socket 和 scripts/install-macos.sh；Windows 只使用绑定在 127.0.0.1 的 External Controller，并使用 scripts/install-windows.ps1。端口或路径不同时以实测值为准。
7. 安装后观察至少 10 分钟，检查服务状态、current_probe、hot_standby_radar、recovery_complete、recovery_exhausted 和错误日志。
8. 给我汇报：备份位置、安装位置、组类型、候选数、影子验证结果、服务状态、10 分钟观察结果和可执行的回滚命令。

如果控制通道未开放、组名冲突、候选为空、测试失败或影子探针失败，停止安装并只报告一个明确阻塞点，不要猜测修改。
```

更严格的执行验收见 [Codex 部署协议](docs/CODEX_SETUP.md)。

## 环境要求

- Node.js 22 或更新版本，建议使用仍受支持的 LTS 版本；
- `curl`；
- Clash Verge Rev／Mihomo；
- 规则模式；
- 一个由 `Script.openai.js` 创建的 `OpenAI 自动选择` Selector。

macOS 默认使用 `/tmp/verge/verge-mihomo.sock`。Windows 使用显式开启的 External Controller；Clash Verge Rev 维护者说明，未开启该开关时不会暴露外部控制接口，内部命名管道也不属于受支持的外部接口，见[项目讨论](https://github.com/clash-verge-rev/clash-verge-rev/discussions/6951)。Node.js 官方建议生产程序只使用 Active LTS 或 Maintenance LTS，见[版本状态](https://nodejs.org/en/about/previous-releases)。

## 手动安装

### 1．配置 Clash Verge Rev

将 [Script.openai.js](Script.openai.js) 合并到“全局扩展脚本”，保存后重新应用订阅。确认：

- `OpenAI 自动选择` 显示为 `Selector`；
- 候选数量大于零；
- 软件处于规则模式；
- OpenAI 域名规则位于兜底规则之前。

如果节点名不含 `JP`、`KR`、`SG`、`TW`、`US` 或对应中英文地区名，请先修改脚本中的 `supportedRegion`。

### 2．macOS

```bash
git clone https://github.com/tianwdong/openai-route-controller.git
cd openai-route-controller
sh scripts/install-macos.sh
```

端口、组名或 Socket 不同时：

```bash
MIHOMO_SOCKET="/actual/mihomo.sock" \
MIHOMO_PROXY="http://127.0.0.1:7897" \
OPENAI_GROUP="OpenAI 自动选择" \
sh scripts/install-macos.sh
```

安装器会先运行 46 项测试（包含本机 HTTP API 集成测试）和影子验证，然后备份旧文件、安装用户级 LaunchAgent 并启动服务。

### 3．Windows 10／11

先在 Clash Verge Rev 中显式开启 External Controller，绑定到本机回环地址并设置随机长密钥。不要绑定 `0.0.0.0`，不要在防火墙开放该端口。

```yaml
external-controller: 127.0.0.1:9097
secret: "在本机生成并保存，不要提交到仓库"
```

随后在普通 Windows PowerShell 中运行：

```powershell
git clone https://github.com/tianwdong/openai-route-controller.git
Set-Location .\openai-route-controller
$env:MIHOMO_API = "http://127.0.0.1:9097"
$env:MIHOMO_PROXY = "http://127.0.0.1:7897"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

安装器会提示输入密钥，将其用当前用户 DPAPI 加密保存，并注册当前用户登录时运行的计划任务。计划任务由 Windows 官方的 `Register-ScheduledTask` 创建。

## 只验证，不安装

```bash
npm run verify
SHADOW_DIR=$(mktemp -d)
STATE_PATH="$SHADOW_DIR/state.json" node controller.mjs --once --shadow
rm -rf "$SHADOW_DIR"
```

实际影子运行通常还要设置 `MIHOMO_SOCKET`／`MIHOMO_API`、`MIHOMO_PROXY` 和 `OPENAI_GROUP`。`--once` 和 `--shadow` 都不会修改选择器。

## 运行日志

控制器输出 JSON Lines。优先关注：

- `current_probe`：当前完整路径结果；
- `provider_health_false_overridden`：Mihomo 单次判死被完整路径复核覆盖；
- `current_node_ejected`：当前节点进入隔离；
- `recovery_candidate_rejected`：候选切换后复核失败并回滚；
- `emergency_cooling_reuse`：普通候选耗尽，开始严格复核冷却节点；
- `recovery_complete`：完整恢复完成；
- `recovery_exhausted`：本轮没有候选通过，已进入退避。

日志判读与常见故障见 [故障排查](docs/TROUBLESHOOTING.md)。

## 回滚

macOS：

```bash
sh scripts/uninstall-macos.sh
```

Windows：

```powershell
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1
```

卸载脚本只移除用户服务／计划任务，保留源码、状态、日志和备份供检查。Clash 全局扩展脚本需恢复安装前备份。

## 能力边界

控制器能自动处理节点级硬故障、完整路径失败、可见传输错误、间歇故障、错误候选回滚和候选池冷却锁死。它不能：

- 修复所有上游节点同时不可用；
- 读取 Codex 客户端内部状态；
- 准确识别“没有网络错误，但某一条单独长流停止下载”的应用层静默卡死；
- 代替账号认证、地区合规或服务状态检查。

## 开发验证

```bash
npm run verify
```

当前基线为 46 项状态机、脚本与本机 API 集成测试。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
