# 猫猫本地后端

## 启动

```powershell
cd backend
npm install
$env:MAOMAO_EMAIL = "demo@example.com"
$env:MAOMAO_PASSWORD = "change-me"
npm start
```

访问 `http://127.0.0.1:8080/`。默认静态资源来自上级目录的 `pulled-frontend/`。

## 账号流程

- 注册沿用参考页面的昵称、邮箱、密码三项，不要求邮件验证码；项目未配置邮件服务。
- 注册成功后自动建立登录会话。邮箱统一转为小写，重复邮箱会被拒绝。
- 密码使用 Node.js `scrypt` 加盐哈希保存，不会以明文写入账号文件。
- `MAOMAO_EMAIL` / `MAOMAO_PASSWORD` 配置的本地演示账号仍可登录；默认值仅用于本机开发。
- 会话仅保存在进程内存中：服务重启后必须重新登录。
- `MAOMAO_LOCAL_RECOVERY=false` 可关闭无会话时的本地账号兜底；自动化测试始终关闭它，以便真正验证鉴权。

## 持久化

后端会把已接入模块的数据保存为 JSON，而不只是保存账号。当前包括账号、玩家进度、市场、好友/聊天/公会、村庄与家政、拍卖、玩家商店和战斗房间。路径可分别覆盖：

| 环境变量 | 默认文件 |
| --- | --- |
| `MAOMAO_ACCOUNT_FILE` | `data/accounts.json` |
| `MAOMAO_PLAYER_FILE` | `data/players.json` |
| `MAOMAO_MARKET_FILE` | `data/market.json` |
| `MAOMAO_SOCIAL_FILE` | `data/social.json` |
| `MAOMAO_VILLAGE_FILE` | `data/village.json` |
| `MAOMAO_HOME_SERVICE_WAL_FILE` | `data/home-service-transaction.json` |
| `MAOMAO_AUCTION_FILE` | `data/auctions.json` |
| `MAOMAO_SHOP_FILE` | `data/shops.json` |
| `MAOMAO_ROOM_FILE` | `data/rooms.json` |

未接入或没有可靠数据模型的功能不会用空对象、空数组或零值伪装成功：REST 返回 HTTP `501` 与 `UNSUPPORTED_FEATURE`；Socket.IO 返回该前端契约对应的单一 `:error` 或 `:fail`。真正未知的 Socket 事件返回 `UNSUPPORTED_EVENT`。

## 自动化测试

```powershell
cd backend
npm install
npm test
```

测试使用 Node.js 内置 `node:test` 串行运行，并覆盖：

- REST 与 Socket.IO 鉴权、输入错误和明确的 unsupported 契约；
- 两个同时在线账号的好友请求、接受和公共聊天广播；
- 玩家与社交数据落盘；
- 强制终止进程、换用新端口重启、旧会话失效、重新登录及状态恢复；
- 测试前后正式 `backend/data/*.json` 的 SHA-256 内容保持一致。

测试进程直接启动 `server.js`，动态分配回环端口且明确拒绝 `8080`。它为上表九个路径全部创建独立临时文件，并设置 `MAOMAO_LOCAL_RECOVERY=false`；因此不会读取、写入或以正式存档作为测试种子。每个 HTTP、Socket、启动、磁盘轮询和进程退出等待都有超时。

## 技能数据

- `skill-catalog.js` 由参考站前端 bundle 生成：`python backend/tools/gen-skill-catalog.py`（需要同级目录有 `pulled-frontend/`）。不要手改，下次生成会覆盖。
- `battle-skills.js` 是战斗技能引擎：选技能/目标、数值求值、状态挂载与回合结算，另有参考站里写在控制流中的少数技能（驱散、惩戒、识破魔法、群体沉默等）的手写实现。

## 其他限制

这不是原站完整后端。当前持久化只涵盖已实现并显式纳入存档的数据；内存会话以及尚未实现的模块不会跨重启恢复。前端构建产物也无法恢复原始数据库、邮件验证和全部业务规则。生产使用前仍需接入正式数据库、持久化会话、CSRF、限流、备份和实际邮件服务。
