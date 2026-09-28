# @aiwayds/dsh-jev-core

[English](./README.en.md) | 中文

dsh 生态共享的 [TypeSafe Jev](https://typesafe.ai)（System One）决策模型客户端：一次 HTTP 调用携带 N 个原子问题（`choice` / `score` / `noul`），响应经**严格单档校验**后返回类型化判定。

**Jev-optional 是设计约束，不是附加功能**：所有消费方靠 `isConfigured()` 分支、自备降级路径（dispatch 沉默、attention 走启发式排序）；core 本身**从不降级**——要么给出判定，要么抛类型化错误。

## 为什么是"严格单档"

社区实现普遍只校验答案**类型**就放行，这会让"类型正确但内容错误"的分布溜进去：选中的选项不是概率最大项（non-argmax）、概率键集合没有覆盖全部候选、被问的问题根本没被回答（策略层误读为"无门控"）。本包的每条规则**永远开启**，没有宽松模式可退——校验失败恰好就是调用方本来什么都不该做的那些场景，所以严格零成本：

- **argmax 规则**：choice 声称的选项必须是自身概率分布的最大项（±0.001 舍入容差）
- **键集合精确相等**：概率 map 的键必须与本次请求的 criteria 一一对应
- **和容差**：概率和与 1 的偏差 ≤ `0.005×n + 0.0001`（响应保留两位小数的舍入噪声）
- **有问必答**：发送的每个问题都必须有答案，绝不返回部分判定
- **score 位置映射**：按位置返回的概率（数组或字符串化下标）映射回 level 名后再校验

## 安装

```sh
npm install @aiwayds/dsh-jev-core
```

零运行时依赖；Node ≥ 22（原生 fetch）；ESM。

## 快速开始

```js
import { classify, isConfigured, JevError } from '@aiwayds/dsh-jev-core'

const questions = {
  delegate: { type: 'noul', criteria: { true: '应委派给子代理', false: '主代理自己做' } },
  tier: { type: 'choice', instructions: '按任务复杂度选档', criteria: { quick: '机械活', deep: '需深思' } },
}

if (isConfigured()) {
  try {
    const { answers, usage, latencyMs } = await classify({ questions, state: '修复 e2e 里 flaky 的计时器' })
    // answers.delegate.value ∈ [0,1]，answers.tier 是 argmax 校验过的 choice
  } catch (error) {
    if (error instanceof JevError) {
      // 'no-key' | 'timeout' | 'http' | 'invalid-response' —— 降级是调用方的政策
    }
  }
} else {
  // jev-optional：走本地启发式路径
}
```

## API

| 导出 | 说明 |
| --- | --- |
| `classify(options)` | 发起一次判定调用；成功返回 `{ answers, model, usage, latencyMs }`，失败抛类型化错误 |
| `buildRequestBody(questions, state, model)` | 精确的请求体（深克隆 questions）——契约测试与 replay 工具用 |
| `normalizeAnswers(payload, questions)` | 严格校验器本体；replay/单测复用 |
| `normalizeUsage(payload)` | usage 元数据校验；损坏降级为 null（元数据不拖垮有效判定） |
| `readKey(sources?)` | key 解析，顺序固定（见下） |
| `isConfigured(sources?)` | jev-optional 分支点：配置查询而非 try/catch 探测 |
| `sumTolerance(n)` | 概率和容差公式 |
| `JevError` 及子类 | `code`: `'no-key'` / `'timeout'` / `'http'` / `'invalid-response'`——**匹配 code，不匹配消息文本** |
| `DEFAULT_ENDPOINT` / `DEFAULT_MODEL` / `DEFAULT_TIMEOUT_MS` | `https://api.typesafe.ai/v1/systemone` / `jev-1.13.0`（钉版，不用别名）/ 5000ms |

### key 解析顺序（keychain-first，配置零明文）

1. 调用参数 `apiKey`
2. env `TYPESAFE_API_KEY`
3. env `JEV_API_KEY`
4. macOS 钥匙串：`JEV_KEYCHAIN='<service>[:<account>]'` 规格（默认服务 `typesafe.ai`），`security find-generic-password` 取值，**按 spec 记忆化**（改 key 重启生效）

钥匙串之外的任何取值失败都归为"无 key"（返回 null / `isConfigured() === false`），绝不抛错——缺 key 是配置状态不是错误。畸形 `JEV_KEYCHAIN` 规格在启动期用 `parseKeychainSpec()` 显式校验。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | （无） | 主 env 入口（与 dsh-jev-mcp native 后端一致） |
| `JEV_API_KEY` | （无） | 兜底 env 入口 |
| `JEV_KEYCHAIN` | `typesafe.ai` | macOS 钥匙串规格 `'<service>[:<account>]'` |
| `JEV_ENDPOINT` | typesafe 官方端点 | 高级/测试钩子（指向本地 mock 等） |
| `JEV_MODEL` | `jev-1.13.0` | 钉版 id——别名随发版静默漂移，升级显式改 |

## 设计边界（刻意不做）

- **重试不进 core**：once 触发的调用方值得重试一次，fire-and-forget 的不值得——是调用方政策
- **缓存不进 core**：逐 turn 文本各不相同的消费方命中率≈0
- **熔断不进 core**：熔断是执行模型 failover 的事；建议型调用 fail-open（跳过）已是兜底
- **usage 损坏不失败**：元数据问题降级 null，不拖垮有效判定
- **caller abort 原样重抛**：调用方取消是 `AbortError`，绝不伪装成超时

## 生态消费方

- `@aiwayds/dsh-jev-dispatch`（规划中）：agent/pre-step 事前派发建议
- dsh-tui-pi attention（规划中）：子代理事中 attention 打分
- [dsh-jev-mcp](https://github.com/fan56/dsh-jev-mcp)（MCP 形态，独立实现）：keychain/endpoint 约定与本包同源

## License

[MIT](./LICENSE)
