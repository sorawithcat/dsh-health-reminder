/**
 * 健康提醒插件 · 离线自测
 *
 * 运行：node test/run-tests.mjs
 *
 * 这个脚本不需要 DSH、不需要浏览器：它伪造宿主模块加载器、React 和 localStorage，
 * 然后把 client.js 当普通脚本加载，直接测纯逻辑（解析 / 排期 / 统计 / 方案对话），
 * 并对界面组件做一次「渲染不抛错」的冒烟测试。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

//#region 伪造宿主环境
const storage = new Map();
globalThis.localStorage = {
	getItem: (key) => (storage.has(key) ? storage.get(key) : null),
	setItem: (key, value) => storage.set(key, String(value)),
	removeItem: (key) => storage.delete(key)
};

/** 极简 React 替身：只支持插件用到的几个 hook，足以做一次性渲染冒烟。 */
const hookState = new Map();
const refState = new Map();
const cleanups = [];
const hooks = { cursor: 0 };
let componentKey = "root";

const reactStub = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}) };
		if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
		return { $$element: true, type, props: merged };
	},
	useState(initial) {
		const key = `${componentKey}#${hooks.cursor++}`;
		if (!hookState.has(key)) hookState.set(key, typeof initial === "function" ? initial() : initial);
		return [hookState.get(key), (value) => hookState.set(key, typeof value === "function" ? value(hookState.get(key)) : value)];
	},
	useEffect(fn) {
		hooks.cursor += 1;
		const cleanup = fn();
		if (typeof cleanup === "function") cleanups.push(cleanup);
	},
	useMemo(fn) {
		hooks.cursor += 1;
		return fn();
	},
	useCallback(fn) {
		hooks.cursor += 1;
		return fn;
	},
	useRef(initial) {
		const key = `${componentKey}#ref${hooks.cursor++}`;
		if (!refState.has(key)) refState.set(key, { current: initial ?? null });
		return refState.get(key);
	}
};
//#endregion

//#region 加载被测量的 client.js
const clientPath = path.join(import.meta.dirname, "..", "client.js");
const code = fs.readFileSync(clientPath, "utf8");

let factory = null;
let loadedId = null;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loadedId = definition.id;
			factory = definition.factory;
		}
	}
};

// 这行等价于宿主在浏览器里加载插件脚本。
new Function(code)();
assert.equal(loadedId, "dsh-health-reminder", "模块 id 必须是插件名");

const mod = factory((specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`插件不该 require：${specifier}`);
});
const t = mod.__test;

assert.equal(mod.name, "dsh-health-reminder");
assert.deepEqual(mod.inject, ["slots", "locale", "layout"]);
assert.equal(typeof mod.apply, "function");
assert.ok(t, "插件必须导出 __test 供自测使用");
//#endregion

//#region 结果收集
const results = [];
/** 所有用例排队执行：有 await 的用例（确认弹窗）也能按注册顺序跑。 */
const runners = [];
function check(name, fn) {
	runners.push(async () => {
		try {
			await fn();
			results.push({ name, ok: true });
		} catch (error) {
			results.push({ name, ok: false, error: error?.stack ?? String(error) });
		}
	});
}
/** 等一轮微任务 + 一次宏任务，让弹窗的 Promise 回调跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 取「某个 ISO 星期」的本周日期（基准 2026-10-05，不关心那天是星期几）。 */
function onWeekday(iso, hour, minute) {
	const d = new Date(2026, 9, 5, hour, minute ?? 0, 0, 0);
	const current = ((d.getDay() + 6) % 7) + 1;
	d.setDate(d.getDate() + (iso - current));
	return d;
}
const ms = (iso, hour, minute) => onWeekday(iso, hour, minute).getTime();

const DEFAULT = () => t.clone(t.DEFAULT_SETTINGS);
function freshState(overrides) {
	return {
		version: 1,
		settings: DEFAULT(),
		records: {},
		runtime: t.freshRuntime(Date.now()),
		plans: [],
		activePlanId: null,
		...(overrides ?? {})
	};
}
function resetStore(state) {
	storage.clear();
	t.store.state = state ?? freshState();
}
//#endregion

//#region 1. 时间与中文解析
check("parseHM / inWindow / humanDuration", () => {
	assert.equal(t.parseHM("09:05"), 545);
	assert.equal(t.parseHM("23:59"), 1439);
	assert.equal(t.parseHM("24:00"), null);
	assert.equal(t.parseHM("9:5"), null);
	assert.equal(t.inWindow(30, 1320, 480), true, "跨零点窗口应包含凌晨 0:30");
	assert.equal(t.inWindow(600, 1320, 480), false);
	assert.equal(t.inWindow(545, 600, 1140), false);
	assert.equal(t.humanDuration(3600000), "1 小时");
	assert.equal(t.humanDuration(65000), "1 分钟");
	assert.equal(t.dayKey(onWeekday(1, 0, 0)).length, 10);
});
//#endregion

//#region 2. 设置归一化与允许时段
check("normalizeSettings 补默认值并裁剪", () => {
	const settings = t.normalizeSettings({ water: { intervalMin: 9999 }, workdays: [], quiet: { enabled: "yes" } });
	assert.equal(settings.kinds.water.intervalMin, 240);
	assert.deepEqual(settings.workdays, t.DEFAULT_SETTINGS.workdays);
	assert.equal(settings.quiet.enabled, false);
	assert.equal(settings.kinds.water.target, 8);
	assert.equal(t.normalizeSettings(null).dayStart, "10:00");
	assert.equal(t.normalizeSettings({ dayEnd: "25:00" }).dayEnd, "19:00");
});

check("isAllowed 只在上工时段的上班日放行", () => {
	const settings = DEFAULT();
	assert.equal(t.isAllowed(settings, ms(1, 11, 0)), true, "周一 11:00 应放行");
	assert.equal(t.isAllowed(settings, ms(6, 18, 59)), true, "周六 18:59 应放行");
	assert.equal(t.isAllowed(settings, ms(7, 11, 0)), false, "周日不上班");
	assert.equal(t.isAllowed(settings, ms(1, 12, 30)), false, "午休不放行");
	assert.equal(t.isAllowed(settings, ms(1, 9, 59)), false, "上班前不放行");
	assert.equal(t.isAllowed(settings, ms(1, 19, 0)), false, "下班点不放行");
	assert.equal(t.isAllowed({ ...settings, enabled: false }, ms(1, 11, 0)), false, "总开关关闭");
});

check("nextAllowedAt 跳过午休、夜间与休息日", () => {
	const settings = DEFAULT();
	assert.equal(t.nextAllowedAt(settings, ms(1, 12, 30)), ms(1, 13, 0), "午休后是 13:00");
	assert.equal(t.nextAllowedAt(settings, ms(7, 15, 0)), ms(8, 10, 0), "周日 15:00 → 周一 10:00");
	assert.equal(t.nextAllowedAt(settings, ms(6, 23, 0)), ms(8, 10, 0), "周六深夜 → 周一 10:00");
	assert.equal(t.nextAllowedAt(settings, ms(1, 9, 0)), ms(1, 10, 0));
	assert.equal(t.nextAllowedAt(settings, ms(1, 11, 20)), ms(1, 11, 20), "已在窗口内就原样返回");
});

check("windowMinutes / estimate 的容量计算", () => {
	const settings = DEFAULT();
	assert.equal(t.windowMinutes(settings), 480, "10:00-19:00 扣掉 1 小时午休 = 480 分钟");
	const est = t.estimate(settings);
	assert.equal(est.waterMax, 8);
	assert.equal(est.standMax, 10);
	assert.equal(est.days, 6);
	assert.equal(t.estimate({ ...settings, lunchEnabled: false }).waterMax, 9);
});
//#endregion

//#region 3. 到点判定与操作
check("固定时刻表：daySlots 从上班时间起按间隔排队，跳过午休", () => {
	const settings = DEFAULT();
	const slots = t.daySlots(settings, "water", 0, ms(1, 8, 0));
	assert.deepEqual(slots.map((x) => new Date(x).getHours()), [11, 13, 14, 15, 16, 17, 18], "10:00 + 每 60 分钟，12:00 在午休里被丢掉");
	assert.equal(t.inSchedule(settings, slots[0]), true, "inSchedule 不看总开关");
	assert.equal(t.isAllowed({ ...settings, enabled: false }, slots[0]), false, "isAllowed 仍受总开关约束");
	const stand = t.daySlots(settings, "stand", 0, ms(1, 8, 0));
	assert.deepEqual(
		stand.map((x) => new Date(x).getHours() * 60 + new Date(x).getMinutes()),
		[645, 690, 780, 825, 870, 915, 960, 1005, 1050, 1095],
		"10:00 + 每 45 分钟，12:15 在午休里被丢掉"
	);
	assert.equal(t.nextSlotAt(settings, "water", ms(1, 11, 30)), ms(1, 13, 0));
	assert.equal(t.lastSlotAt(settings, "water", ms(1, 11, 30)), ms(1, 11, 0));
	const tuesday = t.daySlots(settings, "water", 1, ms(1, 8, 0));
	assert.equal(tuesday.length, 7, "下一个上班日也要能排出来");
	assert.equal(new Date(tuesday[0]).getDate(), new Date(ms(2, 0, 0)).getDate());
});

check("computeDue 只认时刻表上的点，也不重复提醒", () => {
	const state = freshState();
	let r = t.computeDue(state, ms(1, 10, 30));
	assert.deepEqual(r.due, [], "第一个喝水点 11:00 还没到");
	assert.equal(r.runtime.pending.length, 0);

	r = t.computeDue(state, ms(1, 11, 0));
	assert.deepEqual(r.due, ["water"]);
	assert.equal(r.runtime.pending.length, 1);
	assert.equal(r.runtime.pending[0].kind, "water");
	assert.equal(r.runtime.fired.water, ms(1, 11, 0));
	const again = t.computeDue(state, ms(1, 11, 30));
	assert.ok(!again.due.includes("water"), "同一个喝水点不会重复提醒");
	assert.equal(again.runtime.fired.water, ms(1, 11, 0), "已处理的点保持不变");
	assert.deepEqual(again.due, ["stand"], "11:30 本身是起身点，照常提醒");
});

check("迟到的提醒点只记不补发；迟到窗口内照常提醒", () => {
	const late = freshState();
	const r = t.computeDue(late, ms(1, 15, 30));
	assert.deepEqual(r.due, [], "14:00 的点已经过去 1.5 小时，不补发");
	assert.equal(r.runtime.fired.water, ms(1, 15, 0), "当前上班日最后一个过去的点（15:00）记为已处理");
	assert.equal(r.runtime.pending.length, 0);

	const fresh = freshState();
	assert.deepEqual(t.computeDue(fresh, ms(1, 14, 1)).due, ["water"], "过去 1 分钟仍在迟到窗口内");
});

check("computeDue 不会重复堆积同一种待处理提醒", () => {
	const state = freshState();
	state.runtime.pending = [{ kind: "water", at: 1, id: "x" }];
	const { runtime, due } = t.computeDue(state, ms(1, 11, 0));
	assert.deepEqual(due, ["water"]);
	assert.equal(runtime.pending.length, 1, "已有同类待处理项时不再入队");
});

