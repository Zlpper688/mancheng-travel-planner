# 漫城 HANDOFF —— 给接手 Agent 的交接文档

> 最后更新：2026-11-26 21:25 ｜ 分支 `main` ｜ 远端 `github.com/Zlpper688/mancheng-travel-planner`
> 当前 HEAD：`3adf5c8`

这是一份**自包含**的交接文档。你不需要看历史对话，读完这份就能接手。
**开工前请按顺序读这三个文件：**

1. `PRODUCT.md` —— 项目宪法（定位、三条原则、决策记录 15 项）。**任何功能取舍先回到它**，不要凭感觉加需求。
2. 本文件 —— 现状、代码地图、坑、待办。
3. `data/knowledge/enrichment/README.md` —— 景点核实数据的填写规范。

---

## 1. 一句话与三条铁律

**漫城是一个把大模型装进旅行领域框架的 harness：喂足真实信息，让 LLM 驾驭排程引擎，再用多个 agent 反复反驳，几轮之后才交给用户。**

不是聊天机器人，也不是纯约束求解器。**约束不拿来限制生成，拿来检验生成。**

| 铁律 | 内容 |
|---|---|
| **硬约束不可动** | 日期、天数、人数、用户点名必去点、已订酒店、排除点 —— LLM 与引擎一律不得静默修改；冲突必须提醒 + 给建议 |
| **不替用户决定，但替他算清后果** | 冲突时给 2–3 个真实可执行替代方案，标明牺牲/得到/风险，用户选 |
| **选点纯度 > 覆盖率** | 「留白」是节奏需求，「必去点覆盖」是选点质量底线；两者不冲突，没排进去的必去点必须给理由 |

比赛场景：**全国软件创新大赛**（截止时间较晚，优先把底子做对）。取舍标准：评委能否在几分钟内看出不可替代性。

---

## 2. 当前进度

### 已完成（A / B / C 三块全部落地）

| 块 | 内容 | 关键提交 |
|---|---|---|
| **A 核心** | PlanParams 软参数层 · 6 段 Slot 结构 · critic 接进生成循环 + P0–P3 · 区域环线分段换基地 · 六种目的地形态全部可用 | `7fcf466` `eac5ba7` `41dadd6` `49778ee` |
| **B 落地** | 一键导航/查票（高德官方 URI）· 行前待办汇总（预约提醒） | `d71c137` |
| **C 闭环** | 旅行记录 → 分享 → 一键导入同款 | `d5382e1` |

### 未做（按价值排序）

1. **高德预生成池** —— 5 个 Key × 5000 次/日 ≈ 2.5 万次/天，两天可跑完 122 城，
   把候选池从 1012 个点扩到几万条 POI（含评分）。这是数据护城河。注意：单次请求最多 200 条，
   必须用「城市多边形/网格 + types 枚举」，关键词搜索会漏点。
2. **LLM critic** —— 现有 critic 是规则引擎（`critic.ts`）。若答辩要展示"AI 反驳 AI"，
   可在 `refine.ts` 外面包一层云端 LLM critic。
3. **截图识别订单** —— 依赖云端多模态（本地 35B 纯文本做不了），成本最高，优先级最低。
4. **川藏多日精细化** —— 1300km 给 4 天本就偏紧，当前只排沿途代表点。

---

## 3. 代码地图（按职责，不是按目录）

### 排线主链路

```
/api/plan (src/app/api/plan/route.ts)
  → sanitizeTripInput (lib/plan/validate.ts)     ← 入参校验 + 解析 planParams
  → refinePlan (lib/plan/refine.ts)              ← 生成→反驳→修订循环
      └→ planTrip (lib/plan/engine.ts)           ← 一次完整生成
          ├→ discoverForTrip                     ← 实时源 + 本地知识库合并
          │   └→ lib/providers/knowledge.ts      ← 读 data/knowledge，判形态，必去点给高热度
          ├→ planLodging (lib/plan/lodging.ts)   ← 多基地/景区门户/换宿建议
          ├→ selectDays (lib/plan/select.ts)     ← 单城选点；区域游走 selectRegionDays
          │   └→ selectRegionDays (lib/plan/select-region.ts)
          │       └→ segments.ts                 ← k-center 地理分段
          ├→ scheduleDay (lib/plan/schedule.ts)  ← 每天排时刻
          └→ days.map(withSlots) (lib/plan/slots.ts) ← 投影成 6 段
```

### 质量与诊断

| 文件 | 作用 |
|---|---|
| `lib/plan/params.ts` | **PlanParams 软参数层**。默认值 = 原硬编码，不传零回归；`sanitizeParams` 收敛 LLM 乱值 |
| `lib/plan/audit.ts` | 硬校验：时间重叠、跨度、单段路程、吃饭窗口 |
| `lib/plan/critic.ts` | 规则 critic（rush/backtrack/fatigue/monotony/gap…），输出 high/medium/low |
| `lib/plan/refine.ts` | 把 audit+critic 统一映射成 **P0–P3**，按字典序选最佳版本，最多 3 轮，连续两轮无改善早停 |

