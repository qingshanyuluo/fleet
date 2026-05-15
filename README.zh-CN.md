# Fleet — 把手机变成 Claude Code 远程终端

Fleet 是一个飞书机器人，让你在手机上像用终端一样操作 Claude Code。对话即会话，线程即 session，随时随地写代码。

## 为什么需要 Fleet

- 在地铁上想让 Claude 跑个任务？发条飞书消息就行
- 想看 VSCode 里 Claude 跑到哪了？点 Watch 实时查看
- 昨天的对话想继续？搜索 + Resume，秒接上
- 多个项目并行？每个线程独立 session，互不干扰

## 核心功能

### 会话管理
- `/list` — 折叠面板展示所有会话，展开看最近对话预览
- `/list 关键词` — 搜索所有历史会话（标题、摘要、首条 prompt）
- `/projects` — 浏览所有 Claude Code 项目，一键切换
- `/folder <名称>` — 快速切换项目目录

### 对话交互
- 发消息 → 自动创建新 Claude 会话
- 在线程里回复 → 继续同一个会话
- 多线程 → 多个并行 Claude 会话
- 发图片/文件 → Claude 自动分析

### 会话操作
- **▶ Resume** — 恢复历史会话，接着聊
- **⑂ Fork** — 从任意节点分叉，保留完整历史
- **👀 Watch** — 查看正在运行的会话输出
- **✕ Archive** — 归档不需要的会话

### 智能特性
- 🟢 自动检测 VSCode/终端中正在运行的会话
- 假死检测：30 秒无 API 响应 或 3 分钟无 tool 输出 → 自动停止，session 保留，回复即可继续
- 自动重试：session 过期或上下文溢出时自动刷新
- 交互式问答：Claude 提问时弹出选项按钮
- 状态持久化：重启不丢失 thread↔session 映射

## 快速开始

### 前置条件

- Node.js 20+
- Claude Code 已安装并登录：`npm install -g @anthropic-ai/claude-code && claude login`
- 一个飞书自建应用（需要 Bot 能力）

### 创建飞书应用

1. 进入 [飞书开发者后台](https://open.feishu.cn/app) → 创建自建应用
2. 添加 **机器人** 能力
3. 权限配置：
   - `im:message` — 读写消息
   - `im:message:readonly` — 读取消息
   - `im:resource` — 上传图片和文件
4. 事件与回调：
   - 订阅方式选 **长连接**
   - 订阅事件：`im.message.receive_v1`、`card.action.trigger`
5. 创建版本并发布

### 安装运行

```bash
git clone https://github.com/qingshanyuluo/fleet.git
cd fleet
npm install
cp config.example.json config.json
# 编辑 config.json，填入飞书 App ID 和 App Secret
```

开发模式：
```bash
npm run dev
```

生产部署（PM2）：
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 开机自启
```

### 开始使用

打开飞书，搜索你的机器人，发起私聊。发 `/dash` 看仪表盘，或直接发消息开始对话。

## 配置说明

```json
{
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "你的应用密钥",
  "defaultWorkingDirectory": "/Users/you/projects",
  "claude": {
    "maxTurns": null,
    "maxBudgetUsd": null,
    "model": "claude-opus-4-7"
  },
  "folders": {
    "myproject": "/Users/you/Code/myproject",
    "fleet": "/Users/you/Code/fleet"
  }
}
```

| 字段 | 说明 |
|------|------|
| `feishuAppId` | 飞书应用 ID |
| `feishuAppSecret` | 飞书应用密钥 |
| `defaultWorkingDirectory` | 默认工作目录 |
| `claude.model` | Claude 模型（默认 claude-opus-4-7） |
| `claude.maxTurns` | 最大对话轮数（null = 无限） |
| `claude.maxBudgetUsd` | 单次预算上限（null = 无限） |
| `folders` | 项目快捷方式，用于 `/folder` 切换 |

## 技术架构

```
~3400 行 TypeScript · 18 个源文件 · 飞书 Card JSON 2.0
持久化：~/.fleet/state.json
进程管理：PM2
```

```
src/
├── bridge/          # 核心调度：消息路由、会话生命周期、Claude 执行
│   ├── index.ts     # Bridge 主类
│   ├── command-handler.ts  # /slash 命令处理
│   └── session-manager.ts  # 会话 CRUD + 磁盘持久化
├── core/            # Claude SDK 封装
│   ├── executor.ts  # Agent SDK query 调用
│   ├── stream-processor.ts  # SDK 消息 → 卡片状态
│   ├── projects.ts  # 项目扫描、会话读取、活跃检测
│   └── async-queue.ts  # 多轮输入队列
├── feishu/          # 飞书 API 层
│   ├── card-builder.ts  # 交互式卡片构建（JSON 2.0）
│   ├── event-handler.ts  # WebSocket 事件分发
│   └── sender.ts   # 飞书 HTTP API 客户端
├── index.ts         # 入口：WS 连接、健康检查、优雅关闭
├── config.ts        # 配置加载
├── types.ts         # 类型定义
└── logger.ts        # Pino 日志
```

## 设计理念

- **线程即会话** — 飞书的线程模型天然映射到 Claude Code session
- **零数据库** — 会话数据复用 Claude Code 原生存储（`~/.claude/`）
- **手机优先** — 折叠面板、按钮操作、最少打字
- **不侵入** — 不修改 Claude Code 配置，不影响 VSCode 使用

## License

MIT