check("关闭「应用内提示卡」时不产生待处理项", () => {
	const settings = t.normalizeSettings({ notify: { inApp: false } });
	const state = freshState({ settings });
	const { runtime, due } = t.computeDue(state, ms(1, 11, 0));
	assert.deepEqual(due, ["water"]);
	assert.equal(runtime.pending.length, 0);
});

check("完成 / 跳过 / 手动记录都不改时刻表", () => {
	resetStore();
	const now = ms(1, 13, 0);
	t.tick(now);
	assert.equal(t.store.get().runtime.pending.length, 2, "13:00 同时是喝水点与起身点");
	const key = t.dayKey(new Date(now));
	t.completeKind("water", now);
	assert.equal(t.store.get().records[key].water, 1);
	assert.equal(t.store.get().records[key].log.at(-1).action, "done");
	t.skipKind("stand", now);
	assert.equal(t.store.get().records[key].skips, 1);
	assert.equal(t.store.get().records[key].log.at(-1).action, "skip");

	assert.equal(t.nextAtFor(t.store.get(), "water", now), ms(1, 14, 0), "完成后下一次仍是时刻表上的点，不是 now+60 分钟");
	assert.equal(t.nextAtFor(t.store.get(), "stand", now), ms(1, 13, 45));

	t.completeKind("water", now);
	assert.equal(t.store.get().records[key].water, 2, "手动「记一杯水」算真实记录");
	assert.equal(t.nextAtFor(t.store.get(), "water", now), ms(1, 14, 0), "手动记录也不改时刻表");
});

check("暂停不重置、恢复不补发", () => {
	resetStore(freshState({ settings: t.normalizeSettings({ enabled: false }) }));
	t.tick(ms(1, 11, 30));
	const paused = t.store.get().runtime;
	assert.equal(paused.fired.water, ms(1, 11, 0), "暂停期间过去的点记为已处理");
	assert.equal(paused.pending.length, 0);
	assert.equal(t.nextAtFor(t.store.get(), "water", ms(1, 11, 30)), ms(1, 13, 0), "时刻表原地不动（不是 12:30）");

	t.updateSettings({ enabled: true });
	t.tick(ms(1, 11, 31));
	assert.equal(t.store.get().runtime.pending.length, 0, "恢复后不补发暂停期间错过的点");
	assert.equal(t.nextAtFor(t.store.get(), "water", ms(1, 11, 31)), ms(1, 13, 0), "恢复后仍按原时刻表");
});

check("推迟只覆盖下一次，用完回到时刻表", () => {
	resetStore();
	const now = ms(1, 13, 0);
	t.tick(now);
	t.snoozeKind("water", now, 10);
	assert.equal(t.nextAtFor(t.store.get(), "water", now), now + 10 * 60000);
	t.tick(now + 10 * 60000);
	assert.ok(t.store.get().runtime.pending.some((item) => item.kind === "water"), "推迟到点会提醒");
	assert.equal(t.store.get().runtime.snooze.water, null, "推迟用完即清");
	assert.equal(t.nextAtFor(t.store.get(), "water", now + 10 * 60000), ms(1, 14, 0), "之后回到固定时刻表");
});

check("今天不再提醒 → 下一个上班日的第一个点", () => {
	resetStore();
	const now = ms(1, 13, 0);
	t.tick(now);
	t.muteKindToday("water", now);
	assert.equal(t.nextAtFor(t.store.get(), "water", now), ms(2, 11, 0), "周二第一个喝水点是 11:00");
	assert.equal(t.nextAtFor(t.store.get(), "water", ms(2, 11, 0)), ms(2, 13, 0));
});

check("总开关关闭时 tick 只记已处理，不提醒", () => {
	resetStore(freshState({ settings: t.normalizeSettings({ enabled: false }) }));
	t.tick(ms(1, 11, 30));
	const runtime = t.store.get().runtime;
	assert.equal(runtime.pending.length, 0);
	assert.equal(runtime.fired.water, ms(1, 11, 0));
	assert.equal(runtime.fired.stand, ms(1, 11, 30), "起身的 11:30 点同样被记为已处理");
});

check("fireNow 是演练：打 test 标记，不写记录、不动时刻表、不落盘", () => {
	resetStore();
	const now = ms(1, 14, 1);
	t.tick(now);
	const key = t.dayKey(new Date(now));
	t.completeKind("water", now);
	assert.equal(t.store.get().records[key].water, 1);

	t.fireNow("water", now);
	const item = t.store.get().runtime.pending.find((x) => x.kind === "water");
	assert.equal(item.test, true, "演练项必须带 test 标记");

	const saved = JSON.parse(storage.get("dsh-health-reminder/state.v1"));
	assert.equal(saved.runtime.pending.filter((x) => x.test === true).length, 0, "演练项不写进本地状态");

	t.completeKind("water", now, { test: true });
	assert.equal(t.store.get().records[key].water, 1, "演练点「知道了」不能计数");
	assert.equal(t.store.get().runtime.pending.length, 0);
	assert.equal(t.nextAtFor(t.store.get(), "water", now), ms(1, 15, 0), "时刻表不受演练影响");
});

check("旧状态迁移：waterNextAt / standNextAt 变成 fired，不补发", () => {
	const now = ms(1, 14, 30);
	const legacy = t.migrateRuntime({ waterNextAt: ms(1, 14, 0), standNextAt: ms(1, 14, 45), pending: [] });
	assert.equal(legacy.fired.water, ms(1, 14, 0));
	assert.equal(legacy.fired.stand, ms(1, 14, 45));
	assert.equal(legacy.waterNextAt, undefined);
	assert.equal(t.computeDue(freshState({ runtime: legacy }), now).due.length, 0, "迁移后不会立刻补发");
});

check("类型表：默认 4 类，新类型默认关闭且不进时刻表", () => {
	const settings = DEFAULT();
	assert.deepEqual(t.KIND_IDS, ["water", "stand", "eyes", "stretch"]);
	assert.deepEqual(t.activeKinds(settings), ["water", "stand"], "默认只开喝水和起身");
	assert.equal(t.kindEnabled(settings, "eyes"), false);
	assert.equal(t.daySlots(settings, "eyes", 0, ms(1, 8, 0)).length, 0, "关掉的类型没有时刻点");
	assert.equal(t.nextAtFor(freshState({ settings }), "eyes", ms(1, 11, 0)), null, "关掉的类型没有下一次");
	assert.equal(t.recordCount({ water: 3 }, "eyes"), 0, "没有记录时算 0");
});

check("去除番茄：类型表里没有 focus，旧状态带来的 focus 配置会被丢掉", () => {
	assert.equal(t.KIND_IDS.includes("focus"), false);
	assert.equal(t.kindDef("focus").id, "water", "认不出的类型回退到第一个");
	assert.equal(t.TIPS.focus, undefined);
	const settings = t.normalizeSettings({ kinds: { focus: { on: true, intervalMin: 25, target: 8 } } });
	assert.equal(settings.kinds.focus, undefined, "旧设置里的 focus 不再保留");
	assert.deepEqual(t.activeKinds(settings), ["water", "stand"]);
});

check("类型表：开启护眼后有时刻点、能提醒、能记录，并进达标判定", () => {
	const settings = t.normalizeSettings({ kinds: { eyes: { on: true, intervalMin: 30, target: 4 } } });
	assert.deepEqual(t.activeKinds(settings), ["water", "stand", "eyes"]);
	const slots = t.daySlots(settings, "eyes", 0, ms(1, 8, 0));
	assert.ok(slots.length > 8, "开启后应有足够多的时刻点");
	assert.equal(new Date(slots[0]).getHours(), 10);
	assert.equal(new Date(slots[0]).getMinutes(), 30);
	assert.ok(
		slots.every((at) => {
			const mins = new Date(at).getHours() * 60 + new Date(at).getMinutes();
			return mins < 12 * 60 || mins >= 13 * 60;
		}),
		"午休里不该有护眼点"
	);

	resetStore(freshState({ settings }));
	const now = ms(1, 10, 30);
	t.tick(now);
	assert.ok(t.store.get().runtime.pending.some((item) => item.kind === "eyes"), "到点会提醒护眼");
	t.completeKind("eyes", now);
	assert.equal(t.recordOn(t.store.get(), t.dayKey(new Date(now))).eyes, 1, "护眼计入当天统计");
	assert.equal(t.isDayMet(t.store.get(), t.dayKey(new Date(now))), false, "只完成护眼不算达标");
	assert.equal(t.kindTarget(settings, "eyes"), 4);
	assert.equal(t.reminderCopy("eyes", now).title, "该看看远处了 👀", "提醒文案用类型自己的标题与图标");
});

check("类型表：旧的顶层 water/stand 设置仍能读进来（v2 → v3）", () => {
	const migrated = t.normalizeSettings({ water: { intervalMin: 90, target: 10, enabled: false }, stand: { minutes: 5 } });
	assert.equal(migrated.kinds.water.intervalMin, 90);
	assert.equal(migrated.kinds.water.target, 10);
	assert.equal(migrated.kinds.water.on, false, "老的 enabled 映射到 on");
	assert.equal(migrated.kinds.stand.minutes, 5);
	assert.equal(migrated.kinds.eyes.on, false, "没见过的类型仍是默认值");
	const runtime = t.migrateRuntime({ fired: { water: 1 }, snooze: { water: null }, pending: [] });
	assert.equal(runtime.fired.eyes, 0, "旧运行期状态给新类型补 0");
	assert.equal(runtime.snooze.stretch, null);
});
//#endregion

//#region 4. 统计
check("isDayMet / streakOf / lastDays", () => {
	const settings = DEFAULT();
	const met = { water: settings.kinds.water.target, stand: settings.kinds.stand.target, skips: 0, log: [] };
	const records = {};
	for (const iso of [1, 2, 3]) records[t.dayKey(onWeekday(iso, 12, 0))] = { ...met };
	records[t.dayKey(onWeekday(4, 12, 0))] = { water: 1, stand: 0, skips: 2, log: [] };
	const state = freshState({ records });
	assert.equal(t.isDayMet(state, t.dayKey(onWeekday(1, 12, 0))), true);
	assert.equal(t.isDayMet(state, t.dayKey(onWeekday(4, 12, 0))), false);
	assert.equal(t.streakOf(state, ms(3, 15, 0)), 3, "周三当天达标 + 周二 + 周一 = 3 天");
	assert.equal(t.streakOf(state, ms(4, 15, 0)), 3, "周四还没达标不算断，连续天数仍是 3");
	const days = t.lastDays(state, ms(4, 15, 0), 7);
	assert.equal(days.length, 7);
	assert.equal(days.at(-1).today, true);
	assert.equal(days.at(-1).water, 1);
	assert.equal(days.at(-1).skips, 2);
	assert.equal(days.at(-2).met, true);
});
//#endregion

//#region 4b. 报告与导出 / 导入
/** 一份跨 3 天的记录：周一/周二达标，周三（今天）还没达标，周二跳过 1 次。 */
function reportRecords() {
	const base = () => ({ skips: 0, skipBy: {}, log: [] });
	return {
		[t.dayKey(onWeekday(1, 12, 0))]: { ...base(), water: 8, stand: 8 },
		[t.dayKey(onWeekday(2, 12, 0))]: { ...base(), water: 8, stand: 8, skips: 1 },
		[t.dayKey(onWeekday(3, 12, 0))]: { ...base(), water: 3, stand: 2 }
	};
}

