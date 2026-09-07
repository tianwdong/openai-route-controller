# 配置参考

控制器使用环境变量接入本机 Mihomo。熔断阈值当前固定在源码中，以保证测试、文档和运行语义一致。

## 环境变量

| 变量 | macOS 默认值 | Windows 默认值 | 说明 |
|---|---|---|---|
| `MIHOMO_SOCKET` | `/tmp/verge/verge-mihomo.sock` | 空 | Unix Socket；设置 `MIHOMO_API` 时可留空 |
| `MIHOMO_API` | 空 | 需设置，建议 `http://127.0.0.1:9097` | Mihomo HTTP API，仅允许回环地址 |
| `MIHOMO_SECRET` | 空 | 需设置 | External Controller 密钥，不得提交或写入日志 |
| `MIHOMO_PROXY` | `http://127.0.0.1:7897` | 相同 | 当前正式路径探针使用的本机 HTTP 代理；候选探针使用脚本生成的独立端口 |
| `OPENAI_GROUP` | `OpenAI 自动选择` | 相同 | 必须对应一个非空 Selector |
| `STATE_PATH` | `~/Library/Application Support/OpenAI Route Controller/state.json` | `%LOCALAPPDATA%\OpenAI Route Controller\state.json` | 本地滚动健康状态 |
| `CURL_PATH` | 自动查找 `curl` | `curl.exe` | curl 可执行文件 |
| `MACOS_SYSTEM_PROXY_SYNC` | `0` | 不适用 | 设为 `1` 后，自动维护指定 macOS 网络服务的 HTTP／HTTPS／SOCKS 系统代理 |
| `MACOS_PROXY_SERVICES` | `Wi-Fi` | 不适用 | 逗号分隔的网络服务名；仅在系统代理同步开启时生效 |
| `NETWORK_TRANSITION_GRACE_MS` | `20000` | 不适用 | 默认网卡或网关变化后的保护期；最小 5000 毫秒 |

`MIHOMO_SOCKET` 和 `MIHOMO_API` 二选一。HTTP API 带密钥时，控制器对全部 Mihomo 请求添加 Bearer Authorization。

系统代理同步默认关闭。开启前先用 `networksetup -listallnetworkservices` 确认服务名，并确认 `MIHOMO_PROXY` 是无认证的 `http://` 代理。控制器只修复列出的网络服务，不修改 DNS、默认路由或代理绕过列表；服务运行期间手动关闭这些代理，会在下一次检查时被重新开启。

## 固定恢复阈值

这些阈值与状态机测试绑定，当前不提供环境变量覆盖：

| 行为 | 默认值 |
|---|---|
| provider 缓存刷新触发 | provider-alive 候选少于 3 个，或上一轮恢复已耗尽 |
| 单轮 provider 缓存刷新 | 最多 3 个候选，同一候选至少间隔 30 秒 |
| provider 不可用退避 | 10、30、30 秒；热备就绪可提前唤醒 |
| 严重故障／活跃恢复退避 | 最多 60 秒；新严重故障可打断轻故障退避，两轮至少间隔 10 秒 |
| 完整路径排序 | 成功率按 30 分钟半衰期加权，未知先验为 0.5 |
| 隔离处罚恢复 | 连续 30 分钟完整路径成功降一级；采样间隔最多 2 分钟，不缩短当前隔离 |
| macOS 切网保护 | 20 秒内不累计当前路径失败或被动错误；每 3 秒复核原节点，成功后提前结束 |
| 旧连接排空 | 记录旧出口连接并忽略其后续错误，不主动删除连接 |

provider 恢复扫描优先选择未扫描、最久未扫描的候选，单独记录每次尝试，避免基础设施错误或地区分桶导致反复占用名额。候选通过独立监听完成三轮资格验证后，即使共享 `alive:false` 未更新，也可进入正常恢复候选池；冷却、切换前即时复核、切换后验证和回滚规则仍然有效。

冷候选扫描在启动后执行一轮，之后每 60 秒重查最久未测的候选：最近 2 分钟有 OpenAI 流量时每轮 1 个，空闲时每轮 2 个。持续使用不会无限暂停扫描；当前节点和仍在冷却期的节点不进入这一后台扫描。

## Clash 组约束

`OPENAI_GROUP` 必须满足：

