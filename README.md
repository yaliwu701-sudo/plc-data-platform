# PLC 数据采集与管理平台 + ECharts BI 面板

基于 **Node.js 全栈 + ECharts** 的 PLC 数据采集、管理与 BI 可视化平台。
支持 **欧姆龙 / 西门子 / 三菱 / 台达** 等品牌的 PLC 控制器，支持**批量增加采集点位**，
内置**模拟数据引擎**，开箱即跑通；同时内置**真实 PLC 连接器**，安装驱动即可切换。
平台带**登录鉴权**，并支持 **Docker 一键部署到云主机 / Render**。

## ✨ 功能清单

- **登录鉴权**：默认 `admin / admin123`，可在界面改密、环境变量覆盖，API/WebSocket 均需登录
- **多品牌 PLC 管理**：欧姆龙 / 西门子 / 三菱 / 台达（可扩展）
- **批量采集点位**：CSV 一键批量添加，支持 浮点/整数/布尔 类型与报警阈值
- **概览面板**：实时数值 + 仪表盘 + KPI 卡片（当前/均值/最值）+ 最新报警
- **趋势分析**：多点位对比曲线，支持 5 分钟 ~ 24 小时窗口
- **报警中心**：超阈值报警列表（高报/低报）、活动/已确认筛选、确认/清空
- **报表导出**：统计报表（计数/均值/最值/标准差）+ CSV 导出（历史/实时快照）
- **真实 PLC 接入**：欧姆龙(FINS) / 西门子(S7) / 三菱(MC) / 台达(Modbus) 四类连接器，缺驱动优雅降级
- **实时推送**：WebSocket 秒级刷新当前值、仪表盘、趋势、报警
- **明暗主题**：右上角一键切换，记忆偏好
- **本地 / 云部署**：`npm start` 本地跑；`docker compose up` 一键上云

## 🚀 快速开始（模拟数据，推荐先跑通）

```bash
cd plc-data-platform
npm install
npm start
```

打开浏览器：

- 本机：http://localhost:3000
- 同网段其他电脑：http://<你的局域网IP>:3000 （启动日志会打印局域网地址）

> 端口被占用时会自动顺延（看启动日志实际端口）。登录账号：`admin` / `admin123`。

首次运行自动注入 4 台示例设备（欧姆龙/西门子/三菱/台达）及点位，直接看到实时曲线与报警。

## 🔐 登录与账号

- 默认账号：`admin` / `admin123`
- 修改密码：登录后界面内「设置」式交互暂未做独立页，可用接口：
  `POST /api/password { oldPass, newPass }`（新密码≥6 位，哈希落盘到 `data/config.json`）
- 环境变量覆盖（适合云部署/多实例）：
  - `ADMIN_USER`：登录用户名（默认 `admin`）
  - `ADMIN_PASS`：登录密码（默认 `admin123`，**生产务必修改**）
- 未携带有效 token 访问 `/api/*` 返回 `401`；WebSocket 需带 `?token=`。

## 🔌 接入真实 PLC

默认 `mock` 模式使用模拟引擎。切换真实 PLC：

1. **网络可达**：这台机器能访问到 PLC（同网段或路由可达）
2. **安装驱动库**（已写入 `package.json` 的 `optionalDependencies`，`npm install` 会尝试安装；
   含原生编译的 `node-snap7` / `modbus-serial` 若本机无编译环境会安装失败，不影响其余功能）：

   | 品牌 | 驱动库 | 协议 | 是否纯 JS |
   | --- | --- | --- | --- |
   | 欧姆龙 Omron | `node-omron-fins` | FINS/TCP | ✅ |
   | 西门子 Siemens | `node-snap7` | S7 (ISO-TCP) | ❌ 需编译 |
   | 三菱 Mitsubishi | `mcprotocol` | MC Protocol | ✅ |
   | 台达 Delta | `modbus-serial` | Modbus TCP/RTU | ❌ 需编译 |

3. **切换模式**：界面左下角「模拟数据 / 真实 PLC」下拉切换，或 `POST /api/config { mode: "real" }`，
   或环境变量 `PLC_MODE=real`。
   切换后连接器会按设备品牌建立连接并轮询读数，写入实时值（BI/报警/导出逻辑无需改动）。
4. **连接状态**：设备卡上显示 `● 已连接 / ● 离线 / ● 缺驱动`；侧边栏底部显示聚合状态。
   驱动缺失或连接失败时**优雅降级**，不会拖垮服务；离线设备后台自动重连。