check("报告：7 天与 30 天的合计、达标天数与最长连续", () => {
	resetStore(freshState({ records: reportRecords() }));
	const now = ms(3, 15, 0);
	const week = t.reportOf(t.store.get(), 7, now);
	assert.equal(week.span, 7);
	assert.equal(week.days.length, 7);
	assert.equal(week.totals.water, 19, "8 + 8 + 3");
	assert.equal(week.totals.stand, 18);
	assert.equal(week.metDays, 2, "周一、周二达标");
	assert.equal(week.workdays, 6, "近 7 天里有 6 个上班日");
	assert.equal(week.best, 2, "最长连续 2 天");
	assert.equal(week.streak, 2, "当前连续 2 天（今天没达标不打断）");
	assert.equal(week.skips, 1);
	assert.equal(week.waterMl, 19 * 250);
	assert.equal(week.standMinutes, 18 * 3);
	const month = t.reportOf(t.store.get(), 30, now);
	assert.equal(month.span, 30);
	assert.equal(month.days.length, 30);
	assert.equal(month.totals.water, 19, "30 天报告也包含这几天");
	assert.equal(month.metDays, 2);
});

check("导出 / 导入：格式校验、按天取较大值、日志去重、设置可选覆盖", () => {
	resetStore(freshState({ records: reportRecords() }));
	const state = t.store.get();
	const payload = t.buildExport(state, { now: Date.UTC(2026, 9, 7) });
	assert.equal(payload.schema, t.EXPORT_SCHEMA);
	assert.equal(payload.version, t.EXPORT_VERSION);
	assert.equal(Object.keys(payload.records).length, 3);
	assert.ok(payload.settings, "默认导出设置");
	assert.equal(payload.runtime, undefined, "默认不导出运行期状态");

	const parsed = t.parseImport(JSON.stringify(payload));
	assert.equal(parsed.ok, true);
	assert.equal(parsed.summary.days, 3);
	assert.equal(parsed.summary.hasSettings, true);
	assert.equal(parsed.summary.done, 37, "8+8+8+8+3+2");

	assert.equal(t.parseImport("{ 坏 json").ok, false);
	assert.match(t.parseImport("{}").error, /schema/);
	assert.match(t.parseImport(JSON.stringify({ schema: t.EXPORT_SCHEMA, version: 99, records: { [t.dayKey(onWeekday(1, 12, 0))]: { water: 1 } } })).error, /更新/);
	assert.equal(t.parseImport(JSON.stringify({ schema: t.EXPORT_SCHEMA, version: 1, records: {} })).ok, false, "空的导出文件应被拒绝");

	const messy = t.parseImport(
		JSON.stringify({ schema: t.EXPORT_SCHEMA, version: 1, records: { "not-a-day": { water: 5 }, [t.dayKey(onWeekday(1, 12, 0))]: { water: 4 } } })
	);
	assert.equal(messy.ok, true);
	assert.deepEqual(Object.keys(messy.payload.records), [t.dayKey(onWeekday(1, 12, 0))], "坏日期键被丢掉");

	const key = t.dayKey(onWeekday(1, 12, 0));
	const local = freshState({ records: { [key]: { water: 8, stand: 8, skips: 1, log: [{ t: 1, kind: "water", action: "done" }] } } });
	const incoming = t.parseImport(
		JSON.stringify({
			schema: t.EXPORT_SCHEMA,
			version: 1,
			records: { [key]: { water: 3, stand: 10, skips: 0, log: [{ t: 1, kind: "water", action: "done" }, { t: 2, kind: "stand", action: "done" }] } }
		})
	);
	const merged = t.mergeImport(local, incoming.payload, { now: 12345 });
	const day = merged.state.records[key];
	assert.equal(day.water, 8, "同一天取较大值");
	assert.equal(day.stand, 10);
	assert.equal(day.skips, 1);
	assert.equal(day.log.length, 2, "重复日志去重");
	assert.equal(merged.summary.merged, 1);
	assert.equal(merged.summary.settingsChanged, false, "默认不动本机设置");
	assert.equal(merged.state.lastImportAt, 12345);
	assert.equal(merged.state.settings.kinds.water.intervalMin, t.DEFAULT_SETTINGS.kinds.water.intervalMin);

	const withSettings = t.mergeImport(
		freshState(),
		t.parseImport(JSON.stringify({ schema: t.EXPORT_SCHEMA, version: 1, settings: { kinds: { water: { intervalMin: 90 } } }, records: { [t.dayKey(onWeekday(2, 12, 0))]: { water: 2 } } })).payload,
		{ applySettings: true }
	);
	assert.equal(withSettings.summary.added, 1, "新的一天直接加入");
	assert.equal(withSettings.summary.settingsChanged, true);
	assert.equal(withSettings.state.settings.kinds.water.intervalMin, 90);
});

check("导出 CSV：带 BOM、表头 + 每天一行、含达标列", () => {
	resetStore(freshState({ records: reportRecords() }));
	const csv = t.csvOf(t.store.get(), 7, ms(3, 15, 0));
	assert.ok(csv.startsWith("\uFEFF"), "Excel 需要 BOM 才能正确识别中文");
	const lines = csv.replace("\uFEFF", "").trim().split("\r\n");
	assert.match(lines[0], /^日期,星期,喝水\(杯\),起身\(次\),跳过,达标$/);
	assert.equal(lines.length, 8, "表头 + 7 天");
	assert.match(lines.at(-1), new RegExp(`^${t.dayKey(onWeekday(3, 12, 0))},周三,3,2,0,否$`));
	assert.match(lines.at(-2), /,是$/, "周二是达标日");
	assert.match(lines.at(-4), /非上班日$/, "周日不是上班日");
});

check("报告与 CSV：护眼 / 拉伸的完成数也要进表（日汇总不能当原始记录读）", () => {
	const key = t.dayKey(onWeekday(2, 12, 0));
	const state = freshState({
		records: { [key]: { water: 4, stand: 5, eyes: 9, stretch: 1, skips: 4, log: [] } }
	});
	state.settings.kinds.eyes.on = true;
	state.settings.kinds.stretch.on = true;
	resetStore(state);
	const now = ms(2, 18, 0);
	const week = t.reportOf(t.store.get(), 7, now);
	const row = (kind) => week.rows.find((item) => item.kind === kind);
	assert.deepEqual(week.kinds, ["water", "stand", "eyes", "stretch"], "在册的四种都进表");
	assert.equal(row("water").total, 4);
	assert.equal(row("stand").total, 5);
	assert.equal(row("eyes").total, 9, "护眼当天 9 次要计入累计（曾错读日汇总为 0）");
	assert.equal(row("stretch").total, 1);
	assert.equal(week.totals.eyes, 9);
	assert.equal(week.totals.stretch, 1);
	const lines = t.csvOf(t.store.get(), 7, now).replace("\uFEFF", "").trim().split("\r\n");
	assert.match(lines[0], /^日期,星期,喝水\(杯\),起身\(次\),护眼\(次\),拉伸\(次\),跳过,达标$/);
	assert.ok(lines.some((line) => line.startsWith(`${key},周二,4,5,9,1,4,`)), `CSV 也要带护眼 / 拉伸：${lines.join(" | ")}`);
});
//#endregion

//#region 5. 方案管理（多套配置，随时切换）
/** 改设置：测试里最常用的一步（和界面走同一条 normalizeSettings）。 */
function setSettings(patch) {
	const state = t.store.get();
	t.store.set({ ...state, settings: t.normalizeSettings({ ...state.settings, ...patch }) });
}

check("新建方案照当前设置快照，并自动切到这一份", () => {
	resetStore();
	const kinds = t.store.get().settings.kinds;
	setSettings({ dayStart: "09:00", kinds: { ...kinds, stand: { ...kinds.stand, intervalMin: 35 } } });
	const id = t.savePlan("早班", null);
	const state = t.store.get();
	assert.equal(state.plans.length, 1);
	assert.equal(state.activePlanId, id, "新建之后当前用的就是它");
	const plan = t.planById(state, id);
	assert.equal(plan.name, "早班");
	assert.equal(plan.settings.dayStart, "09:00");
	assert.equal(plan.settings.kinds.stand.intervalMin, 35);
	assert.equal(typeof plan.createdAt, "number");
	assert.equal(plan.createdAt, plan.updatedAt);
	assert.equal(t.planDrifted(state), false, "刚存下来的方案必须和当前设置一致");
});

check("方案名留空就按作息自动起一个，脏字符会被压掉", () => {
	resetStore();
	const auto = t.savePlan("   ", null);
	assert.match(t.planById(t.store.get(), auto).name, /类$/, "自动名字要能看出作息与类型数");
	assert.equal(t.planNameOf("  早\n班  ", "兜底"), "早 班", "换行与首尾空白都要压掉");
	assert.equal(t.planNameOf("", "兜底"), "兜底");
	assert.equal(t.planNameOf("x".repeat(40), "兜底").length, t.PLAN_NAME_MAX);
});

check("切换方案：设置与计时一起换过去，统计不动", () => {
	resetStore();
	const a = t.savePlan("基准", null);
	const kinds = t.store.get().settings.kinds;
	setSettings({ dayEnd: "20:00", kinds: { ...kinds, water: { ...kinds.water, target: 12 } } });
	const b = t.savePlan("加班日", null);
	assert.notEqual(a, b);
	t.store.set({ ...t.store.get(), records: { "2026-10-05": { water: 3 } } });
	setSettings({ dayStart: "07:00" });
	assert.equal(t.planDrifted(t.store.get()), true, "改过设置之后应当算「有改动」");
	assert.equal(t.applyPlanById(a), true);
	const state = t.store.get();
	assert.equal(state.activePlanId, a);
	assert.equal(state.settings.dayStart, "10:00", "切回基准方案就该拿到它的作息");
	assert.equal(state.settings.dayEnd, "19:00");
	assert.equal(state.settings.kinds.water.target, 8);
	assert.equal(t.planDrifted(state), false, "刚切换过来的设置必须和方案一致");
	assert.deepEqual(state.records, { "2026-10-05": { water: 3 } }, "切换方案不能动统计");
	assert.equal(state.runtime.lastDay, t.dayKey(new Date()), "切换后要按新时刻表重新计时");
	assert.equal(t.applyPlanById("plan-根本没这回事"), false);
});

check("改了设置可以用「恢复方案」退回快照，也能「保存到方案」覆盖快照", () => {
	resetStore();
	const id = t.savePlan("基准", null);
	setSettings({ dayEnd: "20:00" });
	assert.equal(t.planDrifted(t.store.get()), true);
	assert.equal(t.revertToActivePlan(), true);
	assert.equal(t.store.get().settings.dayEnd, "19:00");
	assert.equal(t.planDrifted(t.store.get()), false);

	setSettings({ dayEnd: "20:00" });
	assert.equal(t.savePlan("基准", id), id, "保存到已有方案是把当前设置覆盖进去");
	assert.equal(t.planById(t.store.get(), id).settings.dayEnd, "20:00");
	assert.equal(t.planDrifted(t.store.get()), false, "覆盖之后就不该再显示「有改动」");
	assert.equal(t.store.get().plans.length, 1, "覆盖不会多出一份");
	assert.equal(t.savePlan("随便", "plan-没这回事"), null, "覆盖一份不存在的方案应当失败");
});