- 类型为 `Selector`；
- 当前节点存在；
- 候选列表非空；
- 由 `Script.openai.js` 或等价脚本将 OpenAI 域名路由到该组；
- 为候选列表去重后按 JavaScript `.sort()` 排序，第 `i` 个节点直接绑定 `127.0.0.1:17900+i` 的 mixed listener，名称为 `openai-route-probe-i`；
- 没有第二套 `fallback`／`url-test` 或脚本同时修改它。

探测监听只接受本机连接，关闭 UDP，`users: []` 跳过入口认证。它们只在收到探针时建立上游连接；平时只维护 2 个热备。不要把这些端口改为对外监听，也不要让其他程序占用。脚本发现已有监听器端口冲突会拒绝生成；组候选与监听器映射必须一起更新。规则模式下 listener 的 `proxy` 直接指定候选，依据 [Mihomo 官方监听文档](https://wiki.metacubex.one/en/config/inbound/listeners/)。

实时模式发现组类型不是 Selector 时会退出。`--once --shadow` 可用于只读确认。

## 探针端点

默认探针：

| 端点 | 预期 | 用途 |
|---|---|---|
| `https://chatgpt.com/backend-api/codex/responses` | `405` | OpenAI／Codex 入口和 TLS 可达性 |
| `https://chatgpt.com/cdn-cgi/trace` | HEAD 返回 `200` | 热备轮换短探针 |
| `https://chatgpt.com/codex/settings/usage` | `200` 或 `403` 且至少 3000 bytes | 完整响应体读取 |

这些状态只用于网络路径判定。真实业务请求的 `403` 不是成功。

## 运行模式

```bash
node controller.mjs --once --shadow
node controller.mjs --shadow
node controller.mjs
```

- `--once --shadow`：检查当前路径、冷雷达和独立热备路径各一轮，不切换；
- `--shadow`：持续维护状态和探针，不切换；
- 无参数：实时控制 Selector。

首次上线必须先通过 `npm run verify` 和 `--once --shadow`。

## Independent main-route profile

`ROUTE_PROFILE=main` reuses the recovery state machine for general proxy traffic.
`ROUTE_GROUP` overrides its default `主代理自动选择` selector. This instance has a
separate state directory (`Main Route Controller` on macOS), process and logs.
Its current-route probe uses loopback port 18100 bound to that selector; isolated
candidates use sorted, deduplicated names at ports 18000 + index. The listener
configuration must match this mapping and must not overlap the OpenAI listeners.

This profile checks HTTPS gstatic 204 and a complete Cloudflare trace 200 response
with at least 100 bytes. It ignores the shared Mihomo `alive` cache and performs
its own HTTP probes instead of writing to the shared native delay cache. It does
not consume OpenAI passive-error logs or manage system proxy settings. Current
traffic observation remains scoped to its own group. These probes test general
HTTPS reachability, not all websites or long-lived application streams.

The existing qualification, isolated preflight, four post-switch checks, gradual
cooldowns, recovery backoff, and active/idle cold radar remain in force. The main
selector is nested under the user's main manual selector; switching that outer
selector to a manual option remains possible. OpenAI remains the default profile
and its installed service need not be restarted when deploying the main instance.

当当前节点被 provider 持续判死且缺少新鲜成功证据时，每约 30 秒执行一次真实路径复核，避免仅凭旧缓存持续返回 provider_unhealthy。被动错误触发的缓存检查仍不应计作真实网络请求失败。

## Monitoring scheduling and route debounce

A new default interface/gateway must remain observed for 10 seconds before it
resets route-specific recovery state. A failed route read or a sample gap longer
than 15 seconds breaks confirmation; it does not erase the last confirmed route.
The initial valid observation establishes a baseline without resetting failures.

Route reads and system-proxy checks each have at most one background job in
flight. Errors do not force a fresh system-proxy scan on every controller loop.
State transitions from route observations remain on the controller's serial flow.

Current-path monitoring has an independent due time. Candidate qualification
checks this deadline between attempts and batches, and background radar yields
to an overdue current check. Repeated passive errors do not keep postponing that
deadline. Current checks are single-flight; selector mutation and post-switch
validation remain serial. Ordinary local Mihomo requests time out after 5 seconds;
native delay tests retain their explicit timeout. The design is cooperative:
one in-flight request can still delay a scheduled check; it is not a hard real-time
guarantee. Post-switch probes also count as current-path monitoring.

`current_probe_deadline_serviced` includes `overdueMs` to expose delay, and
`network_path_read_failed` reports a failed route command without calling it a
confirmed network transition.