> 各品牌 `read()` 的地址解析为「典型用法参考」，实际 PLC 型号/地址表示/字长需对照驱动库文档微调
> （详见 `server/connectors/index.js` 注释）。建议先在 `mock` 模式把 BI 流程跑通，再切真实设备。

## ☁️ Docker 一键部署（云主机 / Render）

### 方式一：docker compose（任意装了 Docker 的云主机 / VPS）

```bash
cd plc-data-platform
docker compose up -d --build      # 构建并后台运行
# 访问 http://<云主机IP>:3000
docker compose down               # 停止
```

- 数据持久化：`./data` 已挂载到容器内 `/app/data`（设备/点位/配置不丢）
- 改端口：编辑 `docker-compose.yml` 的 `ports: "8080:3000"`
- 改密码/模式：在 `docker-compose.yml` 的 `environment` 设置 `ADMIN_PASS`、`PLC_MODE`

### 方式二：Render.com（免费，自动读 render.yaml）

在 Render 控制台 `New +` → `Web Service` → 连接本仓库，Render 会自动读取 `render.yaml`
（Docker 运行时、`/api/health` 健康检查）。部署后访问分配的 `.onrender.com` 域名。

### 方式三：其他（VPS + PM2 + nginx）

```bash
npm install
npm run start                         # 或 pm2 start server/index.js --name plc
# nginx 反向代理 3000 -> 80/443，并配置 HTTPS
```

## 🧩 REST API 速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录 `{user,pass}` → `{token}` |
| POST | `/api/logout` | 登出（需 token） |
| GET | `/api/me` | 当前用户（需 token） |
| POST | `/api/password` | 修改密码（需 token） |
| GET | `/api/health` | 健康检查（公开） |
| GET | `/api/config` | 配置（mode/tickMs） |
| POST | `/api/config` | 修改配置（切换 mock/real） |
| GET | `/api/devices` | 设备列表（含连接状态） |
| POST | `/api/devices` | 新增设备 `{name,brand,model,ip,protocol}` |
| DELETE | `/api/devices/:id` | 删除设备 |
| POST | `/api/devices/:id/points` | 批量加点位 `{points:[...]}` |
| DELETE | `/api/points/:id` | 删除点位 |
| GET | `/api/points` | 全部点位 |
| GET | `/api/values` | 实时值快照 |
| GET | `/api/points/:id/history?window=300000` | 点位历史 |
| GET | `/api/kpi?ids=&window=` | KPI（当前/均值/最值） |
| GET | `/api/alarms?filter=all\|active\|acked` | 报警列表 |
| POST | `/api/alarms/:id/ack` | 确认报警 |
| POST | `/api/alarms/clear` | 清空报警 |
| GET | `/api/status` | PLC 连接状态 |
| GET | `/api/export/snapshot` | 导出实时快照 CSV |
| GET | `/api/export/history?ids=&window=` | 导出历史 CSV |
| WS | `/ws?token=...` | 实时数值/报警/状态推送（需 token） |

> 除 `/api/login`、`/api/health` 外，所有 API 均需 `Authorization: Bearer <token>`。

## 📁 项目结构

```
plc-data-platform/
├── Dockerfile / docker-compose.yml / render.yaml   # 一键云部署
├── package.json
├── server/
│   ├── index.js        # Express + WebSocket 服务入口（鉴权/路由/模式切换）
│   ├── auth.js         # Token 鉴权（登录/校验/改密）
│   ├── store.js        # JSON 持久化 + 示例种子数据
│   ├── simulator.js    # 模拟采集引擎 + 报警判定（applyExternal 供真实数据注入）
│   └── connectors/     # 真实 PLC 连接器（omron/siemens/mitsubishi/delta）
├── public/
│   ├── index.html
│   ├── css/styles.css
│   ├── js/api.js       # 前端 API 封装（带 token）
│   ├── js/charts.js    # ECharts 图表封装（明暗主题）
│   ├── js/app.js       # 主逻辑 / 五个视图 / 实时刷新 / 登录
│   └── vendor/echarts.min.js  # 本地内置，离线可用
└── data/               # 运行时生成的 devices.json / config.json
```

## ⚙️ 运行参数

- 端口：`PORT=8080 npm start`（默认 3000，被占用自动顺延）
- 绑定：`HOST=127.0.0.1 npm start`（默认 0.0.0.0，允许局域网/外部访问）
- 采集频率：`tickMs`（默认 1000ms，可在 `/api/config` 调整）
- 运行模式：`mode`（`mock` / `real`），可用环境变量 `PLC_MODE` 强制
- 登录：`ADMIN_USER` / `ADMIN_PASS`（默认 admin / admin123）