check("重命名 / 复制 / 删除：删掉当前方案只清「当前」，设置保持原样", () => {
	resetStore();
	const id = t.savePlan("工作", null);
	assert.equal(t.renamePlan(id, "  工作日  "), true);
	assert.equal(t.planById(t.store.get(), id).name, "工作日");
	assert.equal(t.renamePlan("plan-没这回事", "x"), false);
	t.renamePlan(id, "x".repeat(40));
	assert.equal(t.planById(t.store.get(), id).name.length, t.PLAN_NAME_MAX);
	t.renamePlan(id, "工作日");

	const copyId = t.duplicatePlan(id);
	assert.notEqual(copyId, id);
	assert.equal(t.planById(t.store.get(), copyId).name, "工作日 副本");
	assert.equal(t.planById(t.store.get(), copyId).settings.dayStart, t.store.get().settings.dayStart, "副本要连配置一起复制");
	assert.equal(t.store.get().activePlanId, id, "复制不该把前台切走");
	assert.equal(t.duplicatePlan("plan-没这回事"), null);

	assert.equal(t.removePlan(copyId), true);
	assert.equal(t.store.get().plans.length, 1);
	assert.equal(t.removePlan(id), true);
	assert.equal(t.store.get().plans.length, 0);
	assert.equal(t.store.get().activePlanId, null, "删掉当前方案只把「当前」清掉");
	assert.equal(t.store.get().settings.dayStart, "10:00", "删方案不能顺手改设置");
	assert.equal(t.removePlan(id), false);
});

check("读盘：坏方案丢掉、重复 id 只留第一份、开着的那份记回来", () => {
	storage.clear();
	storage.set(
		"dsh-health-reminder/state.v1",
		JSON.stringify({
			settings: { dayStart: "09:00" },
			activePlanId: "keep",
			plans: [
				{ id: "keep", name: "第一", settings: { dayStart: "09:00" } },
				{ id: "keep", name: "重复的", settings: {} },
				null,
				{ name: "没有配置" },
				{ settings: {} },
				{ id: "last", name: "最后一次", settings: { dayEnd: "20:00" }, createdAt: 111, updatedAt: 222 }
			]
		})
	);
	t.store.state = null;
	const state = t.store.get();
	assert.equal(state.plans.length, 3, "坏项丢掉、重复 id 只留第一份");
	assert.deepEqual(
		state.plans.map((plan) => plan.name),
		["第一", "方案 3", "最后一次"],
		"没名字的方案要按序号兜底"
	);
	assert.equal(state.activePlanId, "keep");
	assert.equal(state.plans[2].createdAt, 111);
	assert.equal(state.plans[2].updatedAt, 222);
	assert.equal(state.plans[0].settings.dayStart, "09:00", "方案里的设置也要归一化");
	assert.equal(t.planById(state, "last").settings.dayEnd, "20:00");
});

check("老状态（没有 plans 字段）升级时兜一份「默认方案」，显式空数组不再兜", () => {
	storage.clear();
	storage.set("dsh-health-reminder/state.v1", JSON.stringify({ settings: { dayStart: "09:00" } }));
	t.store.state = null;
	const seeded = t.store.get();
	assert.equal(seeded.plans.length, 1, "升级上来的老状态不该让方案页空着");
	assert.equal(seeded.plans[0].name, "默认方案");
	assert.equal(seeded.activePlanId, seeded.plans[0].id);
	assert.equal(seeded.plans[0].settings.dayStart, "09:00");
	assert.equal(t.planDrifted(seeded), false);

	storage.set("dsh-health-reminder/state.v1", JSON.stringify({ settings: {}, plans: [], activePlanId: null }));
	t.store.state = null;
	const empty = t.store.get();
	assert.deepEqual(empty.plans, [], "用户把方案删光了，重启不该又冒出来一份");
	assert.equal(empty.activePlanId, null);
});

check("planLines 讲清作息、每类要点、提醒方式与容量", () => {
	const settings = t.normalizeSettings({
		...t.DEFAULT_SETTINGS,
		workdays: [1, 2, 3, 4, 5],
		dayStart: "09:00",
		dayEnd: "18:00",
		kinds: { ...t.DEFAULT_SETTINGS.kinds, eyes: { on: true, intervalMin: 30, target: 10 } }
	});
	const lines = t.planLines({ settings });
	assert.match(lines[0], /周一~周五 09:00-18:00/);
	assert.match(lines[0], /午休 12:00-13:00 不提醒/);
	assert.ok(
		lines.some((line) => /护眼：每 30 分钟提醒一次，目标 10 次/.test(line)),
		`护眼那一行要按类型表生成：${lines.join(" | ")}`
	);
	assert.ok(lines.some((line) => /提醒方式：系统通知 \+ 应用内提示 \+ 提示音/.test(line)));
	assert.match(lines.at(-1), /^容量：/, "容量永远压最后一行");
});

check("applyPlan 把方案写进设置并重排下一次", () => {
	resetStore();
	const settings = t.normalizeSettings({
		...t.DEFAULT_SETTINGS,
		workdays: [1, 2, 3, 4, 5],
		dayStart: "09:00",
		dayEnd: "18:00",
		notify: { ...t.DEFAULT_SETTINGS.notify, sound: false }
	});
	t.applyPlan({ settings });
	const state = t.store.get();
	assert.deepEqual(state.settings.workdays, [1, 2, 3, 4, 5]);
	assert.equal(state.settings.dayStart, "09:00");
	assert.equal(state.settings.notify.sound, false);
	assert.equal(state.settings.enabled, true);
	const at = t.nextAtFor(state, "water", Date.now());
	assert.equal(typeof at, "number", "改完设置后应能派生出下一次提醒");
	assert.equal(t.isAllowed(state.settings, at), true, "派生出来的时间必须落在允许时段内");
});

check("applyPlan 原样套用方案：方案记的是「关着提醒」，应用它不该把总开关打开", () => {
	resetStore();
	t.applyPlan({ settings: t.normalizeSettings({ ...t.DEFAULT_SETTINGS, enabled: false, workdays: [1, 2, 3, 4, 5] }) });
	assert.equal(t.store.get().settings.enabled, false, "应用方案不能偷偷打开总开关");

	// 编辑当前方案保存走的是同一条 applyPlan 路径，也不能把开关打开。
	const id = t.savePlan("关着提醒的方案", null);
	assert.equal(t.planById(t.store.get(), id).settings.enabled, false, "快照记下的就是关着的状态");
	t.applyPlanById(id);
	assert.equal(t.store.get().settings.enabled, false);

	// 反向也要成立：方案存的是开着，应用后就开着。
	t.updateSettings({ enabled: true });
	t.savePlan("开着提醒的方案", null);
	t.applyPlanById(id);
	assert.equal(t.store.get().settings.enabled, false, "切回关着的那份，开关跟着回去");
});

check("方案名上限和落库一致（PLAN_NAME_MAX）：不先让用户打到 40 再无声截到 24", () => {
	resetStore();
	const id = t.savePlan("工作日上午", null);
	assert.equal(t.openPlanEditor(id), true);
	t.patchPlanEditor({ name: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十" });
	assert.equal(t.planEditorOf().name.length, t.PLAN_NAME_MAX);
	assert.equal(t.savePlanEditor(), true);
	assert.equal(t.planById(t.store.get(), id).name.length, t.PLAN_NAME_MAX, "落库时的名字也不该比输入更长");
});

check("reminderCopy 带统计信息", () => {
	resetStore();
	const copy = t.reminderCopy("water", ms(1, 10, 30));
	assert.equal(copy.kind, "water");
	assert.match(copy.title, /该喝水了/);
	assert.match(copy.detail, /0\/8 杯/);
	const stand = t.reminderCopy("stand", ms(1, 10, 30));
	assert.match(stand.title, /该起身活动了/);
	assert.match(stand.detail, /3 分钟/);
});

check("方案编辑：草稿只写回这一份，编辑当前方案保存后立刻生效", () => {
	resetStore();
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, dayStart: "09:00" }) });
	const first = t.savePlan("工作日上午", null);
	const second = t.savePlan("周末", null);
	assert.equal(t.store.get().activePlanId, second, "后存的这份是当前方案");

	assert.equal(t.planEditorOf(), null, "没打开时没有草稿");
	assert.equal(t.openPlanEditor("不存在"), false, "方案不存在就开不了");
	assert.equal(t.openPlanEditor(first), true);

	let draft = t.planEditorOf();
	assert.equal(draft.id, first);
	assert.equal(draft.name, "工作日上午");
	assert.equal(draft.active, false, "当前方案是第二份");
	assert.equal(draft.draft.dayStart, "09:00");
	assert.equal(draft.draft.lunchEnabled, true);

	// 草稿是拷贝：外面怎么改都不该串进弹窗。
	draft.draft.dayStart = "07:00";
	assert.equal(t.planEditorOf().draft.dayStart, "09:00", "读回来的草稿必须是拷贝");

	t.patchPlanEditor({ name: "早班", dayStart: "06:30", lunchEnabled: false, notify: { ...t.DEFAULT_SETTINGS.notify, sound: false } });
	t.patchPlanEditorKind("water", { intervalMin: 30, target: 10 });
	t.patchPlanEditorKind("eyes", { on: true });
	draft = t.planEditorOf();
	assert.equal(draft.name, "早班");
	assert.equal(draft.draft.dayStart, "06:30");
	assert.equal(draft.draft.lunchEnabled, false);
	assert.equal(draft.draft.notify.sound, false);
	assert.equal(draft.draft.kinds.water.intervalMin, 30);
	assert.equal(draft.draft.kinds.water.target, 10);
	assert.equal(draft.draft.kinds.eyes.on, true);
	assert.equal(t.patchPlanEditorKind("nope", { on: true }), false, "不存在的类型改不动");

	// 没点保存之前，方案与当前设置都不动。
	assert.equal(t.planById(t.store.get(), first).name, "工作日上午");
	assert.equal(t.planById(t.store.get(), first).settings.dayStart, "09:00");
	assert.equal(t.store.get().settings.dayStart, "09:00");

	assert.equal(t.savePlanEditor(), true);
	assert.equal(t.planEditorOf(), null, "保存后弹窗关闭");
	assert.equal(t.planById(t.store.get(), first).name, "早班");
	assert.equal(t.planById(t.store.get(), first).settings.dayStart, "06:30");
	assert.equal(t.planById(t.store.get(), first).settings.kinds.eyes.on, true);
	assert.equal(t.planById(t.store.get(), first).settings.notify.sound, false);
	assert.equal(t.planById(t.store.get(), second).settings.dayStart, "09:00", "别的方案不能被顺手改掉");
	assert.equal(t.store.get().activePlanId, second, "编辑非当前方案不该抢「当前」");
	assert.equal(t.store.get().settings.dayStart, "09:00", "编辑非当前方案不该改当前设置");

	// 编辑的正好是当前方案：保存后新配置立刻作用到设置，统计不动。
	resetStore();
	const activeId = t.savePlan("当前", null);
	assert.equal(t.store.get().activePlanId, activeId);
	const records = t.store.get().records;
	assert.equal(t.openPlanEditor(activeId), true);
	assert.equal(t.planEditorOf().active, true);
	t.patchPlanEditor({ dayEnd: "21:00" });
	assert.equal(t.store.get().settings.dayEnd, "19:00", "没保存前设置不动");
	assert.equal(t.savePlanEditor(), true);
	assert.equal(t.planById(t.store.get(), activeId).settings.dayEnd, "21:00");
	assert.equal(t.store.get().settings.dayEnd, "21:00", "编辑当前方案保存后要立刻生效");
	assert.deepEqual(t.store.get().records, records, "编辑方案不能动统计");
	assert.equal(t.planDrifted(t.store.get()), false, "保存之后不该再显示「有改动」");

	// 取消：草稿丢掉，方案原样；关掉没在编辑的弹窗返回 false。
	assert.equal(t.openPlanEditor(activeId), true);
	t.patchPlanEditor({ dayEnd: "05:00" });
	assert.equal(t.closePlanEditor(), true);
	assert.equal(t.planEditorOf(), null);
	assert.equal(t.planById(t.store.get(), activeId).settings.dayEnd, "21:00", "取消后方案保持原样");
	assert.equal(t.closePlanEditor(), false, "没在编辑时关闭返回 false");

	// 正编辑着方案被删掉：保存只是关掉弹窗，不抛错。
	assert.equal(t.openPlanEditor(activeId), true);
	t.removePlan(activeId);
	assert.equal(t.savePlanEditor(), false, "方案已经不在，保存返回 false");
	assert.equal(t.planEditorOf(), null);
});
//#endregion

