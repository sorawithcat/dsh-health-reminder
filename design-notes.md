# 久坐健康提醒插件 — 设计笔记

## 目标
给上班久坐的用户做 DSH 插件：按可配置的作息（默认周一~周六 10:00-19:00）定时提醒
「喝水 💧 / 起身活动 🧍 / 护眼 👀 / 拉伸 🤸」，把统计留在本机；
并且能把**整套提醒配置存成多套方案**，随时切换 / 编辑——插件本身完全离线，不调用任何模型。

## 配置模型（持久化 JSON）
```jsonc
// localStorage：health-reminder/state.v1（一个对象，settings + records + runtime + plans）
{
  "settings": {
    "version": 3,
    "enabled": true,
    "workdays": [1,2,3,4,5,6],          // 1=周一 … 7=周日
    "dayStart": "10:00",                // 上班时间
    "dayEnd": "19:00",                  // 下班时间
    "lunchEnabled": true,
    "lunchStart": "12:00",
    "lunchEnd": "13:00",
    "kinds": {                          // 每一类：on / intervalMin / target（+ 类型专属字段）
      "water":   { "on": true,  "intervalMin": 60, "target": 8,  "glassMl": 250 },
      "stand":   { "on": true,  "intervalMin": 45, "target": 8,  "minutes": 3 },
      "eyes":    { "on": false, "intervalMin": 20, "target": 12 },
      "stretch": { "on": false, "intervalMin": 90, "target": 3 }
    },
    "notify": { "system": true, "inApp": true, "sound": true, "volume": 0.7, "tone": "ding", "muteFullscreen": true },
    "quiet": { "enabled": false, "start": "22:00", "end": "08:00" }
  },
  "records": { "2026-10-10": { "water": 4, "stand": 5, "eyes": 9, "stretch": 1, "skips": 4, "log": 23 } },
  "runtime": { "fired": {}, "pending": [], "snooze": {}, "muted": [] },
  "plans": [ { "id": "plan-…", "name": "工作日上午", "createdAt": 0, "updatedAt": 0, "settings": { /* 同上，整份快照 */ } } ],
  "activePlanId": "plan-…"
}
```
`normalizeSettings()` 负责把所有入口的脏值收敛到合法范围（间隔 5~240 分钟；
每类目标按类型收到 1~24（喝水 / 起身）、1~40（护眼）、1~12（拉伸）；每杯 100~800 ml；
每次活动 1~30 分钟；时刻必须是 `HH:MM`；`workdays` 去重排序且不能为空）；
读盘时 `normalizePlans()` 丢坏项、去重复 id、给无名项兜名字。

## 判定逻辑（纯函数，可单测）
固定时刻表——提醒时刻只由「起始时间 + N × 间隔」决定，暂停 / 恢复 / 完成 / 跳过 / 记录都不会把它往后推：

- `daySlots(settings, kind, dayOffset, now)`：从 `dayStart` 起按 `intervalMin` 步步加直到 `dayEnd`，
  只留下通过 `inSchedule`（上班日 + 窗口内 + 不在午休 / 免打扰）的点。被挡住的点**直接丢掉、不补**，
  午休结束后仍按原网格继续（不重新对齐）。
- `nextSlotAt` / `lastSlotAt` 在这张表上取「下一个点」/「不晚于现在的最后一个点」（最多前后各找一周）。
- `computeDue(state, now)`：只认表上的点，每个点只处理一次（记在 `runtime.fired[kind]`），
  一次 tick 每个类型最多产生一个 `due`，不会堆积；显式推迟（`snooze`）期间只看推迟时刻、不看网格。
- 迟到窗口 `LATE_MS = 2 分钟`（`client.js:38`）：到点后超过 2 分钟才发现（应用关了太久）→ 只记已处理、不补发。
- 完成 / 跳过 / 手动「记一杯水 / 记一次起身」只写 `records`，**不会**把下一次推到「现在 + 间隔」；
  「今天不再提醒」= 顺延到下一个有提醒的上班日的第一个点。
- 缺省示例（10:00-19:00，水 60 分钟、站 45 分钟，午休 12:00-13:00）：
  水 = 11:00, 12:00（落在午休里，丢掉）, 13:00, 14:00 …；站 = 10:45, 11:30, 12:15（落在午休里，丢掉）, 13:00, 13:45 …

