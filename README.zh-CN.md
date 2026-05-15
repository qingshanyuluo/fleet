# Fleet — 手机上的 Claude Code 终端

在飞书上发条消息，就能启动一个完整的 Claude Code 会话。线程就是 session，随时恢复，随处查看。

## 为什么做 Fleet

地铁上想让 Claude 修个 bug？开会时想看重构跑完没？不想为一个小任务打开电脑？

Fleet 把飞书变成 Claude Code 的远程终端。每个线程是独立会话，手机上开始、电脑上继续、明天接着聊——都是同一个对话。

## 核心能力

**发消息即开始** — 发任何文字，Fleet 在你的项目目录启动 Claude Code，实时流式返回交互卡片。

**线程内继续** — 在线程里回复就是继续对话，完整上下文。

**查看运行中的会话** — Claude 在 VSCode 里跑着？点 👀 Watch 实时看输出。

**随时 Fork** — 看到有意思的会话？Fork 一份，完整历史带走。

**全局搜索** — `/list 部署修复` 找到上周修 deploy 脚本的那个会话。

**不丢上下文** — 会话映射持久化到磁盘。重启服务、换设备，线程照样连到正确的 session。

**智能假死检测** — API 无响应 30 秒或工具执行卡住 3 分钟，自动停止并通知。回复即可继续。

**原生表格** — Claude 输出 markdown 表格？Fleet 渲染成飞书原生表格组件，不是竖线乱码。

## 快速开始

```bash
git clone https://github.com/qingshanyuluo/fleet.git
cd fleet
npm install
cp config.example.json config.json
# 填入飞书 App ID 和 Secret
pm2 start ecosystem.config.cjs
```

前置条件：Node.js 20+，Claude Code 已安装（`npm i -g @anthropic-ai/claude-code && claude login`），飞书自建应用（Bot + WebSocket 长连接）。

## 命令

| 命令 | 作用 |
|------|------|
| `/dash` | 仪表盘 |
| `/list` | 浏览会话（折叠面板 + 对话预览） |
| `/list <关键词>` | 搜索所有历史会话 |
| `/projects` | 切换项目目录 |
| `/stop` | 停止当前任务（线程内） |
| `/reset` | 重置会话（线程内） |

## 飞书应用配置

1. [开发者后台](https://open.feishu.cn/app) → 创建自建应用 → 添加机器人
2. 权限：`im:message`、`im:message:readonly`、`im:resource`
3. 事件：订阅方式选**长连接**，订阅 `im.message.receive_v1` + `card.action.trigger`
4. 发布

## 配置文件

```json
{
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "...",
  "defaultWorkingDirectory": "~/Code",
  "claude": { "model": "claude-opus-4-7" },
  "folders": {
    "myapp": "/Users/you/Code/myapp",
    "infra": "/Users/you/Code/infra"
  }
}
```

## 工作原理

Fleet 通过 Agent SDK 启动 Claude Code 子进程，逐 token 流式输出到飞书交互卡片，线程映射到 session。状态存在 `~/.fleet/state.json`，无数据库。

## License

MIT