//#region 6. 加载状态与持久化
check("store 读写 localStorage 且能容错", () => {
	resetStore();
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ water: { target: 10 } }) });
	assert.ok(storage.size >= 1, "应写入本地存储");
	const reloaded = JSON.parse(storage.get("dsh-health-reminder/state.v1"));
	assert.equal(reloaded.settings.kinds.water.target, 10);

	storage.set("dsh-health-reminder/state.v1", "{ 坏掉的 JSON");
	t.store.state = null;
	assert.equal(t.store.get().settings.kinds.water.target, 8, "坏数据应回退默认值");
});

check("loadState 会用默认值补齐缺字段", () => {
	storage.clear();
	storage.set("dsh-health-reminder/state.v1", JSON.stringify({ settings: { workdays: [2, 4] }, records: { "2026-10-05": { water: 3 } } }));
	t.store.state = null;
	const state = t.store.get();
	assert.deepEqual(state.settings.workdays, [2, 4]);
	assert.equal(state.settings.kinds.stand.target, 8);
	assert.equal(state.settings.notify.system, true);
	assert.equal(state.records["2026-10-05"].water, 3);
	assert.deepEqual(state.runtime.pending, []);
	assert.equal(state.plans.length, 1, "老状态读进来要兜一份「默认方案」");
	assert.equal(state.plans[0].name, "默认方案");
	assert.equal(state.activePlanId, state.plans[0].id);
	assert.equal(state.plans[0].settings.kinds.stand.target, 8, "兜底方案记的是归一化之后的设置");
});
//#endregion

//#region 7. 席位注册与界面冒烟
const registrations = [];
const effectFns = [];
const commandRegistrations = [];
const fakeCtx = {
	get: () => null,
	effect(fn) {
		effectFns.push(fn);
		return () => {};
	},
	commandUi: {
		register(contribution) {
			commandRegistrations.push(contribution);
			return () => {};
		}
	},
	slots: {
		inject(slotName, register) {
			const out = register();
			registrations.push({ slotName, out });
			return () => {};
		},
		register(meta, component) {
			return { meta, component };
		}
	}
};

check("apply 注册五个席位并启动调度", () => {
	resetStore();
	mod.apply(fakeCtx);
	const names = registrations.map((item) => item.slotName).sort();
	assert.deepEqual(names, ["conversation.composer.dock", "main", "settings.section", "shell.overlay", "sidebar.panellist"]);
	for (const item of registrations) {
		assert.equal(typeof item.out.component, "function", `${item.slotName} 应注册组件`);
		assert.ok(item.out.meta && item.out.meta.name === item.slotName);
	}
	assert.equal(registrations.find((item) => item.slotName === "sidebar.panellist").out.meta.id, t.PANEL_ID);
	assert.equal(registrations.find((item) => item.slotName === "main").out.meta.key, t.PANEL_ID);
	assert.equal(registrations.find((item) => item.slotName === "conversation.composer.dock").out.meta.id, `${t.PANEL_ID}-dock`);
	assert.equal(registrations.find((item) => item.slotName === "settings.section").out.meta.id, t.PANEL_ID);
	assert.equal(effectFns.length, 3, "应注册「界面挂载」「调度器」「会话命令」三个 effect");
	const stopScheduler = effectFns[1]();
	assert.equal(typeof stopScheduler, "function");
	stopScheduler();
	const stopCommands = effectFns[2]();
	assert.equal(typeof stopCommands, "function");
	assert.equal(commandRegistrations.length, 1, "应贡献一条会话命令");
	assert.equal(commandRegistrations[0].name, "health");
	assert.equal(commandRegistrations[0].ui.kind, "action");
	stopCommands();
	const stopUi = effectFns[0]();
	assert.equal(typeof stopUi, "function");
	stopUi();
});

check("设置：音量、音色与全屏静音会归一化，坏值回退", () => {
	const settings = t.normalizeSettings({ notify: { tone: "chime", volume: 0.4, muteFullscreen: false } });
	assert.equal(settings.notify.tone, "chime");
	assert.equal(settings.notify.volume, 0.4);
	assert.equal(settings.notify.muteFullscreen, false);

	const high = t.normalizeSettings({ notify: { volume: 1.7 } });
	assert.equal(high.notify.volume, 1, "音量上限是 1");
	const low = t.normalizeSettings({ notify: { volume: -3 } });
	assert.equal(low.notify.volume, 0.05, "音量下限是 0.05");

	const broken = t.normalizeSettings({ notify: { tone: "no-such-tone", volume: "很响", muteFullscreen: "yes" } });
	assert.equal(broken.notify.tone, "ding", "不认识的音色回退默认");
	assert.equal(broken.notify.volume, 0.7, "非数字音量回退默认");
	assert.equal(broken.notify.muteFullscreen, true, "只有显式 false 才关掉全屏静音");
	assert.deepEqual(t.TONE_IDS, ["ding", "soft", "chime"]);
});

check("提示音：音色与音量来自设置，全屏静音时不发声", () => {
	resetStore();
	const oscillators = [];
	const peaks = [];
	class FakeParam {
		setValueAtTime() {}
		exponentialRampToValueAtTime(value) {
			peaks.push(value);
		}
	}
	class FakeOscillator {
		constructor() {
			this.type = "sine";
			this.frequency = { value: 0 };
			oscillators.push(this);
		}
		connect() {}
		start() {}
		stop() {}
	}
	class FakeGain {
		constructor() {
			this.gain = new FakeParam();
		}
		connect() {}
	}
	class FakeAudioContext {
		constructor() {
			this.state = "running";
			this.currentTime = 0;
			this.destination = {};
		}
		createOscillator() {
			return new FakeOscillator();
		}
		createGain() {
			return new FakeGain();
		}
	}
	const savedAudio = globalThis.AudioContext;
	const savedDocument = globalThis.document;
	globalThis.AudioContext = FakeAudioContext;
	const notify = (patch) => t.updateSettings({ notify: { sound: true, system: false, inApp: true, muteFullscreen: false, volume: 1, tone: "ding", ...patch } });
	try {
		notify({ tone: "chime", volume: 1 });
		t.playBeep("water");
		assert.equal(oscillators.length, 2, "每次提醒两声");
		assert.equal(oscillators[0].type, "triangle", "双音铃用 triangle 波");
		assert.ok(Math.abs(peaks[0] - 0.12) < 1e-9, `音量 100% 时峰值应是音色基准 0.12，实际 ${peaks[0]}`);

		oscillators.length = 0;
		peaks.length = 0;
		notify({ tone: "soft", volume: 0.5 });
		t.playBeep("water");
		assert.equal(oscillators[0].type, "sine");
		assert.ok(Math.abs(peaks[0] - 0.04) < 1e-9, "柔和音色 0.08 × 50% = 0.04");

		// 全屏（演示 / 看视频）时静音：只影响声音，统计与应用内卡片照常。
		globalThis.document = { fullscreenElement: {} };
		assert.equal(t.isFullscreenActive(), true);
		oscillators.length = 0;
		notify({ muteFullscreen: true });
		t.announce("water", Date.now());
		assert.equal(oscillators.length, 0, "全屏且开启静音时不应发声");
		notify({ muteFullscreen: false });
		t.announce("water", Date.now());
		assert.equal(oscillators.length, 2, "关掉全屏静音后恢复发声");
	} finally {
		if (savedAudio === undefined) delete globalThis.AudioContext;
		else globalThis.AudioContext = savedAudio;
		if (savedDocument === undefined) delete globalThis.document;
		else globalThis.document = savedDocument;
	}
});

check("界面：设置里有音量、音色、全屏静音与快捷操作", () => {
	resetStore();
	const section = registrations.find((item) => item.slotName === "settings.section").out.component;
	const tree = renderRoot(section, {});
	for (const label of ["音量", "音色", "全屏时静音", "快捷操作"]) {
		assert.match(tree.text, new RegExp(label), `设置里应有「${label}」`);
	}
	for (const label of ["清脆", "柔和", "双音铃"]) {
		assert.match(tree.text, new RegExp(label), `音色分段选择器应有「${label}」`);
	}
	assert.equal(
		tree.elements.some((node) => node.type === "select"),
		false,
		"不该用原生下拉：它的选项弹层由系统绘制，跟不了主题"
	);
	const toneButtons = tree.elements.filter((node) => node.type === "button" && typeof node.props?.["aria-pressed"] === "boolean");
	assert.ok(toneButtons.length >= 3, "音色应是自绘的分段按钮");
	assert.ok(
		tree.elements.some((node) => node.props?.role === "group"),
		"分段选择器应有 role=group"
	);
	assert.ok(
		tree.elements.some((node) => node.props?.style?.colorScheme === "inherit"),
		"页面根节点应跟着宿主主题（colorScheme: inherit）"
	);
	assert.ok(tree.elements.some((node) => node.type === "input" && node.props.type === "range"), "音量应是一个滑块");
});

check("会话命令：/health 打开面板，小结与复制按钮是同一份文本", () => {
	resetStore();
	t.setDockOpen(false);
	const contributions = t.commandContributions();
	assert.equal(contributions.length, 1);
	const [command] = contributions;
	assert.equal(command.name, "health");
	assert.equal(command.available({}), true);
	assert.match(command.label(), /健康提醒/);
	assert.match(command.description(), /小结/);
	assert.equal(command.ui.kind, "action", "命令应是裸调用动作，不提交消息");
	command.ui.run({ sessionId: "s1" });
	assert.equal(t.isDockOpen(), true, "/health 应展开底部快捷卡片");

	const now = Date.now();
	t.completeKind("water", now);
	const text = t.summaryText(t.store.get(), now);
	assert.match(text, /^健康提醒小结 · \d{4}-\d{2}-\d{2} 周[一二三四五六日]/);
	assert.match(text, /作息：周一、周二、周三、周四、周五、周六 10:00-19:00/);
	assert.match(text, /喝水 1\/8（250 ml）/);
	assert.match(text, /连续达标 0 天/);
	assert.match(text, /近 7 天达标 \d\/7/);
	assert.match(text, /近 7 天：/);
	assert.ok(text.split("\n").length >= 4, "小结应分成多行");
});