## 多套方案（本机，随时切换）
**一句话版本**：一份方案 = 一份**完整配置快照**（作息 + 每类的间隔 / 目标 / 开关 + 提醒方式），
存进 `state.plans[]`，`state.activePlanId` 指向「当前方案」。方案**只存配置，不存统计**。

- **指纹判改动**：`planKey(settings) = JSON.stringify(planConfigOf(settings))`（`planConfigOf` = 深拷贝
  `normalizeSettings` 的结果）。当前方案与当前设置的指纹不一致 → 「当前方案」卡片标「有改动」。
- **快照的两种方向**：`savePlan(name, id)`（界面「保存到方案」）把**当前设置**写进这份方案；
  `applyPlanById(id)`（「应用」）把**方案**写回设置：`normalizeSettings({ ...plan.settings })`
  + `runtime = freshRuntime(Date.now())` + 立刻重排下一次提醒。切换方案会换掉设置与计时，但**不动 `records`**。
  注意**不带 `enabled: true`**：方案里记的是「关着提醒」，应用它之后提醒仍然是关着的（原样套用快照）。
- **别的操作**：`renamePlan` / `duplicatePlan`（名字加「 副本」，不抢「当前」）/ `removePlan`
  （删的正好是当前那份时只把 `activePlanId` 置 `null`，设置保持原样）。
- **升级兜底**：读盘时只有 `parsed.plans === undefined`（0.4.x 及更早的老状态）才 `seedPlan()` 兜一份
  「默认方案」；显式空数组**不再**兜——用户把方案删光后重启不会又冒出来。
- **编辑弹窗**（`//#region 方案编辑弹窗`）：`planEditState` 持一份 `draft`（`planConfigOf(plan.settings)` 的拷贝），
  `patchPlanEditor` / `patchPlanEditorKind` 只改草稿；`savePlanEditor()` 才写回方案，
  **若改的正好是当前方案，再 `applyPlan({settings})` 让新配置立刻生效**。取消（或 `closePlanEditor()`）直接丢弃草稿。
  弹窗复用确认弹窗那一层（`S.confirmLayer` + `S.dialogCard`），订阅 / 强制刷新与 `useConfirmState` 同范式。
  **席位兜底**：两个弹窗正常挂在 `shell.overlay` 席位；万一外壳不给这个席位（`overlaySeatLive === false`），
  面板里会改挂一份 `PlanEditorDialog`，点「编辑」不会没反应（确认框则退回 `window.confirm`）。

## 宿主半区（可选的只读探针）
`index.js` 只做一件事：注册 `GET /health-reminder/status` → `{ok:true,name,version,client:"web"}`，
其他方法 405（`allow: GET, HEAD`）。**不加载模型、不读数据、不依赖 `connection`**；`webServer` 缺失时
`apply()` 只打一条警告、不抛错。它的唯一用途是排查「插件到底装上没有」——提醒功能全在浏览器半区，探针挂了也照常工作。
版本号在 `package.json`、`client.js` 的诊断记录与 `index.js` 各存一份，自测会比对后两者与清单一致。

## 离线自测
`test/run-tests.mjs` 伪造 `window.__ModuleLoader__`（拿着 `client.js` 源码 `new Function` 跑）与 localStorage，
再给 `index.js` 一个假的 `ctx`，因此不需要 DSH、不需要浏览器就能跑（70 项）。

## 刻意不做
- **不注册键盘快捷键**：DSH 的快捷键服务里不会出现这个插件，入口只有底部状态行的按钮、面板与设置页。
- **不联网、不调用模型**：插件不发任何请求，也不加载模型（0.5.0 起删掉了早期的模型聊天链路）。
- **不驻留后台**：没有常驻进程 / 定时任务，提醒靠渲染进程里的时刻表判定。
- **不做云同步**：只有本机渲染进程的 localStorage，换设备用导出 / 导入自己搬。

## 提醒文案（中文，随机池避免疲劳）
- 水：「该喝水了 💧」「补水时间到，250ml 走起」「别等渴了才喝 💧」
- 站：「起来活动 3 分钟 🧍」「久坐了，肩颈绕环 + 靠墙站」「站起来走两圈，腰会谢谢你」
- 可配置 3 分钟微运动：肩颈绕环 8 次 / 靠墙站 60s / 髋屈肌拉伸 30s×2 / 深蹲 10 次。
