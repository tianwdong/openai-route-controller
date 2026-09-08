# 架构与熔断设计

## 设计目标

控制器针对“节点在几分钟内快速波动”的环境，优先保证三件事：

1. 不把一次短延迟成功误判为 OpenAI 长链路健康；
2. 不在多个自动选择器之间形成竞态；
3. 切换失败时不把用户留在已知坏节点上。

Clash 全局脚本创建一个普通 Selector，并为每个候选创建一个只绑定 `127.0.0.1` 的独立 mixed 监听入口。入口直接绑定节点，控制器可在不修改正式 Selector 的情况下验证候选。控制器通过 Mihomo API 读取组、节点健康、连接和警告日志，并且只有控制器可以自动修改该 Selector。

## 信号分层

### Mihomo 健康信号

`alive` 和 delay API 提供当前节点健康提示及冷扫描信号，不作为恢复候选或热备的准入条件。共享缓存可被其他组或人工测速改写，不能单独证明 OpenAI 路径可用。若当前节点刚在 60 秒内完成过完整路径探针，单次 `alive:false` 会触发一次真实路径确认；确认成功则记录 `provider_health_false_overridden`，确认失败才熔断。没有执行真实请求时生成的 `provider_unhealthy` 只属于 provider 信号，不得写入 `pathEvents`，避免健康缓存过期被误算成多次真实路径失败。

每轮恢复均从完整候选池进行独立验证，每批最多 3 个，保留冷却、历史排序及当前监测检查点。即使缓存标绿的节点超过 3 个，也不会排除 `alive:false` 的候选。当 provider-alive 候选少于 3 个，或上一轮恢复已耗尽时，额外优先检查最多 3 个陈旧候选；排序优先尚未扫描和最久未扫描，独立记录 lastProviderRefreshAt。资格检查的短请求和完整路径均使用固定节点监听器，不依赖 delay API 成功；三轮资格检查、即时复核、切换后四次验证和回滚规则保持有效。`provider_candidate_filter` 的 `alive` 仅记录缓存或优先资格结果，`eligible` 表示完整候选池，`rejected` 为 0；冷却等后续条件仍会排除候选。

### OpenAI 入口探针

控制器请求：

```text
https://chatgpt.com/backend-api/codex/responses
```

未携带会话请求体时，`405` 是预期的“入口可达”信号。它证明域名、TLS、代理路径和服务入口已经响应，但不能证明长流稳定。

### 完整响应体探针

随后请求：

```text
https://chatgpt.com/codex/settings/usage
```

`200` 或带完整响应体的 `403` 均可作为路径可达信号。控制器同时要求最低响应体字节数，避免只收到响应头或半截页面也被算作成功。

### 被动错误

控制器订阅 Mihomo warning 日志，只匹配 `chatgpt.com` 和 `ws.chatgpt.com` 的目标连接。60 秒内两条不同连接的超时、重置或 EOF 会直接触发恢复。`ab.chatgpt.com` 等遥测域名和其他应用错误不参与熔断。

入口和响应体探针成功只清理超过 60 秒窗口的被动错误，不能清空仍在窗口内的业务连接故障。短请求成功与其他连接断流可以同时发生。

### 活动信号

连接字节增长只用于判断最近是否存在 OpenAI 活动，进而降低主动扫描频率。它不是单条 Codex 响应是否健康的证明，因为同一时间可能还有鉴权、同步和页面请求。

冷候选扫描在启动后立即执行一轮，此后每 60 秒执行。最近 2 分钟有活动流量时，每轮只重查 1 个候选；空闲时每轮 2 个。扫描从完整候选池中选取最久未检查、且不在冷却期的非当前节点，不以旧的 `alive:false` 提前排除，也不因持续活动无限暂停。短探针恢复只刷新候选健康信息，不解除冷却、不直接切换，接管仍须完整路径资格验证和切换后复核。

## macOS 默认网络切换

macOS 的系统代理按网络服务保存。有线服务启用了代理，并不代表 `Wi-Fi` 服务也启用了代理；默认服务切换后，Codex 可能绕过 Clash 直连，而控制器自己的 curl 探针仍因显式使用 `MIHOMO_PROXY` 显示健康。

控制器每 5 秒观察默认接口与网关，在已有恢复信号时立即复查。路径变化后：

1. 当前节点任期从新链路开始重新计时，清除连续失败、provider 缓存、被动错误和恢复退避，但保留节点长期历史、冷却和保持期；
2. 进入默认 20 秒保护期，失败探针和 Mihomo 被动错误不记入节点故障，候选雷达暂停；
3. 每 3 秒通过显式代理复核原节点；成功即提前结束保护期，持续失败则在保护期结束后回到正常熔断流程；
4. 显式开启 `MACOS_SYSTEM_PROXY_SYNC=1` 时，同时检查 `MACOS_PROXY_SERVICES` 中每个网络服务的 HTTP、HTTPS 和 SOCKS 代理，偏离 `MIHOMO_PROXY` 才修复。