check("界面：今日页有「复制今日小结」，报告页签仍有导出 / 导入", () => {
	resetStore();
	hookState.set("HealthPanelPage#2", "today");
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const today = renderRoot(panel, {}, true);
	const copy = today.elements.find((node) => node.type === "button" && flatText(node.props?.children).includes("复制今日小结"));
	assert.ok(copy, "今日页应有复制小结按钮");
	assert.equal(typeof copy.props.onClick, "function");

	hookState.set("HealthPanelPage#2", "report");
	const report = renderRoot(panel, {}, true);
	assert.match(report.text, /导出 JSON/);
	assert.match(report.text, /导入/);
});

check("apply 在席位缺失 / 空 ctx 下不抛错", () => {
	assert.doesNotThrow(() => mod.apply({ effect: () => {}, get: () => null }));
	assert.doesNotThrow(() => mod.apply({ slots: undefined, effect: () => {}, get: () => null }));
	assert.doesNotThrow(() =>
		mod.apply({
			effect: () => {},
			get: () => null,
			slots: {
				inject: () => {
					throw new Error("席位没装");
				}
			}
		})
	);
});

/**
 * 一次性渲染：调用函数组件、递归展开元素树，返回所有文本 + 遇到的组件。
 * 这足以发现「组件里写了会抛错的代码」这类问题（不做真正的 diff/更新）。
 */
function renderRoot(fn, props, keepState) {
	if (!keepState) {
		hookState.clear();
		refState.clear();
	}
	const texts = [];
	const found = new Map();
	const elements = [];
	const walk = (child) => {
		if (child === null || child === undefined || typeof child === "boolean") return;
		if (Array.isArray(child)) {
			child.forEach(walk);
			return;
		}
		if (typeof child === "string" || typeof child === "number") {
			texts.push(String(child));
			return;
		}
		if (child.$$element) elements.push(child);
		if (typeof child.type === "function") {
			found.set(child.type.name, child.type);
			const previous = componentKey;
			componentKey = child.type.name || "anonymous";
			hooks.cursor = 0;
			const out = child.type(child.props ?? {});
			componentKey = previous;
			walk(out);
			return;
		}
		walk(child.props?.children);
	};
	componentKey = fn.name || "anonymous";
	hooks.cursor = 0;
	walk(fn(props ?? {}));
	return { text: texts.join(" | "), found, elements };
}

/** 把元素的 children 拼成一行文本，便于按按钮上的字找按钮。 */
function flatText(child) {
	if (child === null || child === undefined || typeof child === "boolean") return "";
	if (Array.isArray(child)) return child.map(flatText).join("");
	if (typeof child === "string" || typeof child === "number") return String(child);
	return flatText(child.props?.children);
}

/** 找到文字匹配的按钮并点一下（测试里唯一的交互手段）。 */
function click(tree, label) {
	const element = tree.elements.find((node) => node.type === "button" && flatText(node.props?.children).includes(label));
	assert.ok(element, `页面上找不到按钮：${label}`);
	assert.equal(typeof element.props.onClick, "function", `按钮没有 onClick：${label}`);
	element.props.onClick({ preventDefault() {}, stopPropagation() {} });
	return element;
}
/** 往输入框里打字（按 placeholder 找），记得再渲染一次让按钮拿到新值。 */
function typeInto(tree, placeholder, value) {
	const element = tree.elements.find((node) => node.type === "input" && String(node.props?.placeholder ?? "").includes(placeholder));
	assert.ok(element, `页面上找不到输入框：${placeholder}`);
	assert.equal(typeof element.props.onChange, "function", `输入框没有 onChange：${placeholder}`);
	element.props.onChange({ target: { value } });
	return element;
}

check("侧边栏图标与主面板能渲染（三个页签都不抛错）", () => {
	resetStore();
	const icon = registrations.find((item) => item.slotName === "sidebar.panellist").out.component;
	const panel = registrations.find((item) => item.slotName === "main").out.component;

	assert.equal(renderRoot(icon, { size: 16 }).text, "", "图标是纯 svg，没有文本");

	const today = renderRoot(panel, {});
	assert.match(today.text, /健康提醒/);
	assert.match(today.text, /下一次提醒/);
	assert.match(today.text, /今日进度/);
	assert.match(today.text, /连续达标/);
	assert.match(today.text, /今日记录/);

	assert.ok(!today.found.has("SettingsView"), "今日页签里不应有设置页组件");
	// 切到「设置」页签：保留 hook 状态，让面板真的渲染出 SettingsView。
	hookState.set("HealthPanelPage#2", "settings");
	const settingsTab = renderRoot(panel, {}, true);
	assert.ok(settingsTab.found.get("SettingsView"), "设置页签应渲染 SettingsView");
	assert.match(settingsTab.text, /上班日/);
	assert.match(settingsTab.text, /午休（不提醒）/);
	assert.match(settingsTab.text, /提醒方式/);
	assert.match(settingsTab.text, /恢复默认设置/);

	// 切到「方案」页签：此时一份方案都还没有。
	hookState.set("HealthPanelPage#2", "plans");
	const planTab = renderRoot(panel, {}, true);
	assert.ok(planTab.found.get("PlansView"), "「方案」页签应渲染 PlansView");
	assert.match(planTab.text, /当前方案/);
	assert.match(planTab.text, /新建方案/);
	assert.match(planTab.text, /还没有方案/);
	assert.equal(/方案对话/.test(planTab.text), false, "「方案对话」应当整块删掉");

	// 照当前设置建一份：方案行、要点与「使用中」标记都应在。
	click(planTab, "照当前设置新建");
	assert.equal(t.store.get().plans.length, 1, "「照当前设置新建」应存下一份方案");
	const planDone = renderRoot(panel, {}, true);
	assert.ok(planDone.found.get("PlanRow"), "有方案时要渲染方案行");
	assert.match(planDone.text, /使用中/);
	assert.match(planDone.text, /周一~周六/);
	assert.match(planDone.text, /提醒方式：/);

	const bannerText = renderRoot(today.found.get("ReminderBanner"), {});
	assert.equal(bannerText.text, "", "没有待处理项时面板内兜底横幅不渲染");
});

check("界面：开启护眼后「今日」页与按钮带上它", () => {
	resetStore(freshState({ settings: t.normalizeSettings({ kinds: { eyes: { on: true } } }) }));
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	hookState.clear();
	const today = renderRoot(panel, {});
	assert.match(today.text, /护眼/);
	assert.match(today.text, /完成一次护眼/);
});

check("界面：报告页签有趋势、累计与导出 / 导入入口（没有成就）", () => {
	resetStore(freshState({ records: reportRecords() }));
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	renderRoot(panel, {});
	hookState.set("HealthPanelPage#2", "report");
	const view = renderRoot(panel, {}, true);
	assert.ok(view.found.get("ReportView"), "报告页签应渲染 ReportView");
	assert.match(view.text, /健康报告/);
	assert.match(view.text, /近 7 天/);
	assert.match(view.text, /达标天数/);
	assert.match(view.text, /最长连续/);
	assert.match(view.text, /每类累计/);
	assert.equal(/成就/.test(view.text), false, "成就已经去掉，报告页不该再出现");
	assert.equal("achievementsOf" in t, false, "成就的计算函数与导出也一并删掉");
	assert.match(view.text, /导出 JSON/);
	assert.match(view.text, /导入粘贴内容/);

	// 空内容粘贴导入要给出明确提示，不能静默失败。
	click(view, "导入粘贴内容");
	const after = renderRoot(panel, {}, true);
	assert.match(after.text, /导入失败/);
});

check("等待提醒时面板内兜底横幅会显示", () => {
	resetStore();
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const tree = renderRoot(panel, {});
	t.store.set({ ...t.store.get(), runtime: { ...t.store.get().runtime, pending: [{ kind: "water", at: Date.now(), id: "x" }] } });
	const banner = renderRoot(tree.found.get("ReminderBanner"), {});
	assert.match(banner.text, /该喝水了/);
	assert.match(banner.text, /10 分钟后再提醒/);
	assert.match(banner.text, /今天不再提醒/);
});

check("全局浮层：未展开时是提醒横幅，展开后是快捷卡片", () => {
	resetStore();
	t.setDockOpen(false);
	const overlay = registrations.find((item) => item.slotName === "shell.overlay").out.component;
	assert.equal(renderRoot(overlay, {}).text, "", "没有待处理项、也没展开时不渲染");

	const now = ms(1, 10, 30);
	t.store.set({ ...t.store.get(), runtime: { ...t.store.get().runtime, pending: [{ kind: "stand", at: now, id: "x" }] } });
	assert.match(renderRoot(overlay, {}).text, /该起身活动了/);

	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, notify: { inApp: false } }) });
	assert.equal(renderRoot(overlay, {}).text, "", "关掉应用内提示卡后不渲染横幅");
});

check("清单：客户端模块必须 immediately 加载，并声明会用到的外壳插件", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.equal(manifest.dsh.client.platform, "web");
	assert.equal(manifest.dsh.client.immediately, true, "dsh.client.immediately 不是 true 时，启动器不会预取模块，入口就不会出现");
	for (const id of ["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-commands"]) {
		assert.ok(manifest.dsh.client.inject.includes(id), `dsh.client.inject 应声明 ${id}`);
	}
	const clientSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "client.js"), "utf8");
	const diagVersion = clientSrc.match(/recordDiag\(\{\s*applyAt: Date\.now\(\),\s*version: "([^"]+)"/)?.[1];
	assert.ok(diagVersion, "client.js 的 apply 里应记录诊断版本号");
	assert.equal(manifest.version, diagVersion, "清单与诊断里的版本号要一致");
	assert.ok(fs.existsSync(path.join(import.meta.dirname, "..", "icon.svg")), "清单里引用的 icon.svg 必须存在");
});

check("底部入口：图标 + 文字，状态跟着提醒走", () => {
	resetStore();
	t.setDockOpen(false);
	const dock = registrations.find((item) => item.slotName === "conversation.composer.dock").out.component;
	const idle = renderRoot(dock, {});
	assert.match(idle.text, /健康提醒/);
	assert.match(idle.text, /💧/);
	assert.match(idle.text, /🧍/);
	assert.ok(idle.found.get("HealthIcon"), "入口要带水滴图标");

	t.store.set({ ...t.store.get(), runtime: { ...t.store.get().runtime, pending: [{ kind: "water", at: Date.now(), id: "x" }] } });
	assert.match(renderRoot(dock, {}).text, /该喝水了/);

	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, enabled: false }) });
	assert.match(renderRoot(dock, {}).text, /已暂停/);
});

check("展开后浮层换成快捷卡片，收起时恢复横幅", () => {
	resetStore();
	const overlay = registrations.find((item) => item.slotName === "shell.overlay").out.component;
	t.setDockOpen(true);
	assert.equal(t.isDockOpen(), true);
	const panel = renderRoot(overlay, {});
	assert.match(panel.text, /下次喝水/);
	assert.match(panel.text, /下次起身/);
	assert.match(panel.text, /记一杯水/);
	assert.match(panel.text, /记一次起身/);
	assert.match(panel.text, /完整面板/);
	assert.match(panel.text, /连续达标/);
	t.setDockOpen(false);
	assert.equal(t.isDockOpen(), false);
	assert.equal(renderRoot(overlay, {}).text, "", "收起且无待处理项时不渲染");
});

