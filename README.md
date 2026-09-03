# fn-calendar — 飞牛 fnOS 日历应用

一款以 macOS 日历为 UI 参考的飞牛 fnOS 桌面日历应用，通过 fpk 手动安装，内置农历、节气、传统节日与法定节假日支持。

## 功能

- **四种视图**：月 / 周 / 日 / 年，工具栏分段切换
- **农历信息**：农历日期、干支纪年、生肖、节气、传统节日、法定节假日（通过 `lunar-javascript` 计算，无需联网）
- **日程管理**：新建 / 编辑 / 删除日程，标题、全天、开始/结束时间、备注，按日历着色，双击空白处快速新建
- **CalDAV / ICS 日历订阅**：支持添加公开 iCalendar（.ics / webcal://）订阅链接和带账号密码的私有 CalDAV 日历，自动同步（含循环日程展开），远程日程只读显示、可按日历显隐
- **侧边栏**：今日卡片（含农历/干支/生肖）、迷你月历、日历列表
- **嵌入桌面**：点击飞牛桌面图标直接在当前页面打开（iframe 入口，不跳转新标签页）
- **统一网关**：通过 fnOS 统一网关（Unix Socket + `/app/fn-calendar` 前缀）访问，无需暴露独立端口

## 安装

1. 将 `fn-calendar/fn-calendar.fpk` 拷贝到能访问飞牛 NAS 的电脑上
2. 打开飞牛网页端：**应用中心 → 设置（右上角齿轮）→ 手动安装**
3. 选择 `fn-calendar.fpk`，确认安装
4. 安装完成后，桌面会出现「日历」图标，点击即可在当前页面使用

> 要求 fnOS ≥ 0.8.0，x86 平台。应用内置 Node.js v22 运行时，无需系统额外安装。

## 本地开发调试

不打包时可直接运行后端（TCP 模式，默认端口 3100）：

```bash
cd app/server
UI_DIR=../ui DATA_DIR=/tmp/fncal-data PORT=3100 node server.js
# 浏览器打开 http://localhost:3100
```

不设置 `FNNAS_GATEWAY_SOCKET` 时，服务自动切换为 TCP 监听模式；在 fnOS 上由 `cmd/main` 注入该环境变量，走 Unix Socket 统一网关。

## 目录结构

```
fn-calendar/
├── manifest              # fpk 应用清单
├── ICON.PNG / ICON_256.PNG
├── config/               # fpk 安装配置
├── wizard/               # 安装向导（空）
├── cmd/
│   └── main              # start/stop/status 生命周期脚本（导出网关环境变量）
└── app/
    ├── ui/
    │   ├── config        # 桌面入口声明（iframe 类型 + gatewaySocket/Prefix）
    │   ├── index.html
    │   ├── styles.css    # macOS 风格样式
    │   ├── app.js        # 前端逻辑
    │   └── images/       # 图标
    └── server/
        ├── server.js     # Node 后端（HTTP + API + 静态文件）
        ├── node          # Linux x64 Node.js v22 运行时
        ├── package.json  # 依赖 lunar-javascript
        └── node_modules/
```

## 后端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/today` | 今日农历、干支、生肖、节日 |
| GET | `/api/months/:y/:m` | 某月每日农历/节日数据 |
| GET | `/api/events?start=&end=` | 查询区间内日程 |
| POST | `/api/events` | 新建日程 |
| PUT | `/api/events/:id` | 更新日程 |
| DELETE | `/api/events/:id` | 删除日程 |
| GET | `/api/calendars` | 远程日历源列表 |
| POST | `/api/calendars` | 添加日历源（ics / caldav，含账号密码） |
| DELETE | `/api/calendars/:id` | 删除日历源 |
| POST | `/api/calendars/sync` | 同步全部日历源 |
| POST | `/api/calendars/:id/sync` | 同步单个日历源 |
| GET | `/api/calendars/events?start=&end=` | 远程日历缓存事件（区间过滤） |

日程数据持久化在 fnOS 的应用数据目录（`TRIM_PKGVAR`）下的 `events.json`，原子写入防损坏；远程日历源保存在 `calendars.json`（含凭据，仅存本机），抓取的事件缓存在 `cache/` 目录，首次加载后台自动同步，循环日程（RRULE）自动展开（过去 2 年 ~ 未来 3 年）。

## CalDAV / ICS 使用提示

- **URL 只需填服务器根地址**（如 `https://caldav.feishu.cn`、`https://dav.example.com`），后端会自动发现日历集合（PROPFIND calendar-home-set → 枚举子日历）再逐集合同步；公开订阅填 `.ics` 直链即可
- **添加失败不阻塞保存**：服务器暂时不可用或权限不足时日历仍会入库并标红，可稍后在日历列表中点击 ⟳ 手动重试
- **飞书 CalDAV**：网页版账号密码只能通过认证和发现日历，服务端会拒绝下发日程内容（`calendar-data` 404）。若添加飞书日历后同步报「服务器拒绝了日程内容」，请在飞书客户端「设置 → 日历 → CalDAV 同步配置」**重新生成专用密码**，用新密码重新添加

## 重新打包

```bash
cd fn-calendar
node ../tools/runfnpack.mjs build   # 生成 fn-calendar.fpk
```