影子模式只报告 `shadow_system_proxy_repair_needed`，不会修改系统设置。Windows 不执行这套 macOS 路径与系统代理逻辑。

## 两套独立健康账本

每个节点同时维护：

- `probeEvents`：候选探针历史，包含短探针和独立完整路径结果；
- `pathEvents`：完整 OpenAI 路径历史。

候选排序以完整路径历史为先，使用半衰期 30 分钟的时间加权成功率及平滑先验，未知节点的先验为 0.5。一条历史失败不会把长期稳定节点排到未知节点之后，陈旧成功也不能持续掩盖新故障。雷达延迟只用于同等证据下的末级排序，不能清除 `pathEvents` 中的失败，也不能让一个只有绿色延迟的节点直接快速接管。

热备每 20 秒最多并行检查 2 个候选，从完整候选池选择，不读取共享 `alive`，也不要求原生 delay 成功。轮换短请求、Codex 入口和完整 Usage 响应体均经节点独立入口验证；只有最近 10 分钟的完整路径全成功、至少 4 次且跨度 45 秒、最新成功不超过 2 分钟，才具备快速接管资格。冷雷达与热备恰好同时成功不会抹掉已有的连续成功时间跨度。本机探测端口缺失或候选映射在探测中变化时记录基础设施错误，不处罚节点。

热备排序使用完整路径自身的连续失败与质量证据，普通热备的三次连续成功也只从 `pathEvents` 计算。冷雷达的一次短成功或短失败不能重置完整路径的失败事实，也不能补足热备时序资格。既有 `probeEvents` 和混合计数继续用于短探测统计，持久状态无需清空或升级版本。

没有快速热备时，两个完整探测名额中保留一个用于连续探索，按完整探测及独立尝试时间优先重查长期未验证的候选。首次成功后继续给同一候选积累三／四次时序证据；另一个名额按完整路径质量维护。已存在快速热备时优先维护它，不新开探索。当前节点和冷却节点始终不进入热备采样。

探索预约最长 120 秒。真实失败、本机探测不可用、候选映射变化、预约节点被选中／移除／进入冷却，或取得快速热备时结束预约。每次完整探测发起前单独写入 `lastHotStandbyProbeAt`，因此基础设施失败不会被当作节点路径失败，也不能无限占据最旧候选的位置。预约和尝试时间随状态保存；控制器重启不清空原有失败历史或冷却。

## 当前节点熔断

默认触发器按强度排列：

1. Mihomo 明确不可用，并经需要的完整路径确认后仍失败；
2. 60 秒内两条不同 OpenAI 连接出现被动传输错误；
3. 手动或首次选择在 30 秒内未通过两次完整路径验证；
4. 当前节点 4 次失败并持续至少 60 秒；
5. 活跃会话中 2 次失败后确认仍失败，或累计 3 次失败；
6. 当前选中任期内 5 分钟 3 次完整路径失败；
7. 当前选中任期内 10 分钟 4 次完整路径失败；
8. 空闲状态下 3 次连续失败并持续至少 45 秒。

切换后的 5 分钟保持只抑制低证据背景切换。被动传输错误、硬失败和满足阈值的活跃故障可以突破保持。

## 候选生命周期

```text
完整候选池
  │
  ├─ Mihomo alive:false ────────> 保留在独立验证候选池
  │                               缓存池不足或恢复耗尽时额外优先刷新
  │
  ├─ 热备且完整路径历史新鲜、干净 ──────> 1 次即时复核
  │                                         │
  │                                         └─ 切换后继续补足 4 次复核
  │
  └─ 普通／降级候选 ─────────────────────> 3 次短探针＋独立完整路径资格验证
                                            │
                                            ├─ 独立即时复核通过后才修改 Selector
                                            └─ 切换后 4 次完整路径复核
                                                       │
                                    ┌──────────────────┴───────────────┐
                                    │成功                               │失败
                                    ▼                                   ▼
                              建立 5 分钟保持                  回滚并进入递增隔离
```

排序会尽量分散地区和协议类型，避免一个区域或协议族的共因故障占满首批候选。

## 隔离和冷却池脱困

候选或当前节点确认失败后，隔离时间依次为 15、30、60 分钟。节点仍处于同一隔离期时，再次进入恢复流程不会延长隔离，也不会增加处罚级别。连续 30 分钟完整路径成功会降低一级历史处罚，要求相邻探针间隔不超过 2 分钟；任何真实失败或采样中断都会重置恢复计时。降级不缩短已生效的隔离时间，短雷达成功不能降级。