check("设置界面里的「健康提醒」一节", () => {
	resetStore();
	t.setDockOpen(false);
	const section = registrations.find((item) => item.slotName === "settings.section").out.component;
	const tree = renderRoot(section, { close: () => {} });
	assert.match(tree.text, /健康提醒/);
	assert.ok(tree.found.get("SettingsView"), "设置一节要复用 SettingsView");
	assert.match(tree.text, /上班日/);
	assert.match(tree.text, /提醒方式/);
	assert.match(tree.text, /恢复默认设置/);
});
check("面板「设置」页签与设置里的「健康提醒」页是同一页", () => {
	resetStore();
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const section = registrations.find((item) => item.slotName === "settings.section").out.component;
	renderRoot(panel, {});
	hookState.set("HealthPanelPage#2", "settings");
	const fromPanel = renderRoot(panel, {}, true);
	const fromSettings = renderRoot(section, { close: () => {} });
	for (const name of ["SettingsPane", "SettingsView", "ProgressRow"]) {
		assert.ok(fromPanel.found.has(name), `面板设置页签应有 ${name}`);
		assert.ok(fromSettings.found.has(name), `设置里的健康提醒页应有 ${name}`);
	}
	for (const [where, tree] of [["面板设置页签", fromPanel], ["设置里的健康提醒页", fromSettings]]) {
		assert.match(tree.text, /今日概况/, `${where}要有今日概况`);
		assert.match(tree.text, /上班日/, `${where}要有作息设置`);
		assert.match(tree.text, /提醒方式/, `${where}要有提醒方式`);
		assert.match(tree.text, /恢复默认设置/, `${where}要有恢复默认设置`);
	}
});

check("危险操作先弹确认框：取消不动数据，确认才执行", async () => {
	resetStore();
	t.setDockOpen(false);
	const section = registrations.find((item) => item.slotName === "settings.section").out.component;
	const overlay = registrations.find((item) => item.slotName === "shell.overlay").out.component;
	renderRoot(overlay, {}); // 让确认弹窗先把订阅挂上

	const records = { [t.dayKey(new Date())]: { water: 3, stand: 1, skips: 0, log: [] } };
	t.store.set({ ...t.store.get(), records });
	assert.match(renderRoot(section, { close: () => {} }).text, /清空全部统计/);

	// 点危险按钮：只登记一个待确认请求，数据一动不动。
	click(renderRoot(section, { close: () => {} }), "清空全部统计");
	assert.equal(t.isConfirmOpen(), true, "点危险按钮后应留下待确认请求");
	assert.deepEqual(t.store.get().records, records, "确认之前不能改数据");
	const confirmTree = renderRoot(overlay, {});
	assert.match(confirmTree.text, /清空全部统计？/);
	assert.match(confirmTree.text, /取消/);

	// 取消：弹窗消失，数据原样。
	click(confirmTree, "取消");
	await flush();
	assert.equal(t.isConfirmOpen(), false, "取消后不应还留着待确认请求");
	assert.deepEqual(t.store.get().records, records, "取消后数据必须原样");
	assert.ok(!/清空全部统计？/.test(renderRoot(overlay, {}).text), "取消后弹窗要消失");

	// 确认后才真的清空。
	click(renderRoot(section, { close: () => {} }), "清空全部统计");
	click(renderRoot(overlay, {}), "全部清空");
	await flush();
	assert.deepEqual(t.store.get().records, {}, "确认后才清空统计");
	assert.equal(t.isConfirmOpen(), false);

	// 「恢复默认设置」同样要先问一句。
	t.store.set({ ...t.store.get(), records });
	const tweaked = { ...t.store.get().settings, kinds: { ...t.store.get().settings.kinds, water: { ...t.store.get().settings.kinds.water, intervalMin: 90 } } };
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings(tweaked) });
	click(renderRoot(section, { close: () => {} }), "恢复默认设置");
	click(renderRoot(overlay, {}), "取消");
	await flush();
	assert.equal(t.store.get().settings.kinds.water.intervalMin, 90, "取消恢复默认后设置不能被改");
	assert.deepEqual(t.store.get().records, records, "取消恢复默认后统计不能被清");
});

check("方案页：新建 / 应用 / 重命名 / 删除都能走通，覆盖与删除先确认", async () => {
	resetStore();
	t.setDockOpen(false);
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const overlay = registrations.find((item) => item.slotName === "shell.overlay").out.component;
	renderRoot(overlay, {});
	renderRoot(panel, {});
	hookState.set("HealthPanelPage#2", "plans");
	let tree = renderRoot(panel, {}, true);

	assert.ok(tree.found.get("PlansView"), "「方案」页签应渲染 PlansView");
	assert.match(tree.text, /当前方案/);
	assert.match(tree.text, /新建方案/);
	assert.match(tree.text, /全部方案/);
	assert.match(tree.text, /还没有方案/);
	assert.match(tree.text, /（没选）/);
	assert.equal(t.isConfirmOpen(), false);

	// 对话那一套应当整块消失：界面、状态、测试导出里都不该留影子。
	assert.equal(/方案对话/.test(tree.text), false, "「方案对话」整块应当删掉");
	assert.equal("chat" in t.store.get(), false, "状态里不该再有 chat");
	assert.equal("newChat" in t, false, "对话相关的测试导出也要删干净");
	assert.equal("chatAdvance" in t, false);

	// 新建：照当前设置存一份，轻动作，不弹确认。
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, dayStart: "09:00" }) });
	typeInto(tree, "例如：工作日上午", "工作日上午");
	tree = renderRoot(panel, {}, true);
	click(tree, "照当前设置新建");
	assert.equal(t.isConfirmOpen(), false, "新建方案不该弹确认");
	assert.equal(t.store.get().plans.length, 1);
	assert.equal(t.planById(t.store.get(), t.store.get().activePlanId).name, "工作日上午");

	// 改一处设置：当前方案立刻显示「有改动」，并提示不一致。
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, dayEnd: "20:00" }) });
	hookState.set("HealthPanelPage#2", "plans");
	tree = renderRoot(panel, {}, true);
	assert.match(tree.text, /使用中/, "当前方案要有标记");
	assert.match(tree.text, /有改动/, "改过设置之后要提示和方案不一致");

	// 「保存到方案」先问一句；取消则设置保持原样。
	click(tree, "保存到方案");
	assert.equal(t.isConfirmOpen(), true, "覆盖方案前要先确认");
	assert.match(renderRoot(overlay, {}).text, /保存到这份方案？/);
	click(renderRoot(overlay, {}), "取消");
	await flush();
	assert.equal(t.isConfirmOpen(), false);
	assert.equal(t.store.get().settings.dayEnd, "20:00", "取消后当前设置不能被动");

	// 确认之后快照被覆盖，「有改动」标记消失。
	hookState.set("HealthPanelPage#2", "plans");
	click(renderRoot(panel, {}, true), "保存到方案");
	click(renderRoot(overlay, {}), "保存");
	await flush();
	assert.equal(t.planById(t.store.get(), t.store.get().activePlanId).settings.dayEnd, "20:00");
	assert.equal(t.planDrifted(t.store.get()), false, "覆盖之后不该再显示「有改动」");

	// 再改乱，用「恢复方案」退回快照。
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, dayEnd: "21:00" }) });
	hookState.set("HealthPanelPage#2", "plans");
	click(renderRoot(panel, {}, true), "恢复方案");
	click(renderRoot(overlay, {}), "恢复");
	await flush();
	assert.equal(t.store.get().settings.dayEnd, "20:00", "「恢复方案」应把设置退回快照");

	// 再建第二份，然后点第一行的「应用」切回去。
	t.store.set({ ...t.store.get(), settings: t.normalizeSettings({ ...t.store.get().settings, dayStart: "06:30" }) });
	hookState.set("HealthPanelPage#2", "plans");
	tree = renderRoot(panel, {}, true);
	typeInto(tree, "例如：工作日上午", "早班");
	tree = renderRoot(panel, {}, true);
	click(tree, "照当前设置新建");
	const first = t.store.get().plans[0];
	const second = t.store.get().plans[1];
	assert.equal(t.store.get().activePlanId, second.id, "新建的这份应当直接生效");

	hookState.set("HealthPanelPage#2", "plans");
	tree = renderRoot(panel, {}, true);
	assert.match(tree.text, /使用中/);
	click(tree, "应用");
	assert.equal(t.store.get().activePlanId, first.id, "点「应用」应当换到那一份");
	assert.equal(t.store.get().settings.dayStart, "09:00", "切过去要拿到那份方案的作息");
	assert.equal(t.store.get().plans.length, 2, "切换不会多出方案");
	assert.equal(t.planDrifted(t.store.get()), false, "刚切换过来不该显示「有改动」");

	// 删除要确认；取消不动，确认才真的删（删的正好是当前那份，只清「当前」）。
	const settingsBefore = t.store.get().settings;
	hookState.set("HealthPanelPage#2", "plans");
	tree = renderRoot(panel, {}, true);
	click(tree, "删除");
	assert.equal(t.isConfirmOpen(), true, "删除方案前要先确认");
	assert.match(renderRoot(overlay, {}).text, /删除「工作日上午」？/);
	click(renderRoot(overlay, {}), "取消");
	await flush();
	assert.equal(t.store.get().plans.length, 2, "取消后方案不能被删");
	assert.equal(t.isConfirmOpen(), false);

	hookState.set("HealthPanelPage#2", "plans");
	click(renderRoot(panel, {}, true), "删除");
	click(renderRoot(overlay, {}), "删除");
	await flush();
	assert.equal(t.store.get().plans.length, 1, "确认后才真的删掉");
	assert.equal(t.store.get().plans[0].id, second.id);
	assert.equal(t.store.get().activePlanId, null, "删掉当前方案只把「当前」清掉");
	assert.deepEqual(t.store.get().settings, settingsBefore, "删方案不能顺手改设置");
	assert.equal(t.isConfirmOpen(), false);
});