### 界面

| 文件 | 作用 |
|---|---|
| `components/PlannerApp.tsx` | 主控（1205 行）：状态、请求、分享、记录接线、头部导航 |
| `components/PlanPanel.tsx` | 行程面板（1500+ 行）：6 段骨架条 `SlotStrip`、点位卡 `StopRow`、行前待办 `BookingCard` |
| `components/MapView.tsx` | 地图（1016 行） |
| `components/SetupPanel.tsx` | 左侧偏好设置 |
| `app/journal/page.tsx` | 旅行记录页（独立路由） |
| `app/chat/page.tsx` + `lib/chat/model.ts` | 对话收约束（7 维度顺序 + 自由语言→参数 + 防编造） |

### 数据与工具

| 文件 | 作用 |
|---|---|
| `lib/journal.ts` | 旅行记录数据层（localStorage，不做账号，同城同日同名去重，上限 50） |
| `lib/share.ts` | **配方编码**（`TripRecipe` → URL 查询串）——「一键导入同款」的基础，别重复造 |
| `lib/booking.ts` | 导航/查票跳转（高德 URI）+ `collectBookings` 行前待办汇总 |
| `content/places.ts` | 100 条景点 profile（booking/bookingNote/bestTime/duration + source），6 城 |
| `lib/tips/` | 从 profile 生成点位提示（预约、最佳时段等）已在用 |

---

## 4. 数据资产

```
data/guides/            130 份攻略 JSON（原始语料）
data/knowledge/
  index.json            122 城清单 + 统计
  cities/<city>.json    建模产物：must（必去点，保序）/ places（聚合）/ routeTemplates
  enrichment/<city>.json 联网核实的真坐标 + 门票 + 简介（122 个包 / 1012 个坐标 / 40 个留白）
  enrichment/README.md  填写规范（key 必须与 must 一字不差、经纬度不写反、查不到留白）
data/city-centers.json  城市中心坐标
```

**数据生成脚本**

```bash
node scripts/learn-guides.mjs        # 攻略 → cities/ + index.json
node scripts/fill-centers.mjs        # 13 城权威中心回填
node scripts/classify-destinations.mjs  # 形态分类（输出 destination-forms.json）
```

**红线：坐标必须有出处。查不到就放 `unverified`，绝不编造。**

---

## 5. 怎么跑起来

```bash
# 依赖
npm install

# 环境变量（.env.local，已在 gitignore）
AMAP_KEY=            # 可选，高德 Web 服务 Key；没有就走开放数据 + 本地知识库
AI_BASE_URL=https://api.agnes-ai.cn/v1    # 对话模型（OpenAI 兼容）
AI_API_KEY=
AI_MODEL=agnes-2.5-flash

# 开发
npx next dev -p 3120

# 生产构建
NEXT_DIST_DIR=.next-build/verify-$(date +%H%M%S) npm run build
```

### ⚠️ 跑服务必须注意的三个坑

1. **必须用全新的 `NEXT_DIST_DIR`**。复用 `.next` 会触发 safe-delete 守卫（批量删除超 50 个文件被拦截），
   表现为 build 失败但其实是环境拦截，不是代码错误。
2. **`next dev` / `next build` 会自动改写 `tsconfig.json` 和 `next-env.d.ts`**。
   `next build` 实测会往 `include` 里追加一条当前 distDir 的路径（例如
   `".next-verify/types/**/*.ts"`），跑完必须还原再提交：
   `git checkout HEAD -- tsconfig.json next-env.d.ts`。
   所有 `.next-*/` 目录已经进 `.gitignore`，但 `tsconfig.json` 不在里面，得手动还原。
3. **端口不要用 3000**（有一个坏掉的旧实例）。用 3120 之类的新端口。

---

## 6. 怎么验证（一条命令跑完）

```bash
npm run verify        # = typecheck + 字号护栏 + 十套纯函数回归
```

拆开跑：

```bash
npm run typecheck                                 # tsc --noEmit（真正的类型检查）
npm run check:font                                # 字号护栏（禁止正文 <10px；原来叫 check:type，容易误解）
npm run checks                                    # 下面十一套依次跑

# 十套回归，各自守一条不变量：
npx tsx scripts/check-params.ts                   # PlanParams 零回归 + 乱值收敛
npx tsx scripts/check-slots.ts                    # 6 段投影 + 空段话术 + 局部替换隔离
npx tsx scripts/check-refine.ts                   # P0–P3 分级 + 修复判定
npx tsx scripts/check-segments.ts                 # 区域分段：不重不漏 + 单城兜底
npx tsx scripts/check-journal.ts                  # 记录归档 + 分享文本 + 配方往返
npx tsx scripts/check-booking.ts                  # 跳转链接 + 待办汇总
npx tsx scripts/check-city-search.ts              # 城市索引：精确优先 / 前缀 / 空查询
npx tsx scripts/check-disk-cache.ts               # 磁盘缓存：TTL / 坏档降级 / 永不抛错
npx tsx scripts/check-dedupe.ts                   # 同名景点合并 + 跨天重复检测
npx tsx scripts/check-rate-limit.ts               # 接口限流阈值 / Retry-After / 隔离
npx tsx scripts/check-photo-storage.ts            # 图片持久化：失败不落盘 / 刷新恢复 / 配额
npx tsx scripts/check-knowledge.mjs               # 坐标合法性 + 经纬度不写反 + must 对齐（不在 checks 里，需要 data/）
```