在硬故障场景中，如果所有普通候选都处于冷却，控制器最多选取 3 个仍被 Mihomo 标记为可达的冷却节点。它们仍必须重新通过 3 次资格探针和切换后的 4 次完整路径复核；失败继续回滚。这是“重新验真”，不是忽略冷却直接选中。

间歇故障和低证据确认阶段不会启用冷却池复用，以降低切换风暴风险。

## 回滚、排水和归因

恢复前会保存当前节点、选中时间、完整路径失败窗口和 provider 状态。候选复核失败时，Selector 会恢复到原节点，失败窗口也随之恢复，因此一次失败尝试不会把原故障证据清空。

切换或人工改选时，控制器记录仍走旧出口的既有 OpenAI 连接，并让它们自然排空，不通过 Mihomo 主动删除。排空连接随后出现的错误只记录为 `draining_connection_error_ignored`，不会错误处罚新节点；新连接会使用新的 Selector 出口。这样不能迁移已经建立的 TCP 流，但能避免控制器主动打断仍在正常输出的长响应。

## 无候选时的行为

本轮所有候选失败后，控制器回到恢复前节点。空闲间歇故障按 10、30、60、300 秒退避；硬失败、被动错误、选择验证失败或活跃流量的恢复最多等待 60 秒；当前 provider 明确不可用时按 10、30、30 秒退避。先判定故障强度再判断退避：新严重故障可打断上一轮轻故障的等待，两次恢复至少间隔 10 秒；相同严重故障不会反复跳过退避。退避期间如果热备重新满足新鲜成功序列，控制器会提前唤醒恢复。只要滚动故障条件仍成立，中间一次偶然成功不会把退避进度和时间窗口全部清空。

## 状态文件

状态文件只保存本地候选名称和健康历史，不包含订阅地址、节点端点或 ChatGPT 凭据。当前状态版本为 7；版本不匹配时会重建空状态，避免旧版把合成 provider 故障写入真实路径历史后继续污染排序。

主要字段：

- `current`、`currentSelectedAt`：当前节点及本次任期；
- `currentFailures`、`currentFailureStartedAt`：连续失败；
- `passiveErrors`：去重后的被动错误；
- `holdUntil`：切换保持；
- `nextRecoveryAt`、`recoveryExhaustions`、`lastRecoveryReason`：退避状态和上一轮故障强度；
- `selectionValidation`：人工／首次／快速热备的待验证状态；
- `nodes.*.probeEvents`、`pathEvents`、`excludedUntil`、`penaltyRecoveryStartedAt`：候选健康、隔离历史和连续恢复起点。

## 调参原则

不要根据一次延迟截图调阈值。至少使用同一版本控制器的匿名多小时事件序列，对比：

- 真实断流到 `recovery_complete` 的时间；
- 错误切换次数；
- `recovery_candidate_rolled_back` 数量；
- `recovery_exhausted` 的持续时间；
- 同一节点重复隔离次数。

改变入口 URL、预期状态码、响应体下限、失败阈值、隔离时间或复核次数时，必须同步更新测试和 README。

### Debounced environment checks and monitoring deadlines

Default-route observation is debounced for 10 seconds and failed reads do not
trigger a transition. Route commands and system-proxy work run as separate
single-flight background jobs. Route state changes are applied on the serial
controller flow. Candidate qualification yields between attempts and batches
to current monitoring deadlines; overdue checks also run between radar batches.
Network/selector recovery state is not mutated concurrently by background jobs.
Long individual requests can delay a checkpoint, but repeated forced system
checks no longer monopolize the monitoring loop.

### Recovery ownership and incomplete responses

An attempt retains its origin selection tenure and passive fault evidence.
Selector changes or confirmed network changes invalidate that origin. A new
current-path success can cancel other recovery reasons, but cannot by itself
resolve passive long-connection errors. Cancellation is not a node failure and
must not schedule the origin's backoff against a newly observed manual selection.

Isolated qualification, guarded selection, and four live validation probes remain
separate stages. Live results are attributed only if selection is unchanged when
rechecked. Rejected candidate rollback retains the origin's recent passive errors.
Uncertain selector writes are reconciled and require the full four-success
validation before verification; no completion is inferred from a submitted PUT.

All local API promises settle on completion, response failure, or an elapsed-time
deadline. Parallel qualification settles all siblings before the serial loop
resumes. These properties prevent abandoned callbacks from updating recovery state
after an attempt has already been cancelled. GET/PUT guards do not provide atomic
ownership against an independent writer; see the configuration reference.