check("方案页的「编辑」弹窗：改完保存写回方案，取消不动", async () => {
	resetStore();
	t.setDockOpen(false);
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const overlay = registrations.find((item) => item.slotName === "shell.overlay").out.component;
	renderRoot(overlay, {}); // 先渲染一次，让弹窗把订阅挂上
	renderRoot(panel, {});
	const planId = t.savePlan("工作日上午", null);
	hookState.set("HealthPanelPage#2", "plans");
	const tree = renderRoot(panel, {}, true);
	assert.match(tree.text, /编辑/, "方案行要有「编辑」");
	click(tree, "编辑");
	assert.equal(t.planEditorOf()?.id, planId, "点「编辑」应当打开这份方案的弹窗");
	assert.equal(t.isConfirmOpen(), false, "编辑不是危险动作，不该弹确认");

	let dialog = renderRoot(overlay, {});
	assert.match(dialog.text, /编辑「工作日上午」/);
	assert.match(dialog.text, /方案名字/);
	assert.match(dialog.text, /上班日/);
	assert.match(dialog.text, /提醒间隔/);
	assert.match(dialog.text, /提醒方式/);
	assert.match(dialog.text, /这份正在使用/);

	const numbers = dialog.elements.filter((node) => node.type === "input" && node.props?.type === "number");
	assert.ok(numbers.length >= 4, `每类提醒都要有数字输入框：${numbers.length}`);
	numbers[0].props.onChange({ target: { value: "25" } });
	assert.equal(t.planEditorOf().draft.kinds.water.intervalMin, 25, "改数字要落到草稿上");

	const nameInput = dialog.elements.find((node) => node.type === "input" && node.props?.type === undefined && node.props?.value === "工作日上午");
	assert.ok(nameInput, "弹窗里要有方案名字输入框");
	nameInput.props.onChange({ target: { value: "早班" } });
	assert.equal(t.planEditorOf().name, "早班");

	// 保存：写回这份方案（它正好是当前方案，所以设置也一起换成新配置）。
	click(renderRoot(overlay, {}), "保存");
	assert.equal(t.planEditorOf(), null, "保存后弹窗关闭");
	assert.equal(t.planById(t.store.get(), planId).name, "早班");
	assert.equal(t.planById(t.store.get(), planId).settings.kinds.water.intervalMin, 25);
	assert.equal(t.store.get().settings.kinds.water.intervalMin, 25, "编辑当前方案保存后要立刻生效");
	assert.equal(/编辑「/.test(renderRoot(overlay, {}).text), false, "保存后弹窗消失");

	// 取消：改过的数字不写回，也不多出方案。
	hookState.set("HealthPanelPage#2", "plans");
	click(renderRoot(panel, {}, true), "编辑");
	dialog = renderRoot(overlay, {});
	const again = dialog.elements.filter((node) => node.type === "input" && node.props?.type === "number");
	again[0].props.onChange({ target: { value: "90" } });
	assert.equal(t.planEditorOf().draft.kinds.water.intervalMin, 90);
	click(renderRoot(overlay, {}), "取消");
	assert.equal(t.planEditorOf(), null);
	assert.equal(t.planById(t.store.get(), planId).settings.kinds.water.intervalMin, 25, "取消后方案保持原样");
	assert.equal(/编辑「/.test(renderRoot(overlay, {}).text), false, "取消后弹窗消失");
	assert.equal(t.store.get().plans.length, 1, "编辑不会多出方案");
});

check("浮层席位缺席时，方案编辑弹窗改挂在面板里（不会点了没反应）", () => {
	resetStore();
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const planId = t.savePlan("测试方案", null);

	// 外壳完整：shell.overlay 席位可用 → 弹窗只挂浮层那一份。
	const before = effectFns.length;
	mod.apply(fakeCtx);
	assert.equal(effectFns.length - before, 3, "apply 应注册三个 effect");
	t.openPlanEditor(planId);
	hookState.set("HealthPanelPage#2", "plans");
	assert.equal(/编辑「测试方案」/.test(renderRoot(panel, {}, true).text), false, "浮层可用时面板不重复挂弹窗");

	// 外壳撤销 / 没声明 shell.overlay：走「界面挂载」effect 的清理，浮层席位不再可用。
	const stopUi = effectFns[before]();
	assert.equal(typeof stopUi, "function");
	stopUi();
	assert.match(renderRoot(panel, {}, true).text, /编辑「测试方案」/, "浮层席位缺席时，面板里也要能弹出编辑弹窗");
	click(renderRoot(panel, {}, true), "取消");
	assert.equal(t.planEditorOf(), null, "面板里那份弹窗也要能取消");
});

check("「测试系统通知」有反馈：权限没拿到 / 环境不支持都会说出原因", () => {
	resetStore();
	hookState.set("HealthPanelPage#2", "settings");
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const tree = renderRoot(panel, {}, true);
	const button = tree.elements.find((node) => node.type === "button" && flatText(node.props?.children).includes("测试系统通知"));
	assert.ok(button, "设置页应有「测试系统通知」按钮");
	button.props.onClick();
	assert.match(renderRoot(panel, {}, true).text, /不支持系统通知/, "点了要有一句人话，不能静默什么都不发生");

	// 有 Notification 且已授权 → 真发一条；被拒 → 明确告诉用户是权限问题。
	const notes = [];
	const original = globalThis.Notification;
	globalThis.Notification = function (title, options) {
		notes.push({ title, options });
	};
	globalThis.Notification.permission = "granted";
	assert.equal(t.notifySystem("water", Date.now()), "sent");
	assert.equal(notes.length, 1, "授权后应真的构造一条通知");
	assert.match(notes[0].title, /该喝水了/);
	globalThis.Notification.permission = "denied";
	assert.equal(t.notifySystem("water", Date.now()), "denied");
	if (original === undefined) delete globalThis.Notification;
	else globalThis.Notification = original;
});

check("每日目标输入框的上限就是它真正的上限（不给出会被无声裁剪的值）", () => {
	resetStore();
	t.updateSettings({ kinds: { ...t.store.get().settings.kinds, eyes: { ...t.store.get().settings.kinds.eyes, on: true } } });
	hookState.set("HealthPanelPage#2", "settings");
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const tree = renderRoot(panel, {}, true);
	const maxima = tree.elements.filter((node) => node.type === "input" && node.props?.type === "number").map((node) => node.props.max);
	assert.ok(maxima.length >= 4, `每类提醒都要有数字输入框：${maxima.length}`);
	assert.equal(maxima.includes(96), false, "96 是无意义的：归一化会按类型裁到 24 / 24 / 40 / 12");
	assert.equal(maxima.filter((value) => value === 240).length, 4, "四类提醒的间隔上限都是 240");
	assert.equal(maxima.filter((value) => value === 24).length, 2, "喝水 / 起身的目标上限是 24");
	assert.equal(maxima.filter((value) => value === 40).length, 1, "护眼的目标上限是 40");
	assert.equal(maxima.filter((value) => value === 12).length, 1, "拉伸的目标上限是 12");
});

check("面板可滚动：正文自己滚（外壳给的是定高容器）", () => {
	const styles = t.styles;
	assert.equal(styles.panelPage.height, "100%", "面板根必须撑满外壳的定高容器");
	assert.equal(styles.panelPage.display, "flex");
	assert.equal(styles.panelBody.overflowY, "auto", "正文不自己滚，底部的设置项就点不到");
	assert.equal(styles.panelBody.minHeight, 0);

	resetStore();
	const panel = registrations.find((item) => item.slotName === "main").out.component;
	const root = panel({});
	assert.equal(root.props.style, styles.panelPage, "面板根节点用的是 panelPage 布局");
	const body = (root.props.children ?? []).find((child) => child?.props?.style === styles.panelBody);
	assert.ok(body, "页签内容必须包在 panelBody 里");
});

check("诊断通道：席位注册全过程写进 localStorage，供现场排查", () => {
	resetStore();
	mod.apply(fakeCtx);
	const diag = t.readDiag();
	assert.ok(diag, "apply 之后应留下诊断记录");
	assert.equal(diag.version, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")).version, "诊断里的版本号要跟着 package.json 走");
	assert.equal(diag.slotsInject, "function");
	assert.equal(diag.slotsRegister, "function");
	assert.ok(diag.inject.includes("slots"), "诊断里要带 inject 名单");
	for (const slotName of ["sidebar.panellist", "main", "conversation.composer.dock", "settings.section", "shell.overlay"]) {
		const seat = diag.seats?.[slotName];
		assert.ok(seat, `${slotName} 应有诊断`);
		assert.equal(typeof seat.injectedAt, "number", `${slotName} 应记 injectedAt`);
		assert.equal(typeof seat.declaredAt, "number", `${slotName} 应记 declaredAt（外壳真的声明了该席位）`);
	}
	assert.deepEqual(diag.errors, []);

	// 组件被渲染过之后，诊断里要看得出「外壳确实把它画出来了」。
	const dock = registrations.filter((item) => item.slotName === "conversation.composer.dock").at(-1).out.component;
	renderRoot(dock, {});
	assert.equal(typeof t.readDiag().seats["conversation.composer.dock"].paintedAt, "number");
});
//#endregion

//#region 8. 宿主半区：只读探针路由
/** 造一个只记录结果的响应对象。 */
function fakeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: "",
		setHeader(key, value) {
			this.headers[key] = value;
		},
		end(text) {
			if (text !== undefined) this.body = String(text);
		}
	};
}

/** 造一个只带插件用到的服务的宿主 ctx（宿主半区现在只需要 webServer）。 */
function fakeHostCtx() {
	const routes = [];
	const effects = [];
	const ctx = {
		logger: { info() {} },
		effect(fn, label) {
			effects.push(label);
			return fn();
		},
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			}
		}
	};
	return { ctx, routes, effects };
}

const hostPath = path.join(import.meta.dirname, "..", "index.js");
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));

check("宿主半区：只依赖 webServer，注册一条只读探针路由", async () => {
	const host = await import(pathToFileURL(hostPath).href);
	assert.equal(host.name, "dsh-health-reminder");
	assert.deepEqual(host.inject, ["webServer"], "宿主半区不再碰模型与连接");
	const { ctx, routes, effects } = fakeHostCtx();
	host.apply(ctx);
	assert.equal(routes.length, 1, "只应注册一条路由");
	assert.equal(routes[0].kind, "exact");
	assert.equal(routes[0].path, host.internals.STATUS_PATH);
	assert.equal(typeof routes[0].handler, "function");
	assert.equal(effects.length, 1, "路由要在 effect 里注册，随插件释放");
	assert.match(effects[0], /health-reminder/);
});

check("宿主半区：GET / HEAD 报名字与版本，其他方法给 405", async () => {
	const host = await import(pathToFileURL(hostPath).href);
	const { ctx, routes } = fakeHostCtx();
	host.apply(ctx);
	const handler = routes[0].handler;

	const ok = fakeRes();
	handler({ method: "GET" }, ok);
	assert.equal(ok.statusCode, 200);
	assert.equal(ok.headers["content-type"], "application/json; charset=utf-8");
	assert.equal(ok.headers["cache-control"], "no-store");
	assert.deepEqual(JSON.parse(ok.body), { ok: true, name: "dsh-health-reminder", version: pkg.version, client: "web" });
	assert.equal(host.internals.VERSION, pkg.version, "宿主版本号要跟着 package.json 走");

	const head = fakeRes();
	handler({ method: "HEAD" }, head);
	assert.equal(head.statusCode, 200, "HEAD 也要能探活");
	assert.equal(head.body, JSON.stringify({ ok: true, name: "dsh-health-reminder", version: pkg.version, client: "web" }));

	const post = fakeRes();
	handler({ method: "POST" }, post);
	assert.equal(post.statusCode, 405);
	assert.equal(post.headers.allow, "GET, HEAD");
	assert.deepEqual(JSON.parse(post.body), { ok: false, code: "METHOD_NOT_ALLOWED", message: "只支持 GET" });
});

check("宿主半区：ctx 缺 webServer 时不抛错（旧宿主也要能装）", async () => {
	const host = await import(pathToFileURL(hostPath).href);
	assert.doesNotThrow(() => host.apply({ effect: () => {}, logger: { info() {} } }));
	assert.doesNotThrow(() => host.apply({ effect: () => {}, webServer: undefined, logger: undefined }));
});
//#endregion

for (const run of runners) await run();

while (cleanups.length > 0) {
	const cleanup = cleanups.pop();
	try {
		cleanup();
	} catch (error) {
		console.warn("清理失败:", error?.message ?? error);
	}
}

//#region 输出
const failed = results.filter((item) => !item.ok);
for (const item of results) {
	console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
	if (!item.ok) console.log(item.error);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
//#endregion
