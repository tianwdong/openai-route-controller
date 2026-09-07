# 故障排查

## 页面延迟绿色，但 ChatGPT 打不开

绿色 delay 只代表 Mihomo 的短测试成功。查看最近的 `current_probe`：

- `status=405/200` 或 `405/403` 且 `ok=true`：本次完整路径已读完；
- `status=000`、SSL timeout、`SSL_ERROR_SYSCALL`：TLS／代理路径失败；
- 字节数不足：响应体没有完整读取；
- `providerAlive=false`：Mihomo 当前认为节点不可用，控制器会按是否有新鲜完整路径证据决定是否追加确认。

未真正发出完整路径请求的 `provider_unhealthy` 不计入 `pathEvents`。它会立即触发 provider 恢复，但不会伪造间歇性路径失败。

不要用手动测速结果替代完整路径日志。

## 控制器停在页面显示 Timeout 的节点

依次检查：

1. `OpenAI 自动选择` 是否仍为 `Selector`；
2. 控制器服务是否在运行；
3. 是否出现 `controller_cycle_failed` 或 `log_stream_error`；
4. 是否进入 `selection_validation`；
5. 是否所有 provider-alive 候选都处于隔离；
6. 硬故障时是否出现 `emergency_cooling_reuse`；
7. 候选失败后是否出现 `recovery_candidate_rolled_back`。

如果页面显示的选中节点和日志中的 `current` 不一致，先确认只有一个控制器实例，并检查是否还有原生 `url-test`／`fallback` 组或另一套脚本在改选择器。

## 只有手动测速后才恢复

通常有三类原因：

- 控制器没有运行或无法访问 Mihomo 控制通道；
- 候选池全部冷却，但故障理由还不足以启用严格冷却池复用；
- Mihomo provider 状态长期未更新，手动测速刷新了其 `alive` 数据。

新版在 provider-alive 候选少于 3 个时会自动执行同类刷新，但每轮最多只测 3 个，防止全池并发测速反过来拖垮代理。查看：

- `provider_cache_refresh_started`：本轮主动刷新的候选；
- `provider_cache_refresh_complete`：刷新前后的 alive 数量；
- `provider_candidate_filter`：刷新后实际允许进入严格验证的候选；
- `recovery_exhausted`：本轮全失败后的下次重试时间；
- `recovery_woken_by_hot_standby`：热备恢复后是否提前结束退避。

即使刷新探针成功，只要 Mihomo 仍未把节点标成 alive，控制器也不会直接切过去。

## Codex 一直重连，但控制器探针正常

`Error running remote compact task` 后伴随 `stream disconnected before completion` 和 `error decoding response body`，表示远端压缩请求在读取响应体时失败；普通生成中的 `Reconnecting... 1/5` 也需要按实际请求断流排查。仅凭这段错误无法确定是代理、服务端还是客户端传输实现，不能把 Usage 页的完整响应当作修复验收。

同一节点的短请求成功不会清除最近 60 秒内的业务连接错误。检查是否有两条不同连接的被动错误被识别；超过窗口的错误不会触发恢复。

如果 `hot_standby_radar.ready` 非空但 `fastReady` 长期为空，检查独立完整路径探测是否运行、最近 10 分钟是否仍有真实失败，以及脚本的候选监听映射是否与当前组一致。`candidate_probe_unavailable` 表示本机探测入口缺失或映射变化，不能据此处罚上游节点。成功的 Mihomo HEAD 不能替代完整响应体；`candidate_preflight` 必须发生在正式切换之前。

持续多次完整路径失败应优先进入 `hard_current_probe_failures` 或活跃故障，不能一直被间歇窗口理由覆盖。严重故障退避最多 60 秒，provider 故障最多 30 秒；空闲间歇故障才允许等待 300 秒。

`405/200` 完整路径探针仍然不是已登录的真实长流。以下情况可能无法由控制器自动识别：

- 单条 Responses 流静默停止，但其他 OpenAI 后台连接仍在增长；
- 客户端认证、Cloudflare 风控或会话层返回错误；
- 当前任务在客户端内部进入重试状态，网络已经恢复但任务没有立即续传。

先区分是否存在 Mihomo 传输错误。如果没有 `current_probe` 失败或 `chatgpt.com`／`ws.chatgpt.com` 被动错误，不要盲目缩短熔断阈值。

## 新任务稳定重试五次并返回 403

带 Cloudflare 页面和 `cf-ray` 的 `403` 可能是会话、风控或出口身份问题。控制器只把 Usage 探针的完整 `403` 用作“响应体可读”的网络证据，不会把真实 Codex 请求的 `403` 视为业务成功。

检查实际 Responses 请求是否持续从同一出口发出，以及切换前后公网 IP 是否变化。不要把账号 Cookie 或响应页面上传到 issue。

## 拔掉有线后立刻返回 403

如果错误与拔线动作严格同时发生，先检查 macOS 的各网络服务，而不是继续调节点阈值：

```bash
networksetup -getwebproxy "Wi-Fi"
networksetup -getsecurewebproxy "Wi-Fi"
networksetup -getsocksfirewallproxy "Wi-Fi"
scutil --proxy
```

有线服务和 `Wi-Fi` 的代理状态彼此独立。典型失配是三项都保存了 `127.0.0.1:7897`，但 `Wi-Fi` 显示 `Enabled: No`；拔线后 Codex 直连 `chatgpt.com`，而控制器因 curl 显式传入代理仍显示 `current_probe ok=true`。

确认端口无误后，可在安装控制器时显式开启自动维护：

```bash
MIHOMO_PROXY="http://127.0.0.1:7897" \
MACOS_SYSTEM_PROXY_SYNC=1 \
MACOS_PROXY_SERVICES="Wi-Fi" \
sh scripts/install-macos.sh
```

观察 `network_path_changed`、`system_proxy_repaired`、`network_transition_probe_suppressed` 和 `network_transition_recovered`。若准备手动关闭系统代理，应先停止控制器，否则同步功能会在下一轮检查时重新开启它。

## macOS 服务未启动

```bash
launchctl print "gui/$(id -u)/com.local.openai-route-controller"
tail -n 120 "$HOME/Library/Application Support/OpenAI Route Controller/controller.log"
tail -n 80 "$HOME/Library/Application Support/OpenAI Route Controller/controller.error.log"
plutil -lint "$HOME/Library/LaunchAgents/com.local.openai-route-controller.plist"
```

常见原因是 Node 路径变化、Socket 路径不同或 Clash Verge Rev 尚未启动。

## Windows API 连接被拒绝

确认 Clash Verge Rev 中的 External Controller 已显式开启，并且确实监听回环地址：

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 9097 -State Listen
Get-ScheduledTask -TaskName "OpenAI Route Controller"
Get-ScheduledTaskInfo -TaskName "OpenAI Route Controller"
```

配置文件里出现 `external-controller` 不等于 GUI 已经开放该接口。不要改成 `0.0.0.0` 规避问题。

## Windows 计划任务反复退出

```powershell
$root = Join-Path $env:LOCALAPPDATA "OpenAI Route Controller"
Get-Content (Join-Path $root "controller.log") -Tail 120
Get-Content (Join-Path $root "controller.error.log") -Tail 80
```

重点检查 Node／curl 路径、DPAPI 文件是否由同一 Windows 用户创建、API 端口和组名。

## 安全地收集诊断

可以分享：事件名、时间戳、状态码、耗时、候选数量、匿名节点代号。

必须删除：订阅 URL、节点服务器、UUID、密钥、Cookie、Authorization、真实公网 IP、用户名和绝对路径。