**当前状态：全部通过。** `.github/workflows/verify.yml` 在每次 push 上跑同一套 + `next build`。

端到端手工验证（起服务后）：

```bash
# 单城：成都 2 天（应命中宽窄巷子/春熙路/文殊院/青羊宫）
curl -s -X POST http://127.0.0.1:3120/api/plan -H 'Content-Type: application/json' \
  -d '{"city":"成都","center":[104.066,30.657],"days":2,"date":"2026-12-08","pace":"chill","adults":2,"children":0,"budgetTier":"comfort","transport":"auto","styles":["citywalk","foodie"],"seed":42}'

# 区域：北疆 3 天（应出现喀纳斯/禾木/白哈巴，住宿落"喀纳斯景区一带"）
curl -s -X POST http://127.0.0.1:3120/api/plan -H 'Content-Type: application/json' \
  -d '{"city":"北疆","center":[87.616824,43.825377],"days":3,"date":"2026-09-06","pace":"balanced","adults":2,"children":0,"budgetTier":"comfort","transport":"drive","styles":["classic"],"seed":42}'
```

---

## 7. 已经踩过的坑（**别重踩**）

| 坑 | 现象 | 结论 |
|---|---|---|
| **`selectDays(days=1)` 只选 1 个点** | 区域分段后每段只出 1 个点 | 它是为单城多天设计的，days=1 只取 1 个 anchor。区域游改为**直接构造 DaySeed** |
| **段内按 popularity 取点全挤一角** | 北疆只排白哈巴/五彩滩，喀纳斯禾木被晾着 | 改为「按离段中心距离均匀取样」，保证覆盖段内不同片区 |
| **区域游被城市尺度审计误判** | refine 3 轮空转、把点数从 4 压到 2 | 区域形态下过滤 `LEG_TOO_LONG/DAY_SPAN_WIDE/DAY_TRAVEL_LONG` 与 `backtrack/long-day` |
| **距离防护降级热度是错的** | 曾把喀纳斯等远点降级，导致永远住不到景区门口 | 必去点保持高热度，远近只打 `far-sight` 标记，交给 gateway/远足逻辑判断 |
| **`URLSearchParams` 会编码逗号/空格** | 断言 `position=104.1,30.6` 失败 | 测 URL 参数要用 `new URL(u).searchParams.get()` 解码 |
| **tsx 不支持 top-level await** | `Top-level await is currently not supported with "cjs"` | 脚本用 async IIFE 包一层，或写静态 import |
| **`.mjs` 检查脚本不能加 `.ts` 后缀** | `check-knowledge.ts` 不存在 | knowledge 检查是 `.mjs`，其余是 `.ts` |
| **heredoc 提交消息带 `@`** | 提交标题变成 `@ feat(...)` | 用 `git commit -m @'...'@` 时别把 `@` 留在首行（已推送的不强推修正） |
| **Photon 公共端点会限流** | 批量跑 122 城时 103 城失败、IP 被封 | 只适合低频单点；不要做全量批量 |

---

## 8. 协作铁律（用户明确要求）

1. **动手前先备份**：`git bundle create .backup-auto/repo-$(date +%Y%m%d-%H%M%S).bundle --all`
   + `cp -r src .backup-auto/src-<时间戳>`（两代滚动）
2. **不碰 git 的破坏性操作**：不 `reset --hard`、不 `push --force`、不 `--amend` 已推送的提交。
   正常提交 + 快进推送即可。
3. **TDD / 测量驱动**：先写检查脚本证明「默认零回归 + 新行为生效」，再改实现。
4. **每模块跑通再进下一步**，不留半成品。
5. **实质性工作后写记忆**：`.workbuddy/memory/YYYY-MM-DD.md`（追加，不覆盖）。
6. **不做降级方案换可行性**：用户明确反对「为跑通而降低质量」。卡住就查根因。

---

## 9. 如果你只想做一件事

先跑一遍第 6 节的八套回归 + 两个 curl 端到端，确认基线是绿的。
然后从第 2 节的「未做」里挑一件，**先读 `PRODUCT.md` 判断它是否符合宪法**，再动手。
