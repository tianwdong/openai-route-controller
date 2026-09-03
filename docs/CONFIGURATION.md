# 配置参考

控制器使用环境变量接入本机 Mihomo。熔断阈值当前固定在源码中，以保证测试、文档和运行语义一致。

## 环境变量

| 变量 | macOS 默认值 | Windows 默认值 | 说明 |
|---|---|---|---|
| `MIHOMO_SOCKET` | `/tmp/verge/verge-mihomo.sock` | 空 | Unix Socket；设置 `MIHOMO_API` 时可留空 |
| `MIHOMO_API` | 空 | 需设置，建议 `http://127.0.0.1:9097` | Mihomo HTTP API，仅允许回环地址 |
| `MIHOMO_SECRET` | 空 | 需设置 | External Controller 密钥，不得提交或写入日志 |
| `MIHOMO_PROXY` | `http://127.0.0.1:7897` | 相同 | curl 完整路径探针使用的本机 HTTP 代理 |
| `OPENAI_GROUP` | `OpenAI 自动选择` | 相同 | 必须对应一个非空 Selector |
| `STATE_PATH` | `~/Library/Application Support/OpenAI Route Controller/state.json` | `%LOCALAPPDATA%\OpenAI Route Controller\state.json` | 本地滚动健康状态 |
| `CURL_PATH` | 自动查找 `curl` | `curl.exe` | curl 可执行文件 |

`MIHOMO_SOCKET` 和 `MIHOMO_API` 二选一。HTTP API 带密钥时，控制器对全部 Mihomo 请求添加 Bearer Authorization。

## Clash 组约束

`OPENAI_GROUP` 必须满足：

- 类型为 `Selector`；
- 当前节点存在；
- 候选列表非空；
- 由 `Script.openai.js` 或等价脚本将 OpenAI 域名路由到该组；
- 没有第二套 `fallback`／`url-test` 或脚本同时修改它。

实时模式发现组类型不是 Selector 时会退出。`--once --shadow` 可用于只读确认。

## 探针端点

默认探针：

| 端点 | 预期 | 用途 |
|---|---|---|
| `https://chatgpt.com/backend-api/codex/responses` | `405` | OpenAI／Codex 入口和 TLS 可达性 |
| `https://chatgpt.com/cdn-cgi/trace` | `200` 且至少 100 bytes | 热备轮换短探针 |
| `https://chatgpt.com/codex/settings/usage` | `200` 或 `403` 且至少 3000 bytes | 完整响应体读取 |

这些状态只用于网络路径判定。真实业务请求的 `403` 不是成功。

## 运行模式

```bash
node controller.mjs --once --shadow
node controller.mjs --shadow
node controller.mjs
```

- `--once --shadow`：检查一次，不切换；
- `--shadow`：持续维护状态和探针，不切换；
- 无参数：实时控制 Selector。

首次上线必须先通过 `npm run verify` 和 `--once --shadow`。
