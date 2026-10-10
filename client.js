/**
 * 健康提醒插件 · 浏览器半区（Web GUI 面板 + 全部逻辑）
 *
 * 这是一个无构建步骤的普通 JS 客户端插件：宿主加载本文件时只提供 `react`，
 * 所以界面全部用 `react.createElement` 手写，样式只用 DSH 的主题 token
 * （`--dsw-alias-*` / `--dsw-static-*`），不 import 任何 Harness 客户端包。
 *
 * 结构：
 *   1. 基础工具 / 默认设置 / 本地持久化 store
 *   2. 中文自然语言解析 + 方案生成（纯函数，可单测）
 *   3. 提醒调度器（允许时段判定、补发抑制、完成/推迟/跳过）
 *   4. 界面：侧边栏图标、主面板（今日 / 设置 / 方案）、全局提醒横幅
 *   5. apply(ctx)：注册三个席位 + 启动调度器
 */
window.__ModuleLoader__.load({
	id: "dsh-health-reminder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const e = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useMemo = react.useMemo;
		const useRef = react.useRef;

		//#region 常量与默认值
		const PANEL_ID = "health-reminder";
		const PANEL_ORDER = 40;
		const STORAGE_KEY = "dsh-health-reminder/state.v1";
		const TICK_MS = 1000;
		/**
		 * 提醒的迟到窗口：固定时刻表上的点过去超过这个时长才被发现（例如应用关了整晚），
		 * 就只记为「已错过」，不补发。
		 */
		const LATE_MS = 2 * 60000;

		const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
		const WEEKDAY_LABELS = { 1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日" };

		const WATER_TIPS = [
			"现在喝 200-250 ml，一次别灌太多",
			"起身接杯水，顺便走两步",
			"该补水了：别等口渴才喝，口渴时已经缺水了",
			"小口喝完这杯，下午精神会好一些"
		];
		const STAND_TIPS = [
			"站起来靠墙站直，肩胛后收 10 次",
			"起身走一走，做 10 个提踵",
			"颈部左右缓慢绕环各 5 次，别猛甩",
			"站立腰背伸展 30 秒，再做 5 个深蹲（量力而行）"
		];

		/**
		 * 提醒类型表：调度、统计、界面全部从这里取标签、图标、颜色、单位与默认值。
		 * 加一种提醒 = 在这里加一行 + 在 TIPS 里补提示语，其余代码不用动。
		 *
		 * tone 是主题 token 的键（见下面的 T）；off 表示默认关闭。
		 */
		const KIND_DEFS = [
			{
				id: "water",
				label: "喝水",
				icon: "💧",
				tone: "water",
				unit: "杯",
				action: "喝了",
				verb: "记一杯水",
				title: "该喝水了",
				intervalMin: 60,
				target: 8,
				minTarget: 1,
				maxTarget: 24,
				minInterval: 20,
				extra: "glassMl",
				beep: [880, 1174]
			},
			{
				id: "stand",
				label: "起身",
				icon: "🧍",
				tone: "stand",
				unit: "次",
				action: "起来了",
				verb: "记一次起身",
				title: "该起身活动了",
				intervalMin: 45,
				target: 8,
				minTarget: 1,
				maxTarget: 24,
				minInterval: 15,
				extra: "minutes",
				beep: [660, 990]
			},
			{
				id: "eyes",
				label: "护眼",
				icon: "👀",
				tone: "eyes",
				unit: "次",
				action: "远眺了",
				verb: "记一次远眺",
				title: "该看看远处了",
				intervalMin: 20,
				target: 12,
				minTarget: 1,
				maxTarget: 40,
				minInterval: 10,
				beep: [1046, 1318],
				off: true
			},
			{
				id: "stretch",
				label: "拉伸",
				icon: "🧘",
				tone: "stretch",
				unit: "次",
				action: "做完了",
				verb: "记一次拉伸",
				title: "该拉伸一下了",
				intervalMin: 90,
				target: 3,
				minTarget: 1,
				maxTarget: 12,
				minInterval: 20,
				beep: [523, 784],
				off: true
			}
		];
		const KIND_IDS = KIND_DEFS.map((item) => item.id);
		const KIND_BY_ID = new Map(KIND_DEFS.map((item) => [item.id, item]));
		/** 取类型定义；未知 id 回退到第一个类型，保证界面永远能渲染。 */
		function kindDef(kind) {
			return KIND_BY_ID.get(kind) ?? KIND_DEFS[0];
		}
		/** 类型颜色：T 在本文件后面才定义，所以这里延迟解析。 */
		function kindColor(kind) {
			return T[kindDef(kind).tone] ?? T.brand;
		}

		/**
		 * 提示音音色（全部由 WebAudio 现场合成，插件不带音频文件）。
		 * wave 是振荡器波形，gain 是相对音量，gap/dur 控制两声之间的间隔与单声长度。
		 */
		const TONES = {
			ding: { label: "清脆（默认）", wave: "sine", gain: 0.14, gap: 0.2, dur: 0.2 },
			soft: { label: "柔和", wave: "sine", gain: 0.08, gap: 0.28, dur: 0.32 },
			chime: { label: "双音铃", wave: "triangle", gain: 0.12, gap: 0.16, dur: 0.16 }
		};
		const TONE_IDS = Object.keys(TONES);

		/** 每类提醒的提示语，按当天已处理条数轮换。 */
		const TIPS = {
			water: WATER_TIPS,
			stand: STAND_TIPS,
			eyes: [
				"20-20-20：看 6 米外 20 秒，让睫状肌松一下",
				"闭眼 20 秒，再看向窗外最远的地方",
				"远眺 20 秒，顺便眨几下眼，别揉"
			],
			stretch: [
				"颈肩左右缓慢绕环各 5 次，别猛甩",
				"靠墙站直，肩胛后收 10 次",
				"站立腰背伸展 30 秒，再做 5 个深蹲（量力而行）"
			]
		};

		/** 每一类的可调项：开关、间隔、目标，外加类型自己的参数（每杯容量 / 每次时长）。 */
		function defaultKinds() {
			const out = {};
			for (const def of KIND_DEFS) {
				out[def.id] = { on: def.off !== true, intervalMin: def.intervalMin, target: def.target };
			}
			out.water.glassMl = 250;
			out.stand.minutes = 3;
			return out;
		}

		const DEFAULT_SETTINGS = {
			version: 3,
			enabled: true,
			workdays: [1, 2, 3, 4, 5, 6],
			dayStart: "10:00",
			dayEnd: "19:00",
			lunchEnabled: true,
			lunchStart: "12:00",
			lunchEnd: "13:00",
			kinds: defaultKinds(),
			notify: { system: true, inApp: true, sound: true, volume: 0.7, tone: "ding", muteFullscreen: true },
			quiet: { enabled: false, start: "22:00", end: "08:00" },
		};

		const clone = (value) => JSON.parse(JSON.stringify(value));
		const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
		//#endregion

		//#region 基础工具
		const pad2 = (n) => String(n).padStart(2, "0");
		/** 本地日期键 YYYY-MM-DD（统计按本地日历天切分）。 */
		const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
		/** ISO 星期：1=周一 … 7=周日。 */
		const isoDay = (d) => ((d.getDay() + 6) % 7) + 1;
		/** 分钟数 → "HH:MM"。 */
		const hm = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
		/** "HH:MM" → 当天分钟数；非法返回 null。 */
		function parseHM(text) {
			const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
			if (!m) return null;
			const h = Number(m[1]);
			const mi = Number(m[2]);
			if (h > 23 || mi > 59) return null;
			return h * 60 + mi;
		}
		/** [start, end) 是否包含 mins，支持跨零点（start > end）。 */
		function inWindow(mins, start, end) {
			if (start === end) return false;
			return start < end ? mins >= start && mins < end : mins >= start || mins < end;
		}
		/** 取某天（可带日偏移）的某个 "HH:MM" 时刻。 */
		function atTime(date, hhmm, dayOffset) {
			const mins = parseHM(hhmm) ?? 0;
			return new Date(
				date.getFullYear(),
				date.getMonth(),
				date.getDate() + (dayOffset ?? 0),
				Math.floor(mins / 60),
				mins % 60,
				0,
				0
			).getTime();
		}
		/** 毫秒 → "1 小时 5 分钟" 这类人类可读时长。 */
		function humanDuration(ms) {
			const total = Math.max(0, Math.round(ms / 1000));
			if (total < 60) return `${total} 秒`;
			const mins = Math.round(total / 60);
			if (mins < 60) return `${mins} 分钟`;
			const h = Math.floor(mins / 60);
			const rest = mins % 60;
			return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分钟`;
		}
		/** 取模挑提示语，保证同一天内的文案轮换。 */
		const pick = (list, index) => list[Math.abs(index) % list.length];
		//#endregion

		//#region 设置归一化与允许时段
		/**
		 * 归一化每一类提醒的开关 / 间隔 / 目标 / 类型参数。
		 * 兼容 v2 的旧写法（enabled / water / stand 放在设置顶层）：旧字段照样读得出来。
		 */
		function normalizeKinds(patch) {
			const out = defaultKinds();
			const merge = (kind, source) => {
				if (!source || typeof source !== "object") return;
				const def = kindDef(kind);
				if (typeof source.on === "boolean") out[kind].on = source.on;
				if (typeof source.enabled === "boolean") out[kind].on = source.enabled;
				if (source.intervalMin !== undefined) out[kind].intervalMin = clamp(Number(source.intervalMin) || def.intervalMin, 5, 240);
				if (source.target !== undefined) out[kind].target = clamp(Math.round(Number(source.target) || def.target), def.minTarget, def.maxTarget);
				if (source.glassMl !== undefined) out[kind].glassMl = clamp(Number(source.glassMl) || 250, 100, 800);
				if (source.minutes !== undefined) out[kind].minutes = clamp(Number(source.minutes) || 3, 1, 30);
			};
			const fromKinds = patch?.kinds && typeof patch.kinds === "object" ? patch.kinds : null;
			for (const def of KIND_DEFS) merge(def.id, fromKinds ? fromKinds[def.id] : undefined);
			merge("water", patch?.water);
			merge("stand", patch?.stand);
			return out;
		}

		/** 某一类的当前配置（缺字段时用默认值补齐）。 */
		function kindCfg(settings, kind) {
			const def = kindDef(kind);
			const base = DEFAULT_SETTINGS.kinds[def.id] ?? { on: false, intervalMin: def.intervalMin, target: def.target };
			const stored = settings?.kinds?.[def.id];
			return { ...base, ...(stored && typeof stored === "object" ? stored : {}) };
		}
		/** 这一类是否开启。 */
		function kindEnabled(settings, kind) {
			return kindCfg(settings, kind).on === true;
		}
		/** 这一类的每日目标（至少 1）。 */
		function kindTarget(settings, kind) {
			const def = kindDef(kind);
			return clamp(Math.round(Number(kindCfg(settings, kind).target) || def.target), def.minTarget, def.maxTarget);
		}
		/** 当前开启的全部类型（按类型表顺序）。 */
		function activeKinds(settings) {
			return KIND_IDS.filter((kind) => kindEnabled(settings, kind));
		}

		/** 用默认值补全并裁剪一份用户设置（存盘和读盘都走这里，避免脏数据）。 */
		function normalizeSettings(patch) {
			const out = clone(DEFAULT_SETTINGS);
			if (!patch || typeof patch !== "object") return out;
			if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
			if (Array.isArray(patch.workdays)) {
				const days = [...new Set(patch.workdays.map(Number).filter((n) => n >= 1 && n <= 7))].sort((a, b) => a - b);
				if (days.length > 0) out.workdays = days;
			}
			for (const key of ["dayStart", "dayEnd", "lunchStart", "lunchEnd"]) {
				if (parseHM(patch[key]) !== null) out[key] = patch[key];
			}
			if (typeof patch.lunchEnabled === "boolean") out.lunchEnabled = patch.lunchEnabled;
			out.kinds = normalizeKinds(patch);
			if (patch.notify && typeof patch.notify === "object") Object.assign(out.notify, patch.notify);
			if (patch.quiet && typeof patch.quiet === "object") Object.assign(out.quiet, patch.quiet);
			out.notify = {
				system: out.notify.system !== false,
				inApp: out.notify.inApp !== false,
				sound: out.notify.sound !== false,
				volume: Number.isFinite(Number(out.notify.volume)) ? clamp(Number(out.notify.volume), 0.05, 1) : 0.7,
				tone: TONE_IDS.includes(out.notify.tone) ? out.notify.tone : "ding",
				muteFullscreen: out.notify.muteFullscreen !== false
			};
			if (parseHM(out.quiet.start) === null) out.quiet.start = "22:00";
			if (parseHM(out.quiet.end) === null) out.quiet.end = "08:00";
			out.quiet.enabled = out.quiet.enabled === true;
			return out;
		}

		/** 该时刻是否落在作息里（上班日 + 上下班窗口内 + 不在午休/免打扰；不看总开关）。 */
		function inSchedule(settings, ms) {
			const d = new Date(ms);
			if (!settings.workdays.includes(isoDay(d))) return false;
			const mins = d.getHours() * 60 + d.getMinutes();
			const start = parseHM(settings.dayStart) ?? 600;
			const end = parseHM(settings.dayEnd) ?? 1140;
			if (!inWindow(mins, start, end)) return false;
			if (settings.lunchEnabled && inWindow(mins, parseHM(settings.lunchStart) ?? 720, parseHM(settings.lunchEnd) ?? 780)) return false;
			if (settings.quiet.enabled && inWindow(mins, parseHM(settings.quiet.start) ?? 1320, parseHM(settings.quiet.end) ?? 480)) return false;
			return true;
		}

		/** 该时刻是否允许提醒（总开关开启 + 落在作息里）。 */
		function isAllowed(settings, ms) {
			return settings.enabled === true && inSchedule(settings, ms);
		}

		/** 从 ms 起（含）第一个允许提醒的时刻。 */
		function nextAllowedAt(settings, ms) {
			let t = ms;
			for (let i = 0; i < 40; i += 1) {
				const d = new Date(t);
				if (!settings.workdays.includes(isoDay(d))) {
					t = atTime(d, settings.dayStart, 1);
					continue;
				}
				const mins = d.getHours() * 60 + d.getMinutes();
				const start = parseHM(settings.dayStart) ?? 600;
				const end = parseHM(settings.dayEnd) ?? 1140;
				if (mins < start) {
					t = atTime(d, settings.dayStart, 0);
					continue;
				}
				if (mins >= end) {
					t = atTime(d, settings.dayStart, 1);
					continue;
				}
				if (settings.lunchEnabled && inWindow(mins, parseHM(settings.lunchStart) ?? 720, parseHM(settings.lunchEnd) ?? 780)) {
					t = atTime(d, settings.lunchEnd, 0);
					continue;
				}
				if (settings.quiet.enabled) {
					const qs = parseHM(settings.quiet.start) ?? 1320;
					const qe = parseHM(settings.quiet.end) ?? 480;
					if (inWindow(mins, qs, qe)) {
						t = mins < qe && qs > qe ? atTime(d, settings.quiet.end, 0) : atTime(d, settings.dayStart, 1);
						continue;
					}
				}
				const snapped = new Date(d);
				snapped.setSeconds(0, 0);
				return snapped.getTime();
			}
			return t;
		}

		/** 一天里可用于提醒的分钟数。 */
		function windowMinutes(settings) {
			const start = parseHM(settings.dayStart) ?? 600;
			const end = parseHM(settings.dayEnd) ?? 1140;
			let span = end - start;
			if (span <= 0) span += 1440;
			if (settings.lunchEnabled) {
				const ls = parseHM(settings.lunchStart) ?? 720;
				const le = parseHM(settings.lunchEnd) ?? 780;
				let lunch = le - ls;
				if (lunch <= 0) lunch += 1440;
				span -= lunch;
			}
			return Math.max(0, span);
		}

		/** 这套设置的容量估计：每一类能提醒几次。 */
		function estimate(settings) {
			const available = windowMinutes(settings);
			const max = {};
			for (const def of KIND_DEFS) max[def.id] = Math.floor(available / Math.max(5, kindInterval(settings, def.id)));
			return { available, max, waterMax: max.water, standMax: max.stand, days: settings.workdays.length };
		}
		//#endregion

		//#region 本地 store
		/**
		 * 运行期状态。
		 * - fired：每一类「已经处理过的最后一个提醒点」，固定时刻表靠它避免重复提醒；
		 * - snooze：显式推迟到的时刻（只有「10 分钟后再提醒」「今天不再」会写它）；
		 * - pending：当前等待回应的提醒（演练项只停留在内存里，不落盘）。
		 */
		function freshRuntime(now) {
			const fired = {};
			const snooze = {};
			for (const kind of KIND_IDS) {
				fired[kind] = 0;
				snooze[kind] = null;
			}
			return { fired, snooze, pending: [], lastDay: dayKey(new Date(now)) };
		}

		/**
		 * 兼容旧版本状态：旧版存的是「下次提醒时刻」（waterNextAt / standNextAt），
		 * 这里把它当成「已经处理到那个点之前」，避免升级后立刻补发一次提醒。
		 */
		function migrateRuntime(runtime) {
			const next = runtime && typeof runtime === "object" ? runtime : {};
			if (next.fired === undefined || next.fired === null || typeof next.fired !== "object") {
				next.fired = {};
				for (const kind of ["water", "stand"]) {
					const legacy = next[kind + "NextAt"];
					if (typeof legacy === "number") next.fired[kind] = legacy;
					delete next[kind + "NextAt"];
				}
			}
			if (next.snooze === undefined || next.snooze === null || typeof next.snooze !== "object") next.snooze = {};
			// 新增提醒类型后，老状态里没有对应键，这里补齐（不补会读到 undefined）。
			for (const kind of KIND_IDS) {
				if (typeof next.fired[kind] !== "number") next.fired[kind] = 0;
				if (next.snooze[kind] !== null && typeof next.snooze[kind] !== "number") next.snooze[kind] = null;
			}
			if (!Array.isArray(next.pending)) next.pending = [];
			return next;
		}

		function defaultState() {
			return {
				version: 1,
				settings: clone(DEFAULT_SETTINGS),
				records: {},
				runtime: freshRuntime(Date.now()),
				plans: [],
				activePlanId: null
			};
		}

		function loadState() {
			try {
				if (typeof localStorage === "undefined") return defaultState();
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) return defaultState();
				const parsed = JSON.parse(raw);
				const base = defaultState();
				const state = {
					version: 1,
					settings: normalizeSettings(parsed.settings),
					records: parsed.records && typeof parsed.records === "object" ? parsed.records : {},
					runtime: (() => {
						const runtime = migrateRuntime({
							...base.runtime,
							...(parsed.runtime && typeof parsed.runtime === "object" ? parsed.runtime : {})
						});
						runtime.pending = runtime.pending.filter((item) => item?.test !== true);
						return runtime;
					})(),
					plans: normalizePlans(parsed.plans),
					activePlanId: typeof parsed.activePlanId === "string" ? parsed.activePlanId : null
				};
				// 升级上来的老状态没有 plans 字段：拿当前设置兜一份「默认方案」，别让方案页空着。
				return parsed.plans === undefined ? seedPlan(state) : state;
			} catch (error) {
				console.warn("[health-reminder] 读取本地状态失败，已回退默认值:", error);
				return defaultState();
			}
		}

		/**
		 * 落盘。演练（「试一下提醒」）留下的待办只存在于内存里：绝不写进本地状态，
		 * 否则重启后再点「喝了」就会被计成真实的一次。
		 */
		function saveState(state) {
			try {
				if (typeof localStorage === "undefined") return;
				const runtime = state.runtime ?? {};
				const pending = Array.isArray(runtime.pending) ? runtime.pending.filter((item) => item?.test !== true) : [];
				localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, runtime: { ...runtime, pending } }));
			} catch (error) {
				console.warn("[health-reminder] 保存本地状态失败:", error);
			}
		}

		const store = {
			state: null,
			listeners: new Set(),
			get() {
				if (this.state === null) this.state = loadState();
				return this.state;
			},
			set(next) {
				this.state = typeof next === "function" ? next(this.state ?? this.get()) : next;
				saveState(this.state);
				for (const listener of [...this.listeners]) {
					try {
						listener();
					} catch (error) {
						console.warn("[health-reminder] 订阅者出错:", error);
					}
				}
			},
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
		};
		//#endregion

		//#region 调度器
		/** 某一类的提醒间隔（分钟，至少 5）。 */
		function kindInterval(settings, kind) {
			return Math.max(5, Math.round(Number(kindCfg(settings, kind).intervalMin) || 5));
		}

		/**
		 * 一天的固定时刻表：从「上班时间」起按间隔整点排队（第一个点在上班时间 + 1 个间隔）。
		 * 落在午休、免打扰、非上班日上的点直接丢弃，不补。
		 *
		 * 这是本插件的核心约定：提醒时刻只由「起始时间 + N × 间隔」决定，
		 * 暂停 / 恢复 / 完成 / 跳过 / 记录都不会把它往后推。
		 */
		function daySlots(settings, kind, dayOffset, now) {
			if (!kindEnabled(settings, kind)) return [];
			const interval = kindInterval(settings, kind) * 60000;
			const anchor = new Date(typeof now === "number" ? now : Date.now());
			const end = atTime(anchor, settings.dayEnd, dayOffset);
			const slots = [];
			for (let t = atTime(anchor, settings.dayStart, dayOffset) + interval; t <= end; t += interval) {
				if (inSchedule(settings, t)) slots.push(t);
			}
			return slots;
		}

		/** 严格按时刻表：now 之后的第一个提醒点（最多往后找一周）。 */
		function nextSlotAt(settings, kind, now) {
			for (let offset = 0; offset <= 7; offset += 1) {
				for (const t of daySlots(settings, kind, offset, now)) {
					if (t > now) return t;
				}
			}
			return null;
		}

		/** 严格按时刻表：不晚于 now 的最后一个提醒点。 */
		function lastSlotAt(settings, kind, now) {
			for (let offset = 0; offset >= -7; offset -= 1) {
				const slots = daySlots(settings, kind, offset, now);
				for (let i = slots.length - 1; i >= 0; i -= 1) {
					if (slots[i] <= now) return slots[i];
				}
			}
			return null;
		}

		/** 下次提醒时刻：显式推迟优先，否则严格取时刻表上的下一个点（派生值，不落盘）。 */
		function nextAtFor(state, kind, now) {
			const snooze = state?.runtime?.snooze?.[kind];
			if (typeof snooze === "number" && snooze > now) return snooze;
			return nextSlotAt(state.settings, kind, now);
		}

		/** 补齐运行期状态的缺失字段（旧版本的数字在这里被迁移）。 */
		function ensureRuntime(state, now) {
			const runtime = migrateRuntime(state.runtime ?? freshRuntime(now));
			state.runtime = runtime;
			return runtime;
		}

		/**
		 * 到点判定：只认固定时刻表上的点。
		 * - 点已经过去超过 LATE_MS 才被发现（应用关了太久）→ 记为已处理，不补发；
		 * - 已处理过的点（fired）不会重复提醒；
		 * - 明确推迟（snooze）期间只看推迟时刻，不看网格。
		 */
		function computeDue(state, now) {
			const settings = state.settings;
			const base = ensureRuntime(state, now);
			const runtime = { ...base, fired: { ...base.fired }, snooze: { ...base.snooze }, pending: base.pending.slice() };
			const due = [];
			for (const kind of KIND_IDS) {
				if (!kindEnabled(settings, kind)) continue;
				const snooze = runtime.snooze[kind];
				if (typeof snooze === "number") {
					if (snooze > now) continue;
					runtime.snooze[kind] = null;
					runtime.fired[kind] = Math.max(runtime.fired[kind] ?? 0, snooze);
					due.push(kind);
					continue;
				}
				const slot = lastSlotAt(settings, kind, now);
				if (slot === null || slot <= (runtime.fired[kind] ?? 0)) continue;
				runtime.fired[kind] = slot;
				if (now - slot <= LATE_MS) due.push(kind);
			}
			for (const kind of due) {
				if (settings.notify.inApp && !runtime.pending.some((item) => item.kind === kind)) {
					runtime.pending.push({ kind, at: now, id: `${kind}-${now}` });
				}
			}
			return { runtime, due };
		}

		/** 提醒文案：标题 + 内容 + 详情（由类型表驱动，新增类型不用改这里）。 */
		function reminderCopy(kind, now) {
			const state = store.get();
			const settings = state.settings;
			const def = kindDef(kind);
			const config = kindCfg(settings, kind);
			const record = recordOn(state, dayKey(new Date(now)));
			const done = recordCount(record, kind);
			const seq = done + (record.skips ?? 0);
			const detail = [`今天已完成 ${done}/${kindTarget(settings, kind)} ${def.unit}`];
			if (def.extra === "glassMl" && config.glassMl) detail.push(`一杯约 ${config.glassMl} ml`);
			if (def.extra === "minutes" && config.minutes) detail.push(`每次活动 ${config.minutes} 分钟`);
			return { kind, title: `${def.title} ${def.icon}`, body: pick(TIPS[def.id] ?? TIPS.water, seq), detail: detail.join(" · ") };
		}

		/**
		 * 发一条系统通知；返回一句状态给调用处（"sent" / "unsupported" / "denied" / "error"），
		 * 好让「测试系统通知」能在界面上说清楚为什么没反应。
		 */
		function notifySystem(kind, now) {
			try {
				if (typeof Notification === "undefined" || typeof Notification !== "function") return "unsupported";
				if (Notification.permission !== "granted") return "denied";
				const copy = reminderCopy(kind, now);
				const note = new Notification(copy.title, {
					body: `${copy.body}\n${copy.detail}`,
					tag: `dsh-health-reminder-${kind}`,
					requireInteraction: true,
					silent: !store.get().settings.notify.sound
				});
				note.onclick = () => {
					try {
						// 点通知：先把窗口拉到前台，再打开插件（面板 + 底部快捷卡片）。
						if (typeof window !== "undefined" && typeof window.focus === "function") window.focus();
						selectPanel();
						setDockOpen(true);
						note.close();
					} catch (error) {
						console.warn("[health-reminder] 通知点击处理失败:", error);
					}
				};
				return "sent";
			} catch (error) {
				console.warn("[health-reminder] 系统通知失败:", error);
				return "error";
			}
		}

		let audioCtx = null;
		/** 全屏（演示 / 看视频）时按设置静音：只影响声音，应用内提示卡与统计照常。 */
		function isFullscreenActive() {
			try {
				const doc = typeof document !== "undefined" ? document : null;
				if (!doc) return false;
				return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null);
			} catch {
				return false;
			}
		}
		/** 用 WebAudio 现场合成提示音，插件不带任何音频资源；音色与音量来自设置。 */
		function playBeep(kind, options) {
			try {
				const Ctor = typeof AudioContext !== "undefined" ? AudioContext : typeof webkitAudioContext !== "undefined" ? webkitAudioContext : null;
				if (Ctor === null) return;
				const notify = store.get().settings.notify;
				const tone = TONES[options?.tone ?? notify.tone] ?? TONES.ding;
				const volume = clamp(Number(options?.volume ?? notify.volume ?? 0.7), 0.05, 1);
				audioCtx = audioCtx ?? new Ctor();
				if (audioCtx.state === "suspended") audioCtx.resume();
				const start = audioCtx.currentTime;
				const freqs = kindDef(kind).beep ?? [880, 1174];
				freqs.forEach((freq, index) => {
					const osc = audioCtx.createOscillator();
					const gain = audioCtx.createGain();
					osc.type = tone.wave;
					osc.frequency.value = freq;
					const t0 = start + index * tone.gap;
					const peak = Math.max(0.0002, tone.gain * volume);
					gain.gain.setValueAtTime(0.0001, t0);
					gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
					gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur * 0.9);
					osc.connect(gain);
					gain.connect(audioCtx.destination);
					osc.start(t0);
					osc.stop(t0 + tone.dur);
				});
			} catch (error) {
				console.warn("[health-reminder] 提示音播放失败:", error);
			}
		}

		/** 到点后的可见/可听提示（面板内的卡片由 runtime.pending 驱动）。 */
		function announce(kind, now) {
			const settings = store.get().settings;
			const muted = settings.notify.muteFullscreen === true && isFullscreenActive();
			if (settings.notify.sound && !muted) playBeep(kind);
			if (settings.notify.system) notifySystem(kind, now);
		}

		/** 运行期状态里有没有值得落盘的变化（按类型逐项比较，新增类型自动纳入）。 */
		function runtimeDiffers(next, before) {
			if (!before) return true;
			if ((next?.pending?.length ?? 0) !== (before.pending?.length ?? 0)) return true;
			for (const kind of KIND_IDS) {
				if (next?.fired?.[kind] !== before.fired?.[kind]) return true;
				if (next?.snooze?.[kind] !== before.snooze?.[kind]) return true;
			}
			return false;
		}

		/** 每秒的心跳：按固定时刻表判断是否到点。 */
		function tick(now) {
			const state = store.get();
			const runtime = ensureRuntime(state, now);
			if (!state.settings.enabled) {
				// 暂停期间不堆欠账：把已经过去的提醒点记为已处理，恢复后从时刻表继续，既不重置也不补发。
				let dirty = false;
				for (const kind of KIND_IDS) {
					const slot = lastSlotAt(state.settings, kind, now);
					if (slot !== null && slot > (runtime.fired[kind] ?? 0)) {
						runtime.fired[kind] = slot;
						dirty = true;
					}
					if (runtime.snooze[kind] !== null) {
						runtime.snooze[kind] = null;
						dirty = true;
					}
				}
				if (runtime.pending.length > 0) {
					runtime.pending = [];
					dirty = true;
				}
				if (dirty) store.set({ ...state, runtime });
				return;
			}
			const before = state.runtime;
			const { runtime: next, due } = computeDue(state, now);
			const changed = runtimeDiffers(next, before);
			if (changed) store.set({ ...state, runtime: next });
			for (const kind of due) announce(kind, now);
		}

		function ensureRuntimeNow(now) {
			const state = store.get();
			store.set({ ...state, runtime: ensureRuntime(state, now) });
		}

		/**
		 * 演练一次提醒：只生成一条「测试」待办，用来验证面板卡片、系统通知和提示音。
		 * 测试项不写记录、不动时刻表，也不会被存进本地状态。
		 */
		function fireNow(kind, now) {
			const state = store.get();
			const base = ensureRuntime(state, now);
			const runtime = { ...base, pending: dropPending(base, kind) };
			runtime.pending = [...runtime.pending, { kind, at: now, id: `${kind}-${now}-test`, test: true }];
			store.set({ ...state, runtime });
			announce(kind, now);
		}

		function withRecord(state, now, mutate) {
			const key = dayKey(new Date(now));
			const records = { ...state.records };
			const record = { skips: 0, skipBy: {}, log: [], ...(records[key] ?? {}) };
			mutate(record);
			record.log = (record.log ?? []).slice(-200);
			records[key] = record;
			return records;
		}

		function dropPending(runtime, kind) {
			return (runtime.pending ?? []).filter((item) => item.kind !== kind);
		}

		/**
		 * 完成一次：计入当天的真实记录，并收起这条待办。
		 * 时刻表不受影响 —— 下一次提醒仍然是「起始时间 + N × 间隔」上的那个点。
		 *
		 * @param opts.test 演练（「试一下提醒」）留下的待办：只收起，绝不写进记录与统计。
		 */
		function completeKind(kind, now, opts) {
			const state = store.get();
			const runtime = ensureRuntime(state, now);
			runtime.pending = dropPending(runtime, kind);
			const test = opts?.test === true;
			if (test) {
				store.set({ ...state, runtime });
				return;
			}
			const records = withRecord(state, now, (record) => {
				record[kind] = recordCount(record, kind) + 1;
				record.log = [...(record.log ?? []), { t: now, kind, action: "done" }];
			});
			store.set({ ...state, records, runtime });
		}

		/** 跳过这一次：计入跳过次数；时刻表不变。 */
		function skipKind(kind, now, opts) {
			const state = store.get();
			const runtime = ensureRuntime(state, now);
			runtime.pending = dropPending(runtime, kind);
			if (opts?.test === true) {
				store.set({ ...state, runtime });
				return;
			}
			const records = withRecord(state, now, (record) => {
				record.skips = (record.skips ?? 0) + 1;
				record.skipBy = { ...(record.skipBy ?? {}) };
				record.skipBy[kind] = (record.skipBy[kind] ?? 0) + 1;
				record.log = [...(record.log ?? []), { t: now, kind, action: "skip" }];
			});
			store.set({ ...state, records, runtime });
		}

		/** 推迟：默认 10 分钟后再提醒。只覆盖下一次，之后回到固定时刻表。 */
		function snoozeKind(kind, now, minutes, opts) {
			const state = store.get();
			const runtime = ensureRuntime(state, now);
			runtime.pending = dropPending(runtime, kind);
			runtime.snooze[kind] = opts?.test === true ? null : now + clamp(minutes ?? 10, 1, 120) * 60000;
			store.set({ ...state, runtime });
		}

		/** 今天不再提醒这一类：把推迟时刻设成下一个有提醒的上班日的第一个点。 */
		function muteKindToday(kind, now, opts) {
			const state = store.get();
			const runtime = ensureRuntime(state, now);
			runtime.pending = dropPending(runtime, kind);
			if (opts?.test !== true) {
				let first = null;
				for (let offset = 1; offset <= 8 && first === null; offset += 1) {
					first = daySlots(state.settings, kind, offset, now)[0] ?? null;
				}
				runtime.snooze[kind] = first ?? atTime(new Date(now), state.settings.dayStart, 1) + 60000;
			}
			store.set({ ...state, runtime });
		}
		//#endregion

		//#region 统计
		const emptyRecord = () => ({ skips: 0, skipBy: {}, log: [] });
		function recordOn(state, key) {
			return state.records[key] ?? emptyRecord();
		}
		/** 某一天某一类完成了多少次。 */
		function recordCount(record, kind) {
			return Math.max(0, Math.round(Number(record?.[kind]) || 0));
		}
		/** 达标 = 当天所有开启的类型都达到各自目标。 */
		function isDayMet(state, key) {
			const record = recordOn(state, key);
			const kinds = activeKinds(state.settings);
			if (kinds.length === 0) return false;
			return kinds.every((kind) => recordCount(record, kind) >= kindTarget(state.settings, kind));
		}
		/** 连续达标天数（今天还没达标不打断，非上班日跳过）。 */
		function streakOf(state, now) {
			let count = 0;
			const cursor = new Date(now);
			for (let i = 0; i < 400; i += 1) {
				const workday = state.settings.workdays.includes(isoDay(cursor));
				if (workday) {
					if (isDayMet(state, dayKey(cursor))) count += 1;
					else if (i > 0) break;
				}
				cursor.setDate(cursor.getDate() - 1);
				cursor.setHours(12, 0, 0, 0);
			}
			return count;
		}
		/** 最近 7 天（含今天）的统计，用于柱状图。 */
		function lastDays(state, now, days) {
			const out = [];
			const cursor = new Date(now);
			for (let i = 0; i < (days ?? 7); i += 1) {
				const key = dayKey(cursor);
				const record = recordOn(state, key);
				const counts = {};
				for (const kind of KIND_IDS) counts[kind] = recordCount(record, kind);
				out.unshift({
					key,
					label: WEEKDAY_LABELS[isoDay(cursor)],
					counts,
					...counts,
					skips: record.skips ?? 0,
					met: isDayMet(state, key),
					workday: state.settings.workdays.includes(isoDay(cursor)),
					today: i === 0
				});
				cursor.setDate(cursor.getDate() - 1);
				cursor.setHours(12, 0, 0, 0);
			}
			return out;
		}

		/**
		 * 近 N 天的报告（N 只取 7 / 30）：总量、达标天数、最长连续、每类累计。
		 * 非上班日不计入「达标天数」与最长连续，但仍统计完成量。
		 */
		function reportOf(state, days, now) {
			const span = days === 30 ? 30 : 7;
			const list = lastDays(state, now, span);
			const settings = state.settings;
			const kinds = activeKinds(settings);
			const totals = {};
			for (const kind of KIND_IDS) totals[kind] = 0;
			let skips = 0;
			for (const day of list) {
				for (const kind of KIND_IDS) totals[kind] += day.counts?.[kind] ?? 0;
				skips += day.skips ?? 0;
			}
			let best = 0;
			let run = 0;
			for (const day of list) {
				if (!day.workday) continue;
				if (day.met) {
					run += 1;
					best = Math.max(best, run);
				} else if (!day.today) {
					run = 0;
				}
			}
			return {
				span,
				days: list,
				kinds,
				rows: kinds.map((kind) => ({
					kind,
					label: kindDef(kind).label,
					icon: kindDef(kind).icon,
					color: kindColor(kind),
					unit: kindDef(kind).unit,
					total: totals[kind] ?? 0,
					target: kindTarget(settings, kind)
				})),
				totals,
				skips,
				metDays: list.filter((day) => day.workday && day.met).length,
				workdays: list.filter((day) => day.workday).length,
				best,
				streak: streakOf(state, now),
				waterMl: (totals.water ?? 0) * (kindCfg(settings, "water").glassMl ?? 250),
				standMinutes: (totals.stand ?? 0) * (kindCfg(settings, "stand").minutes ?? 3)
			};
		}

		//#endregion

		//#region 导出与导入（本地同步 v1）
		/**
		 * 导出格式带 schema / version，方便以后接别的存储（网盘、WebDAV）。
		 * 「账号同步」这件事 DSH 没有现成能力，所以本轮同步 = 手动导出/导入。
		 */
		const EXPORT_SCHEMA = "dsh-health-reminder/export";
		const EXPORT_VERSION = 1;

		/** 打包导出内容（纯函数）。sinceDayKey 之前的日子不导出；includeSettings 默认 true。 */
		function buildExport(state, options) {
			const opts = options ?? {};
			const keys = Object.keys(state.records ?? {}).sort();
			const keep = typeof opts.sinceDayKey === "string" ? keys.filter((key) => key >= opts.sinceDayKey) : keys;
			const records = {};
			for (const key of keep) records[key] = clone(state.records[key]);
			const payload = {
				schema: EXPORT_SCHEMA,
				version: EXPORT_VERSION,
				app: "dsh-health-reminder",
				exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
				records
			};
			if (opts.includeSettings !== false) payload.settings = clone(state.settings);
			if (opts.includeRuntime === true) payload.runtime = clone(state.runtime);
			return payload;
		}

		/** 解析并校验一份导出文本；坏数据在这里挡住，不污染本地状态。 */
		function parseImport(text) {
			let data = null;
			try {
				data = JSON.parse(String(text ?? ""));
			} catch (error) {
				return { ok: false, error: "不是合法的 JSON 文本" };
			}
			if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "内容不是导出文件" };
			if (data.schema !== EXPORT_SCHEMA) return { ok: false, error: `不是本插件的导出文件（schema=${String(data.schema)}）` };
			if (Number(data.version) > EXPORT_VERSION) return { ok: false, error: "导出文件来自更新的插件版本，请先升级插件" };
			const source = data.records && typeof data.records === "object" && !Array.isArray(data.records) ? data.records : {};
			const records = {};
			for (const key of Object.keys(source)) {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
				const record = source[key];
				if (!record || typeof record !== "object") continue;
				const clean = {
					skips: Math.max(0, Math.round(Number(record.skips) || 0)),
					skipBy: record.skipBy && typeof record.skipBy === "object" ? { ...record.skipBy } : {},
					log: Array.isArray(record.log)
						? record.log.filter((entry) => entry && typeof entry === "object").map((entry) => ({ ...entry }))
						: []
				};
				for (const kind of KIND_IDS) clean[kind] = recordCount(record, kind);
				records[key] = clean;
			}
			if (Object.keys(records).length === 0 && !data.settings) return { ok: false, error: "导出文件里没有任何记录或设置" };
			const payload = {
				schema: EXPORT_SCHEMA,
				version: Number(data.version) || 1,
				exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : null,
				settings: data.settings && typeof data.settings === "object" ? data.settings : null,
				records
			};
			return { ok: true, payload, summary: importSummary(records, payload.settings) };
		}

		/** 导入内容的摘要（多少天、多少次完成、多少条日志、有没有设置）。 */
		function importSummary(records, settings) {
			let done = 0;
			let logs = 0;
			for (const record of Object.values(records ?? {})) {
				for (const kind of KIND_IDS) done += recordCount(record, kind);
				logs += Array.isArray(record?.log) ? record.log.length : 0;
			}
			return { days: Object.keys(records ?? {}).length, done, logs, hasSettings: !!settings };
		}

		/**
		 * 合并导入内容（纯函数）：同一天取「较大值」，日志按 `时刻|类型|动作` 去重后并集。
		 * 设置默认不动，只有 applySettings === true 才用文件里的覆盖。
		 */
		function mergeImport(state, payload, options) {
			const opts = options ?? {};
			const records = { ...(state.records ?? {}) };
			let added = 0;
			let merged = 0;
			for (const key of Object.keys(payload?.records ?? {})) {
				const incoming = payload.records[key];
				const current = records[key];
				if (!current) {
					records[key] = clone(incoming);
					added += 1;
					continue;
				}
				const next = { ...current };
				for (const kind of KIND_IDS) next[kind] = Math.max(recordCount(current, kind), recordCount(incoming, kind));
				next.skips = Math.max(Number(current.skips) || 0, Number(incoming.skips) || 0);
				next.skipBy = { ...(current.skipBy ?? {}) };
				for (const [kind, count] of Object.entries(incoming.skipBy ?? {})) {
					next.skipBy[kind] = Math.max(Number(next.skipBy[kind]) || 0, Number(count) || 0);
				}
				const seen = new Set((current.log ?? []).map((entry) => `${entry.t}|${entry.kind}|${entry.action}`));
				const log = [...(current.log ?? [])];
				for (const entry of incoming.log ?? []) {
					const id = `${entry.t}|${entry.kind}|${entry.action}`;
					if (seen.has(id)) continue;
					seen.add(id);
					log.push(entry);
				}
				log.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
				next.log = log;
				records[key] = next;
				merged += 1;
			}
			const nextState = { ...state, records };
			let settingsChanged = false;
			if (opts.applySettings === true && payload?.settings) {
				nextState.settings = normalizeSettings(payload.settings);
				settingsChanged = true;
			}
			if (opts.now) nextState.lastImportAt = opts.now;
			return { state: nextState, summary: { ...importSummary(payload?.records ?? {}, payload?.settings), added, merged, settingsChanged } };
		}

		/** 导出 CSV（纯函数）：一行一天，列为每个类型的完成数 + 跳过 + 达标。 */
		function csvOf(state, days, now) {
			const list = lastDays(state, now, days === 30 ? 30 : 7);
			const kinds = activeKinds(state.settings);
			const lines = [["日期", "星期", ...kinds.map((kind) => `${kindDef(kind).label}(${kindDef(kind).unit})`), "跳过", "达标"].join(",")];
			for (const day of list) {
				const cells = [day.key, day.label, ...kinds.map((kind) => day.counts?.[kind] ?? 0), day.skips ?? 0];
				cells.push(day.workday ? (day.met ? "是" : "否") : "非上班日");
				lines.push(cells.join(","));
			}
			return `\uFEFF${lines.join("\r\n")}\r\n`;
		}

		/** 文件名里带日期，导出多次不会互相覆盖。 */
		function stampFilename(prefix, ext, now) {
			const d = new Date(now ?? Date.now());
			return `${prefix}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.${ext}`;
		}

		/** 触发下载；没有 DOM（自测环境）时返回 false，由调用方降级。 */
		function downloadText(filename, text, mime) {
			try {
				if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
				const url = URL.createObjectURL(new Blob([text], { type: mime ?? "application/json;charset=utf-8" }));
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = filename;
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				return true;
			} catch (error) {
				console.warn("[health-reminder] 导出下载失败:", error);
				return false;
			}
		}

		/** 复制到剪贴板（下载不可用时的兜底）；失败返回 false。 */
		function copyText(text) {
			try {
				const nav = typeof navigator === "undefined" ? null : navigator;
				if (nav?.clipboard?.writeText) return nav.clipboard.writeText(text).then(() => true).catch(() => false);
			} catch (error) {
				// 剪贴板权限被拒时按失败处理
			}
			return Promise.resolve(false);
		}
		//#endregion

		//#region 方案管理（本机多套配置，随时切换）
		/**
		 * 一份方案 = 一份完整的提醒配置快照（作息 + 每类提醒的间隔/目标/开关 + 提醒方式）。
		 * 快照就存在本地状态里；切换方案只是把这套值写回设置，随后按新时刻表重新计时。
		 * 统计记录不归方案管，来回切换不会动它。
		 */
		const PLAN_NAME_MAX = 24;
		const PLAN_DEFAULT_NAME = "默认方案";

		/** 只留配置本身：归一化之后的设置就是快照内容。 */
		function planConfigOf(settings) {
			return clone(normalizeSettings(settings));
		}

		/** 用设置内容当指纹，判断「当前设置是不是已经偏离了这份方案」。 */
		function planKey(settings) {
			return JSON.stringify(planConfigOf(settings));
		}

		/** 方案名：压掉换行、截断，空名字用兜底值。 */
		function planNameOf(name, fallback) {
			const text = String(name ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, PLAN_NAME_MAX);
			return text === "" ? fallback : text;
		}

		/** 照当前设置起一个一眼能认出来的名字。 */
		function defaultPlanName(settings) {
			const s = normalizeSettings(settings);
			const days =
				s.workdays.length === 7 ? "每天" : s.workdays.length === 6 ? "周一~周六" : s.workdays.length === 5 ? "周一~周五" : `${s.workdays.length} 天/周`;
			return `${days} ${s.dayStart}-${s.dayEnd} · ${activeKinds(s).length} 类`;
		}

		/** 新方案的 id：同一毫秒里连点两次也不会撞。 */
		function newPlanId() {
			return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		}

		/** 读盘时把方案数组洗干净：缺字段补齐、坏项丢掉、id 去重。 */
		function normalizePlans(raw) {
			if (!Array.isArray(raw)) return [];
			const plans = [];
			const seen = new Set();
			let index = 0;
			for (const item of raw) {
				if (!item || typeof item !== "object" || !item.settings || typeof item.settings !== "object") continue;
				index += 1;
				const id = typeof item.id === "string" && item.id !== "" ? item.id : newPlanId();
				if (seen.has(id)) continue;
				seen.add(id);
				const at = typeof item.createdAt === "number" ? item.createdAt : Date.now();
				plans.push({
					id,
					name: planNameOf(item.name, `方案 ${index}`),
					createdAt: at,
					updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : at,
					settings: planConfigOf(item.settings)
				});
			}
			return plans;
		}

		function planById(state, id) {
			return (state.plans ?? []).find((plan) => plan.id === id) ?? null;
		}

		/** 当前用的是哪一份方案（没选过就是 null）。 */
		function activePlanOf(state) {
			return planById(state, state.activePlanId);
		}

		/** 当前设置和当前方案不一致（改过作息 / 间隔 / 目标 / 提醒方式都算）。 */
		function planDrifted(state) {
			const active = activePlanOf(state);
			if (!active) return false;
			return planKey(state.settings) !== planKey(active.settings);
		}

		/** 老版本（0.4.x 及更早）的状态里没有 plans 字段：拿当前设置兜一份，别让页面空着。 */
		function seedPlan(state) {
			if (Array.isArray(state.plans) && state.plans.length > 0) return state;
			const now = Date.now();
			const plan = { id: newPlanId(), name: PLAN_DEFAULT_NAME, createdAt: now, updatedAt: now, settings: planConfigOf(state.settings) };
			return { ...state, plans: [plan], activePlanId: plan.id };
		}

		/** 方案要点，界面里逐行渲染（按类型表生成，只列开启的类型）。 */
		function planLines(plan) {
			const s = normalizeSettings(plan.settings);
			const est = plan.est ?? estimate(s);
			const days =
				s.workdays.length === 7 ? "每天" : s.workdays.length === 6 ? "周一~周六" : s.workdays.length === 5 ? "周一~周五" : s.workdays.map((d) => WEEKDAY_LABELS[d]).join("、");
			const lunch = s.lunchEnabled ? `（午休 ${s.lunchStart}-${s.lunchEnd} 不提醒）` : "";
			const channels = [s.notify.system ? "系统通知" : null, s.notify.inApp ? "应用内提示" : null, s.notify.sound ? "提示音" : null].filter(Boolean);
			const lines = [`作息：${days} ${s.dayStart}-${s.dayEnd}${lunch}`];
			for (const def of KIND_DEFS) {
				const config = s.kinds[def.id];
				if (!config.on) continue;
				if (def.extra === "glassMl") {
					lines.push(`${def.label}：每 ${config.intervalMin} 分钟提醒一次，目标 ${config.target} ${def.unit}（约 ${config.target * (config.glassMl ?? 250)} ml）`);
				} else if (def.extra === "minutes") {
					lines.push(`${def.label}：每 ${config.intervalMin} 分钟提醒一次，每次活动 ${config.minutes ?? def.minutes} 分钟，目标 ${config.target} ${def.unit}`);
				} else {
					lines.push(`${def.label}：每 ${config.intervalMin} 分钟提醒一次，目标 ${config.target} ${def.unit}`);
				}
			}
			lines.push(`提醒方式：${channels.length > 0 ? channels.join(" + ") : "静默（只记统计）"}`);
			const capacity = activeKinds(s)
				.map((kind) => `约 ${est.max[kind]} 次${kindDef(kind).label}`)
				.join(" / ");
			if (capacity) lines.push(`容量：这段时间内最多${capacity}`);
			return lines;
		}

		/**
		 * 一键套用方案（并立刻重排下一次提醒）。
		 *
		 * 方案里存的是完整设置快照，这里**原样**写回——包括总开关。刻意不强制打开提醒：
		 * 如果这份方案是在关掉提醒时存下的，应用它就该保持关着；否则用户「应用」一下、
		 * 或者编辑当前方案保存一下，关着的提醒会自己跳开。（开/关提醒在设置页和面板都有开关。）
		 */
		function applyPlan(plan) {
			if (!plan || !plan.settings) return;
			const state = store.get();
			const settings = normalizeSettings({ ...plan.settings });
			store.set({ ...state, settings, runtime: freshRuntime(Date.now()) });
			ensureRuntimeNow(Date.now());
		}

		/** 切换方案：写设置 + 重排计时，并记下「当前用的是哪一份」。 */
		function applyPlanById(id) {
			const state = store.get();
			const plan = planById(state, id);
			if (!plan) return false;
			applyPlan(plan);
			store.set({ ...store.get(), activePlanId: plan.id });
			return true;
		}

		/** 新建（照当前设置快照）或就地覆盖某一份方案；返回这份方案的 id。 */
		function savePlan(name, id) {
			const state = store.get();
			const now = Date.now();
			const settings = planConfigOf(state.settings);
			const plans = state.plans ?? [];
			if (id) {
				const target = planById(state, id);
				if (!target) return null;
				store.set({
					...state,
					plans: plans.map((plan) => (plan.id === id ? { ...plan, name: planNameOf(name, plan.name), settings, updatedAt: now } : plan)),
					activePlanId: state.activePlanId ?? id
				});
				return id;
			}
			const plan = { id: newPlanId(), name: planNameOf(name, defaultPlanName(state.settings)), createdAt: now, updatedAt: now, settings };
			store.set({ ...state, plans: [...plans, plan], activePlanId: plan.id });
			return plan.id;
		}

		/** 改个名字（只动名字，配置原样）。 */
		function renamePlan(id, name) {
			const state = store.get();
			const plan = planById(state, id);
			if (!plan) return false;
			store.set({
				...state,
				plans: state.plans.map((item) => (item.id === id ? { ...item, name: planNameOf(name, item.name), updatedAt: Date.now() } : item))
			});
			return true;
		}

		/** 复制一份（新方案不自动切换到前台，免得打断当前设置）。 */
		function duplicatePlan(id) {
			const state = store.get();
			const plan = planById(state, id);
			if (!plan) return null;
			const now = Date.now();
			const copy = {
				...plan,
				id: newPlanId(),
				name: planNameOf(`${plan.name} 副本`, "副本"),
				createdAt: now,
				updatedAt: now,
				settings: planConfigOf(plan.settings)
			};
			store.set({ ...state, plans: [...state.plans, copy] });
			return copy.id;
		}

		/** 删掉一份方案：删的正好是当前方案时，只把「当前」清掉，设置本身不动。 */
		function removePlan(id) {
			const state = store.get();
			if (!planById(state, id)) return false;
			store.set({
				...state,
				plans: state.plans.filter((plan) => plan.id !== id),
				activePlanId: state.activePlanId === id ? null : state.activePlanId
			});
			return true;
		}

		/** 设置改乱了，退回当前方案记下的那一份。 */
		function revertToActivePlan() {
			const state = store.get();
			const active = activePlanOf(state);
			if (!active) return false;
			applyPlan(active);
			store.set({ ...store.get(), activePlanId: active.id });
			return true;
		}
		//#endregion

		//#region 主题 token 与样式
		/** 只用 DSH 主题 token，并在 token 缺失时给一个中性回退（浅色/深色都读得清）。 */
		const T = {
			fg: "var(--dsw-alias-label-primary, #0f1115)",
			fg2: "var(--dsw-alias-label-secondary, #61666b)",
			fg3: "var(--dsw-alias-label-tertiary, #81858c)",
			caption: "var(--dsw-alias-label-caption, #adb2b8)",
			line: "var(--dsw-alias-border-l2, rgba(0,0,0,0.1))",
			lineStrong: "var(--dsw-alias-border-l4, rgba(0,0,0,0.16))",
			card: "var(--dsw-alias-button-elevated-fill, #fff)",
			hover: "var(--dsw-alias-button-floating-hover, #f1f3f5)",
			brand: "var(--dsw-alias-brand-primary, #3b82f6)",
			onBrand: "var(--dsw-alias-label-primary-inverted, #fff)",
			water: "var(--dsw-static-blue-450, #4d93f8)",
			stand: "var(--dsw-static-green-500, #22c55e)",
			eyes: "var(--dsw-static-purple-450, #a855f7)",
			stretch: "var(--dsw-static-teal-500, #14b8a6)",
			warn: "var(--dsw-static-amber-500, #f59e0b)"
		};

		const S = {
			page: { padding: "18px 20px 40px", maxWidth: 880, margin: "0 auto", color: T.fg, fontSize: 13, lineHeight: 1.6, boxSizing: "border-box", colorScheme: "inherit" },
			header: { display: "flex", alignItems: "baseline", gap: 8, margin: 0, flexWrap: "wrap", minWidth: 0 },
			title: { fontSize: 16, fontWeight: 600, color: T.fg, margin: 0, letterSpacing: "0.01em" },
			subtitle: { fontSize: 12, color: T.fg3 },
			tabs: { display: "inline-flex", alignItems: "center", gap: 2, padding: 2, borderRadius: 999, background: T.hover, margin: 0 },
			tab: { border: "none", background: "transparent", color: T.fg2, fontSize: 12.5, padding: "4px 12px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit", lineHeight: "18px" },
			tabActive: { background: T.card, color: T.fg, fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.18)" },
			card: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px", marginBottom: 12, boxSizing: "border-box" },
			// 每一类提醒一张卡：四个类型并排，窄窗口自动掉成两列 / 一列
			kindGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginBottom: 12 },
			cardTitle: { fontSize: 13, fontWeight: 600, color: T.fg, marginBottom: 12, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
			cardNote: { fontSize: 11, fontWeight: 400, color: T.caption },
			rowWrap: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
			hint: { color: T.caption, fontSize: 12, lineHeight: 1.6 },
			input: { background: "transparent", color: T.fg, border: `1px solid ${T.lineStrong}`, borderRadius: 8, padding: "4px 6px", fontSize: 13, width: 66, boxSizing: "border-box" },
			timeInput: { background: "transparent", color: T.fg, border: `1px solid ${T.lineStrong}`, borderRadius: 8, padding: "4px 6px", fontSize: 13, width: 96 },
			chip: { border: `1px solid ${T.line}`, background: "transparent", color: T.fg2, borderRadius: 999, padding: "3px 10px", fontSize: 12, cursor: "pointer" },
			chipOn: { border: `1px solid ${T.brand}`, background: T.hover, color: T.fg, borderRadius: 999, padding: "3px 10px", fontSize: 12, cursor: "pointer" },
			btnPrimary: { border: "none", background: T.brand, color: T.onBrand, borderRadius: 8, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			btnSmall: { border: `1px solid ${T.line}`, background: "transparent", color: T.fg2, borderRadius: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
			btnSoft: { border: `1px solid ${T.line}`, background: T.hover, color: T.fg, borderRadius: 8, padding: "5px 12px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			btnGhost: { border: "none", background: "transparent", color: T.fg2, borderRadius: 8, padding: "5px 8px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" },
			kpi: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(64px, 1fr))", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.line}` },
			kpiValue: { fontSize: 16, fontWeight: 600, color: T.fg, fontVariantNumeric: "tabular-nums", lineHeight: 1.3 },
			kpiUnit: { fontSize: 11, fontWeight: 400, color: T.fg3, marginLeft: 2 },
			kpiLabel: { fontSize: 11, color: T.fg3, marginTop: 2 },
			statGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
			statTile: { minWidth: 0 },
			statLabel: { fontSize: 12, color: T.fg3 },
			statValue: { fontSize: 20, fontWeight: 600, color: T.fg, fontVariantNumeric: "tabular-nums", lineHeight: 1.25, marginTop: 2 },
			statNote: { fontSize: 11, color: T.fg3, marginTop: 2 },
			empty: { color: T.caption, fontSize: 12.5, padding: "6px 0" },
			barWrap: { display: "flex", alignItems: "flex-end", gap: 8, marginTop: 8 },
			barCol: { flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
			barTrack: { display: "flex", alignItems: "flex-end", gap: 2, height: 44 },
			bar: { width: 9, borderRadius: 3, minHeight: 2 },
			barLabel: { fontSize: 11, color: T.fg3 },
			chatList: { maxHeight: 420, overflowY: "auto", paddingRight: 4 },
			bubble: { borderRadius: 12, padding: "9px 12px", marginBottom: 8, maxWidth: "92%", whiteSpace: "pre-wrap", fontSize: 13, wordBreak: "break-word" },
			bubbleAgent: { background: T.hover, color: T.fg },
			bubbleUser: { background: T.brand, color: T.onBrand, marginLeft: "auto" },
			textarea: { flex: "1 1 auto", minHeight: 58, resize: "vertical", background: "transparent", color: T.fg, border: `1px solid ${T.lineStrong}`, borderRadius: 10, padding: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" },
			banner: { position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 2147483000, width: 380, maxWidth: "92vw", background: T.card, border: `1px solid ${T.lineStrong}`, borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,0.28)", padding: 14, color: T.fg, fontSize: 13, boxSizing: "border-box", colorScheme: "inherit" },
			logItem: { display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: T.fg2, padding: "4px 0" },
			// 面板页（main 席位）：外壳给的是定高容器，自己必须撑满并让正文滚动
			panelPage: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", boxSizing: "border-box", color: T.fg, fontSize: 13, lineHeight: 1.6, colorScheme: "inherit" },
			panelHead: { flex: "0 0 auto", width: "100%", maxWidth: 880, margin: "0 auto", padding: "14px 20px 12px", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
			panelBody: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", width: "100%", maxWidth: 880, margin: "0 auto", padding: "0 20px 40px", boxSizing: "border-box" },
			// 底部输入区那一行里的入口（和统计条目并排）
			dockBtn: { display: "inline-flex", alignItems: "center", gap: 5, border: "none", background: "transparent", color: T.fg3, fontSize: 12, lineHeight: "18px", padding: "1px 6px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" },
			dockBtnOpen: { background: T.hover, color: T.fg },
			dockHot: { color: T.warn, fontWeight: 600 },
			dockOff: { color: T.caption },
			// 展开卡：挂在 shell.overlay 这层，做浮层，避免被输入区裁切
			panelLayer: { position: "fixed", inset: 0, zIndex: 2147482900, pointerEvents: "none" },
			panelBackdrop: { position: "absolute", inset: 0, pointerEvents: "auto" },
			panel: { position: "absolute", right: 14, bottom: 52, width: 344, maxWidth: "92vw", pointerEvents: "auto", background: T.card, border: `1px solid ${T.lineStrong}`, borderRadius: 14, boxShadow: "0 16px 40px rgba(0,0,0,0.32)", padding: 14, color: T.fg, fontSize: 13, boxSizing: "border-box", colorScheme: "inherit", maxHeight: "min(78vh, 620px)", overflowY: "auto", overflowX: "hidden" },
			// 浮层卡自己的表头叫 panelCardHead；panelHead 留给面板页（main 席位）用
			panelCardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 },
			iconBtn: { border: "none", background: "transparent", color: T.fg2, fontSize: 14, lineHeight: 1, padding: "2px 6px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" },
			// 弹窗层：确认（先问一句）与方案编辑（就地改一份方案）共用
			confirmLayer: { position: "fixed", inset: 0, zIndex: 2147483200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, boxSizing: "border-box" },
			confirmBackdrop: { position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" },
			confirmCard: { position: "relative", width: 340, maxWidth: "92vw", background: T.card, border: `1px solid ${T.lineStrong}`, borderRadius: 14, boxShadow: "0 18px 48px rgba(0,0,0,0.35)", padding: 16, color: T.fg, fontSize: 13, boxSizing: "border-box", colorScheme: "inherit" },
			dialogCard: { position: "relative", width: 460, maxWidth: "94vw", maxHeight: "84vh", overflowY: "auto", overflowX: "hidden", background: T.card, border: `1px solid ${T.lineStrong}`, borderRadius: 14, boxShadow: "0 18px 48px rgba(0,0,0,0.35)", padding: 16, color: T.fg, fontSize: 13, boxSizing: "border-box", colorScheme: "inherit" },
			// 分段选择器（音色这类 2~4 个固定选项）：不用原生 select，弹层才不会跟主题脱节
			segments: { display: "inline-flex", alignItems: "center", gap: 2, padding: 2, borderRadius: 10, background: T.hover, border: `1px solid ${T.line}`, flexWrap: "wrap" },
			segment: { border: "none", background: "transparent", color: T.fg2, fontSize: 12, padding: "4px 10px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", lineHeight: "18px" },
			segmentOn: { background: T.card, color: T.fg, fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.18)" }
		};
		/** 危险动作按钮（确认弹窗里用）。 */
		S.btnDanger = { ...S.btnPrimary, background: T.warn, borderColor: T.warn, color: "#fff" };
		//#endregion

		//#region React 小工具
		function useAppState() {
			const [state, setState] = useState(() => store.get());
			useEffect(() => store.subscribe(() => setState(store.get())), []);
			return state;
		}

		function useNow(intervalMs) {
			const [now, setNow] = useState(() => Date.now());
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), intervalMs ?? 1000);
				return () => clearInterval(timer);
			}, [intervalMs]);
			return now;
		}

		/**
		 * 底部入口的展开状态：纯界面状态，不写本地存储（刷新即收起）。
		 * 用一个极小的订阅表让入口按钮和浮层卡片保持同步。
		 */
		let dockOpen = false;
		const dockListeners = new Set();
		function setDockOpen(value) {
			const next = Boolean(value);
			if (next === dockOpen) return;
			dockOpen = next;
			for (const listener of [...dockListeners]) {
				try {
					listener(dockOpen);
				} catch (error) {
					console.warn("[health-reminder] 展开卡订阅者报错:", error);
				}
			}
		}
		function useDockOpen() {
			const [open, setOpen] = useState(dockOpen);
			useEffect(() => {
				const listener = (value) => setOpen(value);
				dockListeners.add(listener);
				setOpen(dockOpen);
				return () => {
					dockListeners.delete(listener);
				};
			}, []);
			return open;
		}

		function notificationSupported() {
			return typeof Notification !== "undefined" && typeof Notification === "function";
		}
		function notificationPermission() {
			try {
				return notificationSupported() ? Notification.permission : "unsupported";
			} catch (error) {
				return "unsupported";
			}
		}
		function requestNotificationPermission() {
			try {
				if (!notificationSupported()) return Promise.resolve("unsupported");
				return Promise.resolve(Notification.requestPermission());
			} catch (error) {
				return Promise.resolve("unsupported");
			}
		}

		/** 修改设置（自动归一化）。提醒时刻由固定时刻表派生，改完立刻生效，不需要重排。 */
		function updateSettings(patch) {
			const state = store.get();
			store.set({ ...state, settings: normalizeSettings({ ...state.settings, ...patch }) });
		}
		function updateKind(kind, patch) {
			const state = store.get();
			const kinds = { ...state.settings.kinds, [kind]: { ...state.settings.kinds[kind], ...patch } };
			updateSettings({ kinds });
		}
		function resetToday() {
			const state = store.get();
			const records = { ...state.records };
			delete records[dayKey(new Date())];
			store.set({ ...state, records });
		}
		/** 下一次提醒的人类可读描述。 */
		function nextInfo(state, kind, now) {
			if (!state.settings.enabled) return "已暂停";
			if (!kindEnabled(state.settings, kind)) return "已关闭";
			const at = nextAtFor(state, kind, now);
			if (typeof at !== "number") return "本周没有可提醒的时段";
			if (at <= now) return "正在提醒";
			const clock = new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
			return `${humanDuration(at - now)}后（${clock}）`;
		}
		/** 底部那一行空间很小，这里给一个极短的倒计时说法（12分 / 1h05 / 现在 / 暂）。 */
		function shortNext(state, kind, now) {
			if (!state.settings?.enabled) return "暂";
			if (!kindEnabled(state.settings, kind)) return "关";
			const at = nextAtFor(state, kind, now);
			if (typeof at !== "number") return "—";
			if (at <= now) return "现在";
			const mins = Math.max(1, Math.round((at - now) / 60000));
			if (mins < 60) return `${mins}分`;
			const hours = Math.floor(mins / 60);
			const rest = mins % 60;
			return rest === 0 ? `${hours}h` : `${hours}h${pad2(rest)}`;
		}
		/** 下一次提醒的时刻（HH:MM）。 */
		function clockOf(state, kind, now) {
			const at = nextAtFor(state, kind, now);
			if (typeof at !== "number") return "—";
			return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		}
		/** 与时刻配套的相对说法。 */
		function relativeOf(state, kind, now) {
			if (!state.settings.enabled) return "已暂停";
			if (!kindEnabled(state.settings, kind)) return "已关闭";
			const at = nextAtFor(state, kind, now);
			if (typeof at !== "number") return "本周没有可提醒的时段";
			if (at <= now) return "正在提醒";
			return `还有 ${humanDuration(at - now)}`;
		}
		//#endregion

		//#region 组件
		/** 侧边栏那一行的图标（外壳负责按钮、标签、折叠提示）。 */
		function HealthIcon({ size }) {
			return e(
				"svg",
				{
					"data-dsh-panel-entry": PANEL_ID,
					viewBox: "0 0 16 16",
					width: size ?? 16,
					height: size ?? 16,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				e("path", { key: "drop", d: "M8 2.3c0 0-4.3 4.7-4.3 7.3a4.3 4.3 0 0 0 8.6 0C12.3 7 8 2.3 8 2.3z" }),
				e("path", { key: "wave", d: "M6.2 9.8c0 1 .8 1.8 1.8 1.8" })
			);
		}

		function Toggle({ checked, onChange, label }) {
			return e(
				"label",
				{ style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: T.fg2, cursor: "pointer" } },
				e("input", { type: "checkbox", checked: checked === true, onChange: (ev) => onChange(ev.target.checked) }),
				label
			);
		}

		function Field({ label, children, hint }) {
			return e(
				"div",
				{ style: { display: "grid", gridTemplateColumns: "108px minmax(0, 1fr)", alignItems: "center", columnGap: 10, rowGap: 4, padding: "5px 0" } },
				e("div", { style: { fontSize: 12.5, color: T.fg2, lineHeight: 1.45 } }, label),
				e("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 } }, children),
				hint ? e("div", { style: { gridColumn: "2 / 3", ...S.hint, fontSize: 11.5 } }, hint) : null
			);
		}

		/** 一行放不下时（按钮多、内容宽）用的竖排：标签在上，内容另起一行。 */
		function FieldBlock({ label, hint, children }) {
			return e(
				"div",
				{ style: { padding: "5px 0" } },
				e("div", { style: { fontSize: 12.5, color: T.fg2, lineHeight: 1.45, marginBottom: 6 } }, label),
				e("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 0 } }, children),
				hint ? e("div", { style: { ...S.hint, fontSize: 11.5, marginTop: 4 } }, hint) : null
			);
		}

		/** 数字输入：本地保存文本，避免边输入边被归一化裁剪。 */
		function NumberField({ value, min, max, onChange, suffix }) {
			const [text, setText] = useState(String(value));
			useEffect(() => setText(String(value)), [value]);
			return e(
				"span",
				{ style: { display: "inline-flex", alignItems: "center", gap: 4 } },
				e("input", {
					type: "number",
					value: text,
					min: min,
					max: max,
					style: S.input,
					onChange: (ev) => {
						const raw = ev.target.value;
						setText(raw);
						const parsed = Number(raw);
						if (raw !== "" && Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
					},
					onBlur: () => setText(String(value))
				}),
				suffix ? e("span", { style: { fontSize: 12, color: T.fg3 } }, suffix) : null
			);
		}

		/** 滑块（音量这类 0-100 的值），改动即时写设置。 */
		function RangeField({ value, min, max, suffix, onChange }) {
			return e(
				"span",
				{ style: { display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 } },
				e("input", {
					type: "range",
					value: value,
					min: min,
					max: max,
					step: 1,
					style: { width: 148, accentColor: T.brand },
					onChange: (ev) => onChange(Number(ev.target.value))
				}),
				e("span", { style: { fontSize: 12, color: T.fg3, minWidth: 36, fontVariantNumeric: "tabular-nums" } }, `${value}${suffix ?? ""}`)
			);
		}

		/**
		 * 分段选择器（音色这类固定选项）。
		 * 刻意不用原生 `<select>`：它的选项弹层由系统绘制，深色主题下会变成一块白底，
		 * 这里用主题 token 自己画，浅色 / 深色都跟着当前主题走。
		 */
		function Segmented({ value, options, onChange }) {
			return e(
				"div",
				{ style: S.segments, role: "group" },
				options.map((option) =>
					e(
						"button",
						{
							key: option.value,
							type: "button",
							"aria-pressed": value === option.value,
							style: value === option.value ? { ...S.segment, ...S.segmentOn } : S.segment,
							onClick: () => onChange(option.value)
						},
						option.label
					)
				)
			);
		}

		/** 指标格：数值 + 单位 + 说明。 */
		function Metric({ value, unit, label }) {
			return e(
				"div",
				{ style: { minWidth: 0 } },
				e("div", { style: S.kpiValue }, String(value), unit ? e("span", { style: S.kpiUnit }, unit) : null),
				e("div", { style: S.kpiLabel }, label)
			);
		}

		function ProgressRow({ label, note, value, target, color }) {
			const pct = target > 0 ? clamp(Math.round((value / target) * 100), 0, 100) : 0;
			return e(
				"div",
				{ style: { marginBottom: 12 } },
				e(
					"div",
					{ style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 6 } },
					e(
						"span",
						{ style: { fontSize: 12.5, color: T.fg2 } },
						label,
						note ? e("span", { style: { fontSize: 11, color: T.caption, marginLeft: 6 } }, note) : null
					),
					e("span", { style: { fontSize: 12, color: T.fg3, fontVariantNumeric: "tabular-nums" } }, value, " / ", target)
				),
				e(
					"div",
					{ style: { height: 6, borderRadius: 999, background: T.line, overflow: "hidden" } },
					e("div", { style: { width: `${pct}%`, height: "100%", background: color, borderRadius: 999, transition: "width .3s ease" } })
				)
			);
		}

		/** 柱状图：每个开启的类型一根柱子，高度相对各自目标值；30 天时用细柱 + 稀疏日期。 */
		function WeekChart({ days, settings, span }) {
			const kinds = activeKinds(settings);
			const colors = kinds.map(kindColor);
			const thin = days.length > 14;
			const barHeight = thin ? 30 : 40;
			const barWidth = thin ? 3 : 6;
			const gap = thin ? 2 : 6;
			return e(
				"div",
				{ style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap, marginTop: 4, paddingTop: 12, borderTop: `1px solid ${T.line}` } },
				days.map((day, index) => {
					const counts = day.counts ?? { water: day.water, stand: day.stand };
					const tip = kinds.map((kind) => `${kindDef(kind).icon}${counts[kind] ?? 0}`).join(" · ");
					const showLabel = !thin || day.today || index % 5 === 0;
					const label = thin ? (day.today ? day.label : String(Number(day.key.slice(8, 10)))) : day.label;
					return e(
						"div",
						{
							key: day.key,
							style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
							title: `${day.key}：${tip}${day.met ? "（达标）" : ""}`
						},
						e(
							"div",
							{ style: { display: "flex", alignItems: "flex-end", gap: thin ? 1 : 3, height: barHeight } },
							kinds.map((kind, kindIndex) => {
								const height = Math.round(clamp((counts[kind] ?? 0) / Math.max(1, kindTarget(settings, kind)), 0, 1) * barHeight);
								return e("div", { key: kind, style: { width: barWidth, borderRadius: 3, height: Math.max(2, height), background: colors[kindIndex], opacity: day.workday ? 1 : 0.3 } });
							})
						),
						e(
							"div",
							{ style: { fontSize: thin ? 9.5 : 11, color: day.today ? T.fg : day.met ? T.stand : T.fg3, fontWeight: day.today ? 600 : 400, whiteSpace: "nowrap" } },
							showLabel ? label : ""
						)
					);
				})
			);
		}

		/**
		 * 一段可以直接贴进会话讨论的纯文本小结：不带 Markdown 语法，纯文本也好读。
		 * 复制按钮与 `/健康` 命令共用它，保证两边说的一样。
		 */
		function summaryText(state, now) {
			const settings = state.settings;
			const date = new Date(now);
			const today = recordOn(state, dayKey(date));
			const kinds = activeKinds(settings);
			const weekLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
			const amountOf = (kind, count) => {
				const def = kindDef(kind);
				const config = kindCfg(settings, kind);
				if (def.extra === "glassMl") return `${count * (config.glassMl ?? 250)} ml`;
				if (def.extra === "minutes") return `${count * (config.minutes ?? 3)} 分钟`;
				return `${count} 次`;
			};
			const days = lastDays(state, now, 7);
			const weekCount = (kind) => days.reduce((sum, day) => sum + (day.counts?.[kind] ?? 0), 0);
			const workdayText = settings.workdays.length >= 7 ? "每天" : settings.workdays.map((day) => weekLabels[day - 1]).join("、");
			return [
				`健康提醒小结 · ${dayKey(date)} ${weekLabels[((date.getDay() + 6) % 7)]}`,
				`作息：${workdayText} ${settings.dayStart}-${settings.dayEnd}，午休 ${settings.lunchStart}-${settings.lunchEnd}${settings.quiet.enabled ? `，免打扰 ${settings.quiet.start}-${settings.quiet.end}` : ""}`,
				`今日：${kinds.map((kind) => `${kindDef(kind).label} ${recordCount(today, kind)}/${kindTarget(settings, kind)}（${amountOf(kind, recordCount(today, kind))}）`).join("；")}；跳过 ${today.skips ?? 0} 次`,
				`连续达标 ${streakOf(state, now)} 天；近 7 天达标 ${days.filter((day) => day.met).length}/7`,
				`近 7 天：${kinds.map((kind) => `${kindDef(kind).label} ${weekCount(kind)} 次（${amountOf(kind, weekCount(kind))}）`).join("；")}`
			].join("\n");
		}

		/** 「报告」页签：近 7/30 天趋势、每类累计，以及导出 / 导入。 */
		function ReportView() {
			const state = useAppState();
			const now = useNow(1000);
			const [span, setSpan] = useState(7);
			const [note, setNote] = useState("");
			const [draft, setDraft] = useState("");
			const fileRef = useRef(null);
			const report = reportOf(state, span, now);

			const applyImport = (text) => {
				const parsed = parseImport(text);
				if (!parsed.ok) {
					setNote(`导入失败：${parsed.error}`);
					return;
				}
				const head = parsed.summary;
				runConfirm(
					{
						title: "导入这份数据？",
						body: `合并 ${head.days} 天记录（${head.done} 次完成、${head.logs} 条日志）。同一天取较大值、重复日志去重，本机设置${head.hasSettings ? "可按文件更新" : "不变"}。`,
						confirmText: "导入",
						danger: false
					},
					() => {
						const merged = mergeImport(state, parsed.payload, { applySettings: head.hasSettings, now: Date.now() });
						store.set(merged.state);
						setNote(`已导入：新增 ${merged.summary.added} 天、合并 ${merged.summary.merged} 天${merged.summary.settingsChanged ? "，设置已按文件更新" : ""}`);
					}
				);
			};

			const readFile = (event) => {
				const file = event?.target?.files?.[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => applyImport(String(reader.result ?? ""));
				reader.onerror = () => setNote("读不到这个文件");
				reader.readAsText(file);
				event.target.value = "";
			};

			const exportJSON = () => {
				const payload = buildExport(state, {});
				const text = JSON.stringify(payload, null, 2);
				const ok = downloadText(stampFilename("health-reminder", "json"), text);
				copyText(text).then((copied) =>
					setNote(ok || copied ? `已导出 ${Object.keys(payload.records).length} 天记录${copied ? "（内容也复制到了剪贴板）" : ""}` : "当前环境不支持下载，请手动复制内容保存")
				);
			};

			const exportCSV = () => {
				const text = csvOf(state, span, now);
				const ok = downloadText(stampFilename(`health-reminder-${span}天`, "csv"), text, "text/csv;charset=utf-8");
				setNote(ok ? `已导出近 ${span} 天 CSV` : "当前环境不支持下载");
			};

			return e(
				"div",
				null,
				e(
					"div",
					{ style: S.card },
					e(
						"div",
						{ style: S.cardTitle },
						"健康报告",
						e(
							"div",
							{ style: { display: "flex", gap: 6 } },
							[7, 30].map((value) =>
								e("button", { key: value, style: span === value ? { ...S.tab, ...S.tabActive } : S.tab, onClick: () => setSpan(value) }, `近 ${value} 天`)
							)
						)
					),
					e("div", { style: { ...S.kpi, marginTop: 12 } }, [
						e(Metric, { key: "met", value: `${report.metDays}/${report.workdays}`, label: "达标天数" }),
						e(Metric, { key: "best", value: report.best, unit: "天", label: "最长连续" }),
						e(Metric, { key: "streak", value: report.streak, unit: "天", label: "当前连续" }),
						e(Metric, { key: "skip", value: report.skips, unit: "次", label: "跳过" }),
						e(Metric, { key: "ml", value: report.waterMl, unit: "ml", label: "饮水合计" }),
						e(Metric, { key: "min", value: report.standMinutes, unit: "分钟", label: "活动合计" })
					]),
					e(WeekChart, { days: report.days, settings: state.settings, span: report.span })
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "每类累计"),
					report.rows.length === 0 ? e("div", { style: S.empty }, "没有开启的提醒类型。") : null,
					report.rows.map((row) =>
						e(
							"div",
							{
								key: row.kind,
								style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, padding: "7px 0", borderBottom: `1px solid ${T.line}` }
							},
							e(
								"span",
								{ style: { fontSize: 12.5, color: T.fg2 } },
								`${row.icon} ${row.label}`,
								e("span", { style: { fontSize: 11, color: T.caption, marginLeft: 6 } }, `目标 ${row.target} ${row.unit}/天`)
							),
							e(
								"span",
								{ style: { fontSize: 12.5, color: T.fg, fontVariantNumeric: "tabular-nums" } },
								`${row.total} ${row.unit}`,
								e("span", { style: { fontSize: 11, color: T.caption, marginLeft: 6 } }, `平均 ${Math.round((row.total / Math.max(1, report.span)) * 10) / 10}/天`)
							)
						)
					)
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "数据与同步"),
					e(
						"div",
						{ style: { display: "flex", flexWrap: "wrap", gap: 8 } },
						e("button", { style: S.btnPrimary, onClick: exportJSON }, "导出 JSON"),
						e("button", { style: S.btnSoft, onClick: exportCSV }, `导出近 ${span} 天 CSV`),
						e("button", { style: S.btnSmall, onClick: () => fileRef.current?.click() }, "选择文件导入"),
						e("input", { ref: fileRef, type: "file", accept: ".json,application/json", style: { display: "none" }, onChange: readFile })
					),
					e("textarea", {
						value: draft,
						onChange: (event) => setDraft(event.target.value),
						placeholder: "或把导出的 JSON 粘贴到这里",
						style: { ...S.input, marginTop: 10, width: "100%", minHeight: 64, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }
					}),
					e(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" } },
						e("button", { style: S.btnSmall, onClick: () => applyImport(draft) }, "导入粘贴内容"),
						e("button", { style: S.btnGhost, onClick: () => copyText(JSON.stringify(buildExport(state, {}), null, 2)).then((copied) => setNote(copied ? "已复制导出内容到剪贴板" : "复制失败")) }, "复制导出内容"),
						note ? e("span", { style: { fontSize: 11.5, color: T.fg2 } }, note) : null
					),
					state.lastImportAt ? e("div", { style: { ...S.hint, marginTop: 8 } }, `上次导入：${new Date(state.lastImportAt).toLocaleString()}`) : null
				)
			);
		}

		function TodayView() {
			const state = useAppState();
			const now = useNow(1000);
			const [note, setNote] = useState("");
			const settings = state.settings;
			const today = recordOn(state, dayKey(new Date(now)));
			const streak = streakOf(state, now);
			const days = lastDays(state, now, 7);
			const weekMet = days.filter((day) => day.met).length;
			const pending = state.runtime?.pending ?? [];
			const log = [...(today.log ?? [])].reverse();
			const kinds = activeKinds(settings);
			const kpis = [
				{ key: "streak", value: streak, unit: "天", label: "连续达标" },
				{ key: "week", value: `${weekMet}/7`, label: "近 7 天达标" },
				{ key: "skip", value: today.skips ?? 0, label: "今日跳过" }
			];
			for (const kind of kinds) {
				const def = kindDef(kind);
				if (def.extra === "glassMl") kpis.push({ key: def.id, value: recordCount(today, kind) * (kindCfg(settings, kind).glassMl ?? 250), unit: "ml", label: "今日饮水" });
				if (def.extra === "minutes") kpis.push({ key: def.id, value: recordCount(today, kind) * (kindCfg(settings, kind).minutes ?? 3), unit: "分钟", label: "今日活动" });
			}
			kpis.push({ key: "workdays", value: settings.workdays.length, label: "每周上班天数" });
			const legend = kinds.map((kind) => `${kindDef(kind).icon}${kindDef(kind).label}`).join(" · ");
			return e(
				"div",
				null,
				e(
					"div",
					{ style: S.card },
					e(
						"div",
						{ style: S.cardTitle },
						settings.enabled ? "下一次提醒" : "提醒已暂停",
						pending.length > 0 ? e("span", { style: S.cardNote }, `还有 ${pending.length} 条未处理`) : null
					),
					e(
						"div",
						{ style: { ...S.statGrid, gridTemplateColumns: kinds.length > 2 ? `repeat(${kinds.length}, minmax(0, 1fr))` : "1fr 1fr" } },
						kinds.map((kind) =>
							e(
								"div",
								{ key: kind, style: S.statTile },
								e("div", { style: S.statLabel }, `${kindDef(kind).icon} ${kindDef(kind).label}`),
								e("div", { style: S.statValue }, clockOf(state, kind, now)),
								e("div", { style: S.statNote }, relativeOf(state, kind, now))
							)
						)
					),
					e(
						"div",
						{ style: { ...S.rowWrap, marginTop: 14 } },
						kinds.map((kind) =>
							e("button", { key: kind, style: S.btnSoft, onClick: () => completeKind(kind, Date.now()) }, `完成一次${kindDef(kind).label}`)
						),
						e("button", { style: S.btnGhost, onClick: () => fireNow(kinds[0] ?? "water", Date.now()) }, "试一下提醒"),
						e("button", { style: S.btnGhost, onClick: () => updateSettings({ enabled: !settings.enabled }) }, settings.enabled ? "暂停提醒" : "恢复提醒")
					)
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "今日进度", e("span", { style: S.cardNote }, `${legend} · 淡色 非上班日`)),
					kinds.map((kind) => {
						const def = kindDef(kind);
						const config = kindCfg(settings, kind);
						const note = def.extra === "glassMl" ? `每杯 ${config.glassMl ?? 250} ml` : def.extra === "minutes" ? `每次 ${config.minutes ?? 3} 分钟` : undefined;
						return e(ProgressRow, {
							key: kind,
							label: def.label,
							note,
							value: recordCount(today, kind),
							target: kindTarget(settings, kind),
							color: kindColor(kind)
						});
					}),
					e(
						"div",
						{ style: S.kpi },
						kpis.map((item) => e(Metric, { key: item.key, value: item.value, unit: item.unit, label: item.label }))
					),
					e(WeekChart, { days, settings })
				),
				e(
					"div",
					{ style: S.card },
					e(
						"div",
						{ style: S.cardTitle },
						"今日记录",
						e(
							"span",
							{ style: { display: "inline-flex", alignItems: "center", gap: 8 } },
							note ? e("span", { style: S.cardNote }, note) : null,
							e(
								"button",
								{
									style: S.btnGhost,
									onClick: () => copyText(summaryText(state, now)).then((copied) => setNote(copied ? "已复制，可以直接贴进对话" : "复制失败"))
								},
								"复制今日小结"
							)
						)
					),
					log.length === 0
						? e("div", { style: S.empty }, "还没有记录。")
						: log.slice(0, 20).map((item, index) =>
								e(
									"div",
									{ key: `${item.t}-${index}`, style: S.logItem },
									e("span", { style: { color: T.caption, minWidth: 44, fontVariantNumeric: "tabular-nums" } }, new Date(item.t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })),
									e("span", null, `${kindDef(item.kind).icon} ${kindDef(item.kind).label} · ${item.action === "done" ? "完成" : "跳过"}`)
								)
							)
				)
			);
		}

		function SettingsView() {
			const state = useAppState();
			useNow(5000);
			const settings = state.settings;
			const [notifyNote, setNotifyNote] = useState("");
			const permission = notificationPermission();
			/** 点「测试系统通知」时给一句人话反馈：权限没拿到 / 环境不支持都不该是静默的。 */
			const testNotify = () => {
				const result = notifySystem("water", Date.now());
				if (result === "sent") return "已发出系统通知（点通知会把窗口拉到前台并打开面板）。";
				if (result === "unsupported") return "这个环境不支持系统通知，先用「测试提示音」或应用内提示卡。";
				if (result === "denied") return notificationPermission() === "denied" ? "浏览器/系统拒绝了通知权限，得在那里放开；先用提示音或应用内提示卡。" : "还没拿到通知权限，先点「请求权限」。";
				return "系统通知没发出去，插件没受影响，可以看控制台日志。";
			};
			const toggleDay = (iso) => {
				const has = settings.workdays.includes(iso);
				const next = has ? settings.workdays.filter((day) => day !== iso) : [...settings.workdays, iso].sort((a, b) => a - b);
				if (next.length > 0) updateSettings({ workdays: next });
			};
			const timeInput = (value, onChange) =>
				e("input", {
					type: "time",
					value: value,
					style: S.timeInput,
					onChange: (ev) => {
						if (parseHM(ev.target.value) !== null) onChange(ev.target.value);
					}
				});
			const permissionText =
				permission === "granted"
					? "系统通知权限：已允许"
					: permission === "denied"
						? "系统通知权限：已被拒绝（需要到系统设置里手动允许）"
						: permission === "unsupported"
							? "当前环境不支持浏览器系统通知"
							: "系统通知权限：还没请求（点右侧按钮请求）";
			return e(
				"div",
				null,
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "总开关"),
					e(Field, { label: "启用提醒" }, e(Toggle, { checked: settings.enabled, onChange: (value) => updateSettings({ enabled: value }) }))
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "作息"),
					e(
						Field,
						{ label: "上班日", hint: "至少要留一个上班日；取消最后一个不会生效。" },
						WEEKDAYS.map((iso) => {
							const on = settings.workdays.includes(iso);
							const last = on && settings.workdays.length === 1;
							return e(
								"button",
								{
									key: iso,
									style: last ? { ...S.chipOn, cursor: "default", opacity: 0.8 } : on ? S.chipOn : S.chip,
									title: last ? "至少要留一个上班日" : undefined,
									onClick: () => toggleDay(iso)
								},
								WEEKDAY_LABELS[iso]
							);
						})
					),
					e(Field, { label: "上班 / 下班时间" }, timeInput(settings.dayStart, (value) => updateSettings({ dayStart: value })), e("span", { style: S.hint }, "到"), timeInput(settings.dayEnd, (value) => updateSettings({ dayEnd: value }))),
					e(
						Field,
						{ label: "午休（不提醒）" },
						e(Toggle, { checked: settings.lunchEnabled, onChange: (value) => updateSettings({ lunchEnabled: value }), label: "启用" }),
						timeInput(settings.lunchStart, (value) => updateSettings({ lunchStart: value })),
						e("span", { style: S.hint }, "到"),
						timeInput(settings.lunchEnd, (value) => updateSettings({ lunchEnd: value }))
					),
					e(
						Field,
						{ label: "免打扰时段（可跨零点）" },
						e(Toggle, { checked: settings.quiet.enabled, onChange: (value) => updateSettings({ quiet: { ...settings.quiet, enabled: value } }), label: "启用" }),
						timeInput(settings.quiet.start, (value) => updateSettings({ quiet: { ...settings.quiet, start: value } })),
						e("span", { style: S.hint }, "到"),
						timeInput(settings.quiet.end, (value) => updateSettings({ quiet: { ...settings.quiet, end: value } }))
					)
				),
				e(
					"div",
					{ style: S.kindGrid },
					...KIND_DEFS.map((def) => {
						const config = settings.kinds[def.id];
						return e(
							"div",
							{ key: def.id, style: { ...S.card, marginBottom: 0 } },
							e("div", { style: S.cardTitle }, `${def.icon} ${def.label}`, def.tip ? e("span", { style: S.cardNote }, def.tip) : null),
							e(Field, { label: "启用" }, e(Toggle, { checked: config.on, onChange: (value) => updateKind(def.id, { on: value }) })),
							e(Field, { label: "提醒间隔" }, e(NumberField, { value: config.intervalMin, min: 5, max: 240, onChange: (value) => updateKind(def.id, { intervalMin: value }), suffix: "分钟" })),
							def.extra === "glassMl"
								? e(Field, { label: "每杯容量" }, e(NumberField, { value: config.glassMl ?? 250, min: 100, max: 800, onChange: (value) => updateKind(def.id, { glassMl: value }), suffix: "ml" }))
								: null,
							def.extra === "minutes"
								? e(Field, { label: "每次活动时长" }, e(NumberField, { value: config.minutes ?? 3, min: 1, max: 30, onChange: (value) => updateKind(def.id, { minutes: value }), suffix: "分钟" }))
								: null,
							e(Field, { label: "每日目标" }, e(NumberField, { value: config.target, min: 1, max: def.maxTarget, onChange: (value) => updateKind(def.id, { target: value }), suffix: def.unit }))
						);
					})
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "提醒方式"),
					e(Field, { label: "系统通知" }, e(Toggle, { checked: settings.notify.system, onChange: (value) => updateSettings({ notify: { ...settings.notify, system: value } }) })),
					e(Field, { label: "应用内提示卡" }, e(Toggle, { checked: settings.notify.inApp, onChange: (value) => updateSettings({ notify: { ...settings.notify, inApp: value } }) })),
					e(Field, { label: "提示音" }, e(Toggle, { checked: settings.notify.sound, onChange: (value) => updateSettings({ notify: { ...settings.notify, sound: value } }) })),
					e(
						Field,
						{ label: "音量" },
						e(RangeField, {
							value: Math.round((settings.notify.volume ?? 0.7) * 100),
							min: 5,
							max: 100,
							suffix: "%",
							onChange: (value) => updateSettings({ notify: { ...settings.notify, volume: clamp(value / 100, 0.05, 1) } })
						})
					),
					e(
						Field,
						{ label: "音色" },
						e(Segmented, {
							value: settings.notify.tone,
							options: TONE_IDS.map((id) => ({ value: id, label: TONES[id].label })),
							onChange: (value) => updateSettings({ notify: { ...settings.notify, tone: value } })
						})
					),
					e(Field, { label: "全屏时静音" }, e(Toggle, { checked: settings.notify.muteFullscreen, onChange: (value) => updateSettings({ notify: { ...settings.notify, muteFullscreen: value } }) })),
					e(
						FieldBlock,
						{ label: "快捷操作", hint: "面板打开时的几个常用动作，放这里方便直接点。" },
						e("button", { style: S.btnSmall, onClick: () => { setDockOpen(true); selectPanel(); } }, "打开面板"),
						e("button", { style: S.btnSmall, onClick: () => completeKind("water", Date.now()) }, "记一杯水"),
						e("button", { style: S.btnSmall, onClick: () => completeKind("stand", Date.now()) }, "记一次起身"),
						e(
							"button",
							{
								style: S.btnSmall,
								onClick: () => updateSettings({ enabled: store.get().settings.enabled !== true })
							},
							settings.enabled ? "暂停提醒" : "恢复提醒"
						)
					),
					e(
						"div",
						{ style: S.rowWrap },
						e("span", { style: S.hint }, permissionText),
						permission === "default"
							? e(
									"button",
									{
										style: S.btnSmall,
										onClick: () => {
											setNotifyNote("");
											requestNotificationPermission().then(() => setNotifyNote(""));
										}
									},
									"请求权限"
								)
							: null,
						e("button", { style: S.btnSmall, onClick: () => setNotifyNote(testNotify()) }, "测试系统通知"),
						e("button", { style: S.btnSmall, onClick: () => { setNotifyNote(""); playBeep("water"); } }, "测试提示音"),
						notifyNote ? e("span", { style: S.hint }, notifyNote) : null
					)
				),
								e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "数据"),
					e(
						"div",
						{ style: S.rowWrap },
						e(
							"button",
							{
								style: S.btnSmall,
								onClick: () =>
									runConfirm(
										{ title: "清空今日记录？", body: "今天记下的喝水和起身次数会被清掉，其他日期不受影响。", confirmText: "清空今天" },
										() => resetToday()
									)
							},
							"清空今日记录"
						),
						e(
							"button",
							{
								style: S.btnSmall,
								onClick: () =>
									runConfirm(
										{ title: "清空全部统计？", body: "所有日期的记录都会被删除，作息和方案会保留。", confirmText: "全部清空" },
										() => store.set({ ...store.get(), records: {} })
									)
							},
							"清空全部统计"
						),
						e(
							"button",
							{
								style: S.btnSmall,
								onClick: () =>
									runConfirm(
										{ title: "恢复默认设置？", body: "作息、间隔、目标与全部统计都会回到初始状态（方案会保留），不能撤销。", confirmText: "恢复默认" },
										() => {
											const keep = store.get();
											store.set({ ...defaultState(), plans: keep.plans ?? [], activePlanId: keep.activePlanId ?? null });
											ensureRuntimeNow(Date.now());
										}
									)
							},
							"恢复默认设置"
						)
					)
				)
			);
		}

		/** 一份方案的行：名字、要点、应用 / 改名 / 复制 / 删除。 */
		function PlanRow({ plan, active }) {
			const [draft, setDraft] = useState(null);
			const lines = planLines(plan);
			const summary = lines.slice(0, 2).join(" · ");
			const stamp = new Date(plan.updatedAt).toLocaleString("zh-CN", { hour12: false });
			return e(
				"div",
				{ style: { borderTop: `1px solid ${T.line}`, padding: "10px 0" } },
				e(
					"div",
					{ style: S.rowWrap },
					draft === null
						? e("span", { style: { fontSize: 13, fontWeight: active ? 600 : 400, color: T.fg } }, plan.name)
						: e("input", { style: { ...S.input, width: 200 }, value: draft, onChange: (ev) => setDraft(ev.target.value) }),
					active ? e("span", { style: { border: `1px solid ${T.brand}`, color: T.brand, borderRadius: 999, padding: "1px 8px", fontSize: 11 } }, "使用中") : null,
					e("span", { style: S.cardNote }, `改于 ${stamp}`)
				),
				e("div", { style: { ...S.hint, marginTop: 4 } }, summary),
				e(
					"div",
					{ style: { ...S.rowWrap, marginTop: 8 } },
					active ? null : e("button", { style: S.btnSmall, onClick: () => applyPlanById(plan.id) }, "应用"),
					e("button", { style: S.btnSmall, onClick: () => openPlanEditor(plan.id) }, "编辑"),
					draft === null
						? e("button", { style: S.btnSmall, onClick: () => setDraft(plan.name) }, "重命名")
						: [
								e(
									"button",
									{
										key: "save",
										style: S.btnSmall,
										onClick: () => {
											renamePlan(plan.id, draft);
											setDraft(null);
										}
									},
									"保存名字"
								),
								e("button", { key: "cancel", style: S.btnGhost, onClick: () => setDraft(null) }, "取消")
							],
					e("button", { style: S.btnSmall, onClick: () => duplicatePlan(plan.id) }, "复制"),
					e(
						"button",
						{
							style: { ...S.btnSmall, color: T.warn, borderColor: T.warn },
							onClick: () =>
								runConfirm(
									{ title: `删除「${plan.name}」？`, body: "只删这份方案的配置；当前设置和统计都不受影响。", confirmText: "删除" },
									() => removePlan(plan.id)
								)
						},
						"删除"
					)
				)
			);
		}

		/** 方案页：本机存放多套配置，照当前设置新建，随时切换。 */
		function PlansView() {
			const state = useAppState();
			const plans = state.plans ?? [];
			const active = activePlanOf(state);
			const drifted = planDrifted(state);
			const [draft, setDraft] = useState("");
			const status = active === null ? "下面挑一份方案应用，或者照当前设置新建一份。" : drifted ? "当前设置已经改过，和这份方案不一致了。" : "当前设置和这份方案一致。";
			return e(
				"div",
				null,
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "当前方案", e("span", { style: S.cardNote }, `${plans.length} 份方案`)),
					e(
						"div",
						{ style: S.rowWrap },
						e("span", { style: { fontSize: 14, fontWeight: 600, color: T.fg } }, active ? active.name : "（没选）"),
						active && drifted ? e("span", { style: { border: `1px solid ${T.warn}`, color: T.warn, borderRadius: 999, padding: "1px 8px", fontSize: 11 } }, "有改动") : null
					),
					e("div", { style: { ...S.hint, marginTop: 6 } }, status),
					active
						? e(
								"div",
								{ style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.line}` } },
								planLines(active).map((line, index) => e("div", { key: index, style: { fontSize: 12, color: T.fg2, padding: "2px 0" } }, `· ${line}`))
							)
						: null,
					e(
						"div",
						{ style: { ...S.rowWrap, marginTop: 12 } },
						e(
							"button",
							{
								style: active ? S.btnPrimary : { ...S.btnPrimary, opacity: 0.5, cursor: "default" },
								// 没有当前方案时真的禁用（不只是看起来灰）：点上去没反应会让人以为插件坏了。
								disabled: !active,
								title: active ? "用当前设置覆盖这份方案记下的配置" : "还没有当前方案：先「应用」一份，或在下面「照当前设置新建」",
								onClick: () =>
									active &&
									runConfirm(
										{ title: "保存到这份方案？", body: `「${active.name}」记下的配置会被当前设置覆盖，其他方案不受影响。`, confirmText: "保存", danger: false },
										() => savePlan(active.name, active.id)
									)
							},
							"保存到方案"
						),
						e(
							"button",
							{
								style: active ? S.btnSoft : { ...S.btnSoft, opacity: 0.5, cursor: "default" },
								disabled: !active,
								title: active ? "把当前作息、间隔、目标退回这份方案记下的样子" : "还没有当前方案：先「应用」一份",
								onClick: () =>
									active &&
									runConfirm(
										{ title: "恢复这份方案？", body: "当前作息、间隔、目标会退回这份方案记下的样子（统计不动）。", confirmText: "恢复", danger: false },
										() => revertToActivePlan()
									)
							},
							"恢复方案"
						)
					)
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "新建方案"),
					e(
						"div",
						{ style: S.rowWrap },
						e("input", {
							style: { ...S.input, width: 220 },
							placeholder: "例如：工作日上午 / 周末也提醒",
							value: draft,
							onChange: (ev) => setDraft(ev.target.value)
						}),
						e(
							"button",
							{
								style: S.btnPrimary,
								onClick: () => {
									savePlan(draft, null);
									setDraft("");
								}
							},
							"照当前设置新建"
						)
					),
					e("div", { style: { ...S.hint, marginTop: 8 } }, "新方案会完整记下现在的作息、每类提醒的间隔与目标、提醒方式；名字留空就按作息自动起一个。切换方案会按新时刻表重新计时，统计不会被清掉。")
				),
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "全部方案"),
					plans.length === 0 ? e("div", { style: S.empty }, "还没有方案。") : plans.map((plan) => e(PlanRow, { key: plan.id, plan, active: active?.id === plan.id }))
				)
			);
		}

		function DockEntry() {
			notePaint("conversation.composer.dock");
			const state = useAppState();
			const now = useNow(1000);
			const open = useDockOpen();
			const settings = state.settings;
			const pending = state.runtime?.pending ?? [];
			const today = recordOn(state, dayKey(new Date(now)));
			const kinds = activeKinds(settings);
			let label;
			let tone = null;
			if (!settings.enabled) {
				label = "健康提醒 · 已暂停";
				tone = S.dockOff;
			} else if (pending.length > 0) {
				const def = kindDef(pending[0].kind);
				label = `健康提醒 · ${def.title}${def.icon}`;
				tone = S.dockHot;
			} else if (kinds.length === 0) {
				label = "健康提醒 · 没有可提醒的项目";
			} else {
				// 类型多的时候不要把输入区那行撑爆：最多显示三个，剩下的折成 +N。
				const shown = kinds.slice(0, 3);
				const rest = kinds.length - shown.length;
				label = `健康提醒 · ${shown.map((kind) => `${kindDef(kind).icon}${shortNext(state, kind, now)}`).join(" ")}${rest > 0 ? ` +${rest}` : ""}`;
			}
			const summary =
				kinds.length === 0
					? "没有开启的提醒"
					: kinds.map((kind) => `${kindDef(kind).label} ${recordCount(today, kind)}/${kindTarget(settings, kind)} ${kindDef(kind).unit}`).join(" · ");
			return e(
				"button",
				{
					type: "button",
					"data-dsh-plugin": "health-reminder",
					"data-dsh-seat": "conversation.composer.dock",
					style: open ? { ...S.dockBtn, ...S.dockBtnOpen } : S.dockBtn,
					onClick: () => setDockOpen(!open),
					title: `今日 ${summary}（点击展开）`,
					"aria-expanded": open ? "true" : "false"
				},
				e(HealthIcon, { size: 14 }),
				e("span", { style: { ...(tone ?? {}), overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 } }, label)
			);
		}

		/** 点入口后展开的卡片：今天进度、待处理提醒、快捷动作。 */
		function QuickPanel() {
			const state = useAppState();
			const now = useNow(1000);
			const settings = state.settings;
			const today = recordOn(state, dayKey(new Date(now)));
			const pending = state.runtime?.pending ?? [];
			const streak = streakOf(state, now);
			const kinds = activeKinds(settings);
			const progressRow = (kind) => {
				const def = kindDef(kind);
				const config = kindCfg(settings, kind);
				const note = def.extra === "glassMl" ? `每杯 ${config.glassMl ?? 250} ml` : def.extra === "minutes" ? `每次 ${config.minutes ?? 3} 分钟` : undefined;
				return e(ProgressRow, { key: kind, label: def.label, note, value: recordCount(today, kind), target: kindTarget(settings, kind), color: kindColor(kind) });
			};
			useEffect(() => {
				try {
					if (typeof document === "undefined") return () => {};
					const onKey = (ev) => {
						if (ev?.key === "Escape") setDockOpen(false);
					};
					document.addEventListener("keydown", onKey);
					return () => document.removeEventListener("keydown", onKey);
				} catch (error) {
					return () => {};
				}
			}, []);
			return e(
				"div",
				{ style: S.panelLayer, role: "dialog", "aria-label": "健康提醒", "data-dsh-plugin": "health-reminder" },
				e("div", { style: S.panelBackdrop, onClick: () => setDockOpen(false), "aria-hidden": "true" }),
				e(
					"div",
					{ style: S.panel },
					e(
						"div",
						{ style: S.panelCardHead },
						e("div", { style: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600 } }, e(HealthIcon, { size: 15 }), "健康提醒"),
						e(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 4 } },
							e("button", { style: S.btnSmall, onClick: () => { setDockOpen(false); selectPanel(); } }, "完整面板"),
							e("button", { style: S.iconBtn, title: "收起", onClick: () => setDockOpen(false) }, "✕")
						)
					),
					settings.enabled
						? e(
								// 卡片只有 344px 宽：类型再多也保持两列，不然时间会被挤成竖排。
								"div",
								{ style: { ...S.statGrid, gridTemplateColumns: "1fr 1fr" } },
								kinds.map((kind) =>
									e(
										"div",
										{ key: kind, style: S.statTile },
										e("div", { style: S.statLabel }, `${kindDef(kind).icon} 下次${kindDef(kind).label}`),
										e("div", { style: { ...S.statValue, fontSize: 17 }, title: nextInfo(state, kind, now) }, clockOf(state, kind, now)),
										e("div", { style: S.statNote }, relativeOf(state, kind, now))
									)
								)
							)
						: e("div", { style: { ...S.hint, marginBottom: 10 } }, "提醒已暂停"),
					pending.length > 0
						? e(
								"div",
								{ style: { border: `1px solid ${T.line}`, borderRadius: 10, padding: 10, marginBottom: 10, display: "flex", flexDirection: "column", gap: 8 } },
								pending.slice(0, 4).map((item, index) => e(PendingRow, { key: item.id ?? index, item, dense: true })),
								pending.length > 1 ? e("span", { style: S.hint }, `还有 ${pending.length - 1} 条`) : null
							)
						: null,
					kinds.map(progressRow),
					e(
						"div",
						{ style: { ...S.rowWrap, marginTop: 4 } },
						kinds.map((kind) => e("button", { key: kind, style: S.btnSoft, onClick: () => completeKind(kind, Date.now()) }, kindDef(kind).verb)),
						e("button", { style: S.btnGhost, onClick: () => updateSettings({ enabled: !settings.enabled }) }, settings.enabled ? "暂停提醒" : "恢复提醒"),
						e("button", { style: S.btnGhost, onClick: () => fireNow(pending[0]?.kind ?? kinds[0] ?? "water", Date.now()), title: "演练：只弹卡片/系统通知，不计入记录" }, "试一下提醒")
					),
					e("div", { style: { ...S.cardNote, marginTop: 10 } }, `连续达标 ${streak} 天`)
				)
			);
		}

		/**
		 * 一条等待回应的提醒。
		 * 真实提醒给「喝了 / 10 分钟后 / 跳过 / 今天不再」；演练项（试一下提醒）只给「知道了 / 再试一次」，
		 * 因为它绝不能写进记录。
		 */
		function PendingRow({ item, dense }) {
			const test = item?.test === true;
			return e(
				"div",
				{ style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
				e("span", { style: { minWidth: 58 } }, `${kindDef(item.kind).icon} ${kindDef(item.kind).label}`),
				test ? e("span", { style: S.hint }, "演练，不计数") : null,
				test
					? e("button", { style: S.btnPrimary, onClick: () => completeKind(item.kind, Date.now(), { test: true }) }, "知道了")
					: e("button", { style: S.btnPrimary, onClick: () => completeKind(item.kind, Date.now()) }, kindDef(item.kind).verb),
				test ? null : e("button", { style: S.btnSmall, onClick: () => snoozeKind(item.kind, Date.now(), 10) }, dense ? "10 分钟后" : "10 分钟后再提醒"),
				test ? null : e("button", { style: S.btnSmall, onClick: () => skipKind(item.kind, Date.now()) }, dense ? "跳过" : "跳过这次"),
				test ? null : e("button", { style: S.btnSmall, onClick: () => muteKindToday(item.kind, Date.now()) }, dense ? "今天不再" : "今天不再提醒"),
				test ? e("button", { style: S.btnSmall, onClick: () => fireNow(item.kind, Date.now()) }, "再试一次") : null
			);
		}

		/** 全局提醒横幅：席位可用时由 shell.overlay 渲染（任何面板下都可见）。 */
		function ReminderBanner() {
			const state = useAppState();
			const now = useNow(1000);
			const pending = state.runtime?.pending ?? [];
			if (!state.settings.notify.inApp) return null;
			const item = pending[0];
			if (!item) return null;
			const copy = reminderCopy(item.kind, item.at ?? now);
			return e(
				"div",
				{ style: S.banner, role: "status", "data-dsh-plugin": "health-reminder" },
				e(
					"div",
					{ style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 } },
					e("div", { style: { fontWeight: 600 } }, copy.title),
					e("button", { style: { ...S.btnSmall, padding: "1px 7px" }, onClick: () => selectPanel(), title: "打开健康提醒面板" }, "面板")
				),
				e("div", { style: { marginTop: 6 } }, copy.body),
				e("div", { style: { ...S.hint, marginTop: 4 } }, copy.detail),
				e(
					"div",
					{ style: { display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" } },
					e(PendingRow, { item }),
					pending.length > 1 ? e("span", { style: S.hint }, `还有 ${pending.length - 1} 条`) : null
				)
			);
		}

		/**
		 * shell.overlay 的内容：底部入口展开时优先显示浮层卡片，否则退回提醒横幅。
		 * 确认弹窗与方案编辑弹窗永远挂在最后一层——不管是从面板、设置页还是浮层卡触发，都能盖在最上面。
		 */
		function OverlaySeat() {
			notePaint("shell.overlay");
			const open = useDockOpen();
			return e("div", null, open ? e(QuickPanel) : e(ReminderBanner), e(ConfirmDialog), e(PlanEditorDialog));
		}

		/**
		 * 「设置」这一页的正文：今日概况（和面板「今日」页签同一份数据、同一批快捷操作）
		 * + 全部设置项。面板的「设置」页签与 DSH 设置里的「健康提醒」一页都用它，
		 * 两个入口不会再各说各话。
		 */
		function SettingsPane() {
			const state = useAppState();
			const now = useNow(1000);
			const settings = state.settings;
			const today = recordOn(state, dayKey(new Date(now)));
			const streak = streakOf(state, now);
			const kinds = activeKinds(settings);
			return e(
				"div",
				null,
				e(
					"div",
					{ style: S.card },
					e("div", { style: S.cardTitle }, "今日概况"),
					e(
						"div",
						{ style: { ...S.statGrid, gridTemplateColumns: kinds.length > 2 ? `repeat(${kinds.length}, minmax(0, 1fr))` : "1fr 1fr" } },
						kinds.map((kind) =>
							e(
								"div",
								{ key: kind, style: S.statTile },
								e("div", { style: S.statLabel }, `${kindDef(kind).icon} 下次${kindDef(kind).label}`),
								e("div", { style: S.statValue }, clockOf(state, kind, now)),
								e("div", { style: S.statNote }, relativeOf(state, kind, now))
							)
						)
					),
					e("div", { style: { height: 14 } }),
					kinds.map((kind) => {
						const def = kindDef(kind);
						const config = kindCfg(settings, kind);
						const note = def.extra === "glassMl" ? `每杯 ${config.glassMl ?? 250} ml` : def.extra === "minutes" ? `每次 ${config.minutes ?? 3} 分钟` : undefined;
						return e(ProgressRow, { key: kind, label: def.label, note, value: recordCount(today, kind), target: kindTarget(settings, kind), color: kindColor(kind) });
					}),
					e(
						"div",
						{ style: { ...S.rowWrap, marginTop: 2 } },
						kinds.map((kind) => e("button", { key: kind, style: S.btnSoft, onClick: () => completeKind(kind, Date.now()) }, kindDef(kind).verb)),
						e("button", { style: S.btnGhost, onClick: () => updateSettings({ enabled: !settings.enabled }) }, settings.enabled ? "暂停提醒" : "恢复提醒"),
						e("button", { style: S.btnGhost, onClick: () => fireNow(kinds[0] ?? "water", Date.now()), title: "演练：只弹卡片/通知，不计入记录" }, "试一下提醒")
					),
					e("div", { style: { ...S.cardNote, marginTop: 10 } }, `连续达标 ${streak} 天`)
				),
				e(SettingsView)
			);
		}

		/** 「设置」里的独立一页（settings.section 席位），内容与面板里的设置页签一致。 */
		function HealthSettingsSection() {
			notePaint("settings.section");
			const state = useAppState();
			const settings = state.settings;
			const kinds = activeKinds(settings);
			return e(
				"div",
				{ style: { ...S.page, padding: "2px 0 40px", maxWidth: 760, margin: 0 }, "data-dsh-plugin": "health-reminder" },
				e(
					"div",
					{ style: S.header },
					e("h2", { style: S.title }, "健康提醒"),
					e("span", { style: S.subtitle }, settings.enabled ? `${kinds.length} 项提醒运行中` : "已暂停"),
					e("button", { style: S.btnSmall, onClick: () => selectPanel() }, "打开完整面板")
				),
				e(SettingsPane)
			);
		}

		function HealthPanelPage() {
			notePaint("main");
			const state = useAppState();
			const [tab, setTab] = useState("today");
			const settings = state.settings;
			const kinds = activeKinds(settings);
			const summary = kinds.map((kind) => `${kindDef(kind).icon}${kindCfg(settings, kind).intervalMin}分`).join(" ");
			const subtitle = settings.enabled
				? `${settings.workdays.length} 天/周 ${settings.dayStart}–${settings.dayEnd}${summary ? ` · ${summary}` : ""}`
				: "已暂停";
			const tabs = [
				["today", "今日"],
				["report", "报告"],
				["settings", "设置"],
				["plans", "方案"]
			];
			return e(
				"div",
				{ style: S.panelPage, "data-dsh-plugin": "health-reminder" },
				e(
					"div",
					{ style: S.panelHead },
					e("div", { style: S.header }, e("h2", { style: S.title }, "健康提醒"), e("span", { style: S.subtitle }, subtitle)),
					e("div", { style: S.tabs }, tabs.map(([id, label]) => e("button", { key: id, style: tab === id ? { ...S.tab, ...S.tabActive } : S.tab, onClick: () => setTab(id) }, label)))
				),
				e(
					"div",
					{ style: S.panelBody },
					tab === "today" ? e(TodayView) : tab === "report" ? e(ReportView) : tab === "settings" ? e(SettingsPane) : e(PlansView)
				),
				overlaySeatLive ? null : e(ReminderBanner),
				// 弹窗得有个落脚点：浮层席位不可用时（外壳没声明 shell.overlay），
				// 方案页的「编辑」会点了没反应，所以这里再挂一份。两处同时最多存在一份
				// （overlaySeatLive 为真时只挂浮层那份，不会出现两个弹窗）。
				overlaySeatLive ? null : e(PlanEditorDialog)
			);
		}
		//#endregion

		//#region 确认弹窗
		/**
		 * 危险操作前的确认弹窗。
		 *
		 * 弹窗挂在 shell.overlay 那一层（谁触发的都能盖在最上面），用 Promise 把用户的选择
		 * 交回调用处：`if (await requestConfirm({...})) 真正动手()`。万一浮层席位不可用
		 * （外壳没声明 shell.overlay），就退回系统原生 confirm，保证「有确认」这件事不静默失效。
		 */
		const confirmState = { current: null, seq: 0, listeners: new Set() };

		function notifyConfirm() {
			for (const listener of [...confirmState.listeners]) {
				try {
					listener();
				} catch (error) {
					// 单个订阅者出错不影响其他人
				}
			}
		}

		/** 问一句再动手；只有 resolve(true) 才继续。 */
		function requestConfirm(options) {
			const opts = options ?? {};
			if (confirmState.listeners.size === 0) {
				try {
					if (typeof window !== "undefined" && typeof window.confirm === "function") {
						return Promise.resolve(window.confirm([opts.title, opts.body].filter(Boolean).join("\n\n")));
					}
				} catch (error) {
					// 原生 confirm 被禁用时按「没确认」处理
				}
				return Promise.resolve(false);
			}
			return new Promise((resolve) => {
				confirmState.seq += 1;
				confirmState.current = { ...opts, id: confirmState.seq, resolve };
				notifyConfirm();
			});
		}

		/** 关掉当前弹窗：ok = true 表示点了确认。 */
		function closeConfirm(ok) {
			const current = confirmState.current;
			confirmState.current = null;
			notifyConfirm();
			if (current && typeof current.resolve === "function") current.resolve(ok === true);
		}

		/** 先确认再执行；取消就什么都不做。 */
		function runConfirm(options, action) {
			return requestConfirm(options).then((ok) => {
				if (ok && typeof action === "function") action();
				return ok;
			});
		}

		function useConfirmState() {
			const [, force] = useState(0);
			useEffect(() => {
				const listener = () => force((value) => value + 1);
				confirmState.listeners.add(listener);
				return () => confirmState.listeners.delete(listener);
			}, []);
			return confirmState.current;
		}

		/** 确认弹窗本体；没有待确认的请求时什么也不渲染。 */
		function ConfirmDialog() {
			const current = useConfirmState();
			useEffect(() => {
				if (!current) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") closeConfirm(false);
					else if (event.key === "Enter") closeConfirm(true);
				};
				try {
					window.addEventListener("keydown", onKey);
					return () => window.removeEventListener("keydown", onKey);
				} catch (error) {
					return () => {};
				}
			});
			if (!current) return null;
			return e(
				"div",
				{ style: S.confirmLayer, role: "dialog", "aria-modal": "true", "data-dsh-plugin": "health-reminder" },
				e("div", { style: S.confirmBackdrop, onClick: () => closeConfirm(false), "aria-hidden": "true" }),
				e(
					"div",
					{ style: S.confirmCard },
					e("div", { style: { fontWeight: 600, marginBottom: current.body ? 6 : 14 } }, current.title ?? "确认执行？"),
					current.body ? e("div", { style: { ...S.hint, marginBottom: 14 } }, current.body) : null,
					e(
						"div",
						{ style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
						e("button", { style: S.btnSmall, onClick: () => closeConfirm(false) }, current.cancelText ?? "取消"),
						e("button", { style: current.danger === false ? S.btnPrimary : S.btnDanger, onClick: () => closeConfirm(true) }, current.confirmText ?? "确认")
					)
				)
			);
		}
		//#endregion

		//#region 方案编辑弹窗
		/**
		 * 「方案」页里的「编辑」：就地改一份方案记下的作息、每类参数与提醒方式。
		 *
		 * 和确认弹窗一样挂在 shell.overlay 那一层（模块级状态 + 订阅，不依赖打开它的组件还在不在），
		 * 编辑的是一份**草稿**：只有点「保存」才写回方案，点「取消」/Esc/点背景就丢掉。
		 * 如果编辑的正好是当前方案，保存后也立刻作用到当前设置（统计不动），
		 * 这样「管理方案」和「改当前设置」不会各留一半。
		 */
		const planEditState = { current: null, seq: 0, listeners: new Set() };

		function notifyPlanEdit() {
			for (const listener of [...planEditState.listeners]) {
				try {
					listener();
				} catch (error) {
					// 单个订阅者出错不影响其他人
				}
			}
		}

		/** 当前编辑中的草稿（拷贝一份，外部改动不会串进弹窗）；没在编辑时为 null。 */
		function planEditorOf() {
			const current = planEditState.current;
			return current ? { id: current.id, name: current.name, active: current.active, draft: clone(current.draft) } : null;
		}

		/** 打开某份方案的编辑弹窗；方案不存在时返回 false。 */
		function openPlanEditor(id) {
			const state = store.get();
			const plan = planById(state, id);
			if (!plan) return false;
			planEditState.seq += 1;
			planEditState.current = {
				seq: planEditState.seq,
				id: plan.id,
				name: plan.name,
				active: state.activePlanId === plan.id,
				draft: planConfigOf(plan.settings)
			};
			notifyPlanEdit();
			return true;
		}

		/** 关掉弹窗（丢掉草稿）；没在编辑时返回 false。 */
		function closePlanEditor() {
			if (planEditState.current === null) return false;
			planEditState.current = null;
			notifyPlanEdit();
			return true;
		}

		/** 改草稿：顶层字段（作息、午休、提醒方式…）与名字。 */
		function patchPlanEditor(patch) {
			const current = planEditState.current;
			if (!current) return false;
			const next = { ...(patch ?? {}) };
			if (typeof next.name === "string") {
				// 上限和落库时的 planNameOf 一致：别让用户先打到 40 个字、保存时再被无声截到 24 个。
				current.name = next.name.slice(0, PLAN_NAME_MAX);
				delete next.name;
			}
			if (Object.keys(next).length > 0) current.draft = normalizeSettings({ ...current.draft, ...next });
			notifyPlanEdit();
			return true;
		}

		/** 改草稿：某一类提醒的参数。 */
		function patchPlanEditorKind(kind, patch) {
			const current = planEditState.current;
			if (!current) return false;
			const config = current.draft.kinds?.[kind];
			if (!config) return false;
			current.draft = normalizeSettings({ ...current.draft, kinds: { ...current.draft.kinds, [kind]: { ...config, ...(patch ?? {}) } } });
			notifyPlanEdit();
			return true;
		}

		/** 保存草稿：写回这份方案；它正好是当前方案时，同时把新配置作用到当前设置。 */
		function savePlanEditor() {
			const current = planEditState.current;
			if (!current) return false;
			const state = store.get();
			const plan = planById(state, current.id);
			planEditState.current = null;
			if (!plan) {
				notifyPlanEdit();
				return false;
			}
			const name = planNameOf(current.name, defaultPlanName(current.draft));
			const settings = planConfigOf(current.draft);
			store.set({
				...state,
				plans: state.plans.map((item) => (item.id === plan.id ? { ...item, name, settings, updatedAt: Date.now() } : item))
			});
			if (state.activePlanId === plan.id) applyPlan({ settings });
			notifyPlanEdit();
			return true;
		}

		function usePlanEditState() {
			const [, force] = useState(0);
			useEffect(() => {
				const listener = () => force((value) => value + 1);
				planEditState.listeners.add(listener);
				return () => planEditState.listeners.delete(listener);
			}, []);
			return planEditState.current;
		}

		/** 方案编辑弹窗本体；没在编辑时什么也不渲染。 */
		function PlanEditorDialog() {
			const current = usePlanEditState();
			useEffect(() => {
				if (!current) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") closePlanEditor();
				};
				try {
					window.addEventListener("keydown", onKey);
					return () => window.removeEventListener("keydown", onKey);
				} catch (error) {
					return () => {};
				}
			});
			if (!current) return null;
			const draft = current.draft;
			const toggleDay = (iso) => {
				const has = draft.workdays.includes(iso);
				const next = has ? draft.workdays.filter((day) => day !== iso) : [...draft.workdays, iso].sort((a, b) => a - b);
				if (next.length > 0) patchPlanEditor({ workdays: next });
			};
			const timeInput = (value, onChange) =>
				e("input", {
					type: "time",
					value: value,
					style: S.timeInput,
					onChange: (ev) => {
						if (parseHM(ev.target.value) !== null) onChange(ev.target.value);
					}
				});
			return e(
				"div",
				{ style: S.confirmLayer, role: "dialog", "aria-modal": "true", "data-dsh-plugin": "health-reminder" },
				e("div", { style: S.confirmBackdrop, onClick: () => closePlanEditor(), "aria-hidden": "true" }),
				e(
					"div",
					{ style: S.dialogCard },
					e("div", { style: { fontWeight: 600, fontSize: 14 } }, `编辑「${planNameOf(current.name, "未命名方案")}」`),
					e("div", { style: { ...S.hint, margin: "4px 0 8px" } }, current.active ? "这份正在使用：保存后会立刻作用到当前设置（统计不动）。" : "只改这份方案记下的配置，当前设置和统计都不受影响。"),
					e(Field, { label: "方案名字" }, e("input", { style: { ...S.input, width: 220 }, value: current.name, onChange: (ev) => patchPlanEditor({ name: ev.target.value }) })),
					e(
						Field,
						{ label: "上班日", hint: "至少要留一个上班日；取消最后一个不会生效。" },
						WEEKDAYS.map((iso) => {
							const on = draft.workdays.includes(iso);
							const last = on && draft.workdays.length === 1;
							return e(
								"button",
								{
									key: iso,
									style: last ? { ...S.chipOn, cursor: "default", opacity: 0.8 } : on ? S.chipOn : S.chip,
									title: last ? "至少要留一个上班日" : undefined,
									onClick: () => toggleDay(iso)
								},
								WEEKDAY_LABELS[iso]
							);
						})
					),
					e(Field, { label: "上班 / 下班时间" }, timeInput(draft.dayStart, (value) => patchPlanEditor({ dayStart: value })), e("span", { style: S.hint }, "到"), timeInput(draft.dayEnd, (value) => patchPlanEditor({ dayEnd: value }))),
					e(
						Field,
						{ label: "午休（不提醒）" },
						e(Toggle, { checked: draft.lunchEnabled, onChange: (value) => patchPlanEditor({ lunchEnabled: value }), label: "启用" }),
						timeInput(draft.lunchStart, (value) => patchPlanEditor({ lunchStart: value })),
						e("span", { style: S.hint }, "到"),
						timeInput(draft.lunchEnd, (value) => patchPlanEditor({ lunchEnd: value }))
					),
					KIND_DEFS.map((def) => {
						const config = draft.kinds[def.id];
						return e(
							"div",
							{ key: def.id, style: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.line}` } },
							e("div", { style: { fontSize: 12.5, fontWeight: 600, color: T.fg } }, `${def.icon} ${def.label}`),
							e(Field, { label: "启用" }, e(Toggle, { checked: config.on, onChange: (value) => patchPlanEditorKind(def.id, { on: value }) })),
							e(Field, { label: "提醒间隔" }, e(NumberField, { value: config.intervalMin, min: 5, max: 240, suffix: "分钟", onChange: (value) => patchPlanEditorKind(def.id, { intervalMin: value }) })),
							def.extra === "glassMl"
								? e(Field, { label: "每杯容量" }, e(NumberField, { value: config.glassMl ?? 250, min: 100, max: 800, suffix: "ml", onChange: (value) => patchPlanEditorKind(def.id, { glassMl: value }) }))
								: null,
							def.extra === "minutes"
								? e(Field, { label: "每次活动时长" }, e(NumberField, { value: config.minutes ?? 3, min: 1, max: 30, suffix: "分钟", onChange: (value) => patchPlanEditorKind(def.id, { minutes: value }) }))
								: null,
							e(Field, { label: "每日目标" }, e(NumberField, { value: config.target, min: 1, max: def.maxTarget, suffix: def.unit, onChange: (value) => patchPlanEditorKind(def.id, { target: value }) }))
						);
					}),
					e(
						"div",
						{ style: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.line}` } },
						e("div", { style: { fontSize: 12.5, fontWeight: 600, color: T.fg } }, "提醒方式"),
						e(Field, { label: "系统通知" }, e(Toggle, { checked: draft.notify.system, onChange: (value) => patchPlanEditor({ notify: { ...draft.notify, system: value } }) })),
						e(Field, { label: "应用内提示卡" }, e(Toggle, { checked: draft.notify.inApp, onChange: (value) => patchPlanEditor({ notify: { ...draft.notify, inApp: value } }) })),
						e(Field, { label: "提示音" }, e(Toggle, { checked: draft.notify.sound, onChange: (value) => patchPlanEditor({ notify: { ...draft.notify, sound: value } }) })),
						// 音色 / 音量 / 全屏静音 / 免打扰也在方案快照里（方案=整套配置），但它们是「机器上的偏好」，
						// 留在设置页改——这里说清楚，免得用户以为应用方案会绕过它们。
						e("div", { style: { ...S.hint, marginTop: 4 } }, "音色、音量、全屏静音与免打扰也随方案保存；它们在本插件的设置页里调整，再「保存到方案」更新这份快照。")
					),
					e(
						"div",
						{ style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
						e("button", { style: S.btnSmall, onClick: () => closePlanEditor() }, "取消"),
						e("button", { style: S.btnPrimary, onClick: () => savePlanEditor() }, "保存")
					)
				)
			);
		}
		//#endregion

		//#region 注册诊断
		/**
		 * 诊断记录键。
		 *
		 * 席位由外壳插件声明：席位名不存在时，`slots.inject` 的回调**永远不会被调用**，
		 * 插件表面上看只是"少了一个入口"，控制台也不会有错误。为了能在不看 F12 的
		 * 情况下判断到底哪一步没成，这里把每个席位的三个时刻写进 localStorage：
		 * `injectedAt`（已向席位注册）、`declaredAt`（外壳声明了该席位并调用了回调）、
		 * `paintedAt`（组件真的被渲染过）；出错则记进 `errors`。
		 */
		const DIAG_KEY = "dsh-health-reminder/diag.v1";

		/** 记一条诊断；best-effort，任何异常都不影响插件。 */
		function recordDiag(patch) {
			try {
				const raw = localStorage.getItem(DIAG_KEY);
				const prev = raw ? JSON.parse(raw) : {};
				const seats = { ...(prev.seats ?? {}) };
				const seatName = patch.seat;
				if (seatName) seats[seatName] = { ...(seats[seatName] ?? {}), ...patch };
				const errors = Array.isArray(prev.errors) ? prev.errors.slice(-7) : [];
				if (patch.error !== undefined && patch.error !== null) {
					errors.push({ at: Date.now(), seat: seatName ?? null, message: String(patch.error?.message ?? patch.error) });
				}
				const next = { ...prev, ...patch, seats, errors, updatedAt: Date.now() };
				delete next.error;
				localStorage.setItem(DIAG_KEY, JSON.stringify(next));
			} catch {
				/* 诊断失败不影响功能 */
			}
		}

		/** 已经记过首次渲染的席位，避免每秒 tick 都写一次 localStorage。 */
		const paintedSeats = new Set();

		/** 记一次"这个席位的组件真的渲染了"。 */
		function notePaint(seatName) {
			if (paintedSeats.has(seatName)) return;
			paintedSeats.add(seatName);
			recordDiag({ seat: seatName, paintedAt: Date.now() });
		}
		//#endregion

		//#region 会话命令
		/**
		 * 贡献给 `/` 命令菜单的命令。只有一条：打开面板的今日小结
		 * （命令行的结果不写进会话日志，所以这里不做「把小结发进对话」，
		 * 需要讨论时用面板里的「复制今日小结」把文本贴进输入框）。
		 */
		function commandContributions() {
			return [
				{
					name: "health",
					available: () => true,
					label: () => "健康提醒：打开今日小结",
					description: () => "打开健康提醒面板，查看今日进度并复制小结",
					ui: {
						kind: "action",
						run: () => openHealthFromCommand()
					}
				}
			];
		}

		/** `/健康` 的动作：切到插件面板，并把底部快捷卡片展开。 */
		function openHealthFromCommand() {
			selectPanel();
			setDockOpen(true);
		}
		//#endregion

		//#region 插件导出
		const name = "dsh-health-reminder";
		/** 需要的客户端服务：席位注册（slots）、本地化（locale）、面板切换（layout）。 */
		const inject = ["slots", "locale", "layout"];

		let clientCtx = null;
		/** shell.overlay 席位是否可用（可用时全局横幅由它渲染，面板内不再重复）。 */
		let overlaySeatLive = false;

		/** 切到本插件的面板（通知被点击时用）。 */
		function selectPanel() {
			try {
				const layout = clientCtx?.get?.("layout");
				if (typeof layout?.selectPanel === "function") layout.selectPanel(PANEL_ID);
			} catch (error) {
				console.warn("[health-reminder] 切换面板失败:", error);
			}
		}

		/**
		 * 插件入口：注册侧边栏图标、主面板页、输入区底部入口、设置页，以及全局浮层
		 * （提醒横幅 / 展开卡），并启动每秒调度。
		 *
		 * 每个席位都单独 try/catch：DSH 的席位由外壳插件声明，缺失时只应让这个
		 * 插件安静地少一个入口，绝不能把整个 Web 外壳拖坏。
		 *
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			clientCtx = ctx;
			paintedSeats.clear();
			recordDiag({
				applyAt: Date.now(),
				version: "0.5.2",
				inject: inject.slice(),
				slotsInject: typeof ctx?.slots?.inject,
				slotsRegister: typeof ctx?.slots?.register,
				href: (() => {
					try {
						return String(window.location.href);
					} catch {
						return "";
					}
				})()
			});
			try {
				const slots = ctx?.slots;
				if (slots && typeof slots.inject === "function") {
					const disposers = [];
					const seat = (slotName, makeRegister) => {
						try {
							disposers.push(
								slots.inject(slotName, () => {
									recordDiag({ seat: slotName, declaredAt: Date.now() });
									try {
										return makeRegister();
									} catch (error) {
										console.warn(`[health-reminder] 注册席位 ${slotName} 失败:`, error);
										recordDiag({ seat: slotName, error });
										throw error;
									}
								})
							);
							recordDiag({ seat: slotName, injectedAt: Date.now() });
						} catch (error) {
							console.warn(`[health-reminder] 注册席位 ${slotName} 失败:`, error);
							recordDiag({ seat: slotName, injectedAt: null, error });
						}
					};
					seat("sidebar.panellist", () =>
						slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: "健康提醒" }, HealthIcon)
					);
					seat("main", () => slots.register({ name: "main", key: PANEL_ID, inject: () => ({ panelId: PANEL_ID }) }, HealthPanelPage));
					// 输入区底部那一行（和轮次/消耗那些条目并排）：图标 + 文字，点击展开。
					seat("conversation.composer.dock", () =>
						slots.register({ name: "conversation.composer.dock", id: `${PANEL_ID}-dock`, order: 20, label: "健康提醒" }, DockEntry)
					);
					// 设置界面里的一页。
					seat("settings.section", () =>
						slots.register({ name: "settings.section", id: PANEL_ID, order: 60, label: "健康提醒" }, HealthSettingsSection)
					);
					try {
						disposers.push(
							slots.inject("shell.overlay", () => {
								overlaySeatLive = true;
								recordDiag({ seat: "shell.overlay", declaredAt: Date.now() });
								return slots.register({ name: "shell.overlay", id: `${PANEL_ID}-banner`, order: 60 }, OverlaySeat);
							})
						);
						recordDiag({ seat: "shell.overlay", injectedAt: Date.now() });
					} catch (error) {
						console.warn("[health-reminder] 注册席位 shell.overlay 失败（改为面板内提示）:", error);
						recordDiag({ seat: "shell.overlay", injectedAt: null, error });
					}
					ctx.effect(
						() => () => {
							overlaySeatLive = false;
							for (const dispose of disposers.splice(0)) {
								try {
									dispose();
								} catch (error) {
									console.warn("[health-reminder] 释放席位失败:", error);
								}
							}
						},
						"health-reminder: ui mounts"
					);
				} else {
					// 席位服务都没有的话，插件一个入口都露不出来；这里至少留一条明确日志 + 诊断，
					// 免得用户看到的只是「什么都没发生」。
					console.warn("[health-reminder] 外壳没提供 slots.inject 服务，所有入口都不会出现。");
					recordDiag({ seats: "unavailable", slotsInject: typeof ctx?.slots?.inject });
				}
			} catch (error) {
				console.warn("[health-reminder] 席位注册失败:", error);
			}

			try {
				ctx.effect(() => {
					const now = Date.now();
					ensureRuntimeNow(now);
					tick(now);
					const timer = setInterval(() => tick(Date.now()), TICK_MS);
					return () => clearInterval(timer);
				}, "health-reminder: scheduler");
			} catch (error) {
				console.warn("[health-reminder] 调度器启动失败:", error);
			}

			try {
				ctx.effect(() => {
					const commandUi = ctx?.commandUi;
					if (!commandUi || typeof commandUi.register !== "function") {
						recordDiag({ commands: "unavailable" });
						return () => {};
					}
					const disposers = [];
					for (const contribution of commandContributions()) {
						try {
							disposers.push(commandUi.register(contribution));
							recordDiag({ command: contribution.name, registeredAt: Date.now() });
						} catch (error) {
							console.warn(`[health-reminder] 注册命令 /${contribution.name} 失败:`, error);
							recordDiag({ command: contribution.name, error });
						}
					}
					return () => {
						for (const dispose of disposers.splice(0)) {
							try {
								dispose();
							} catch (error) {
								console.warn("[health-reminder] 释放命令失败:", error);
							}
						}
					};
				}, "health-reminder: commands");
			} catch (error) {
				console.warn("[health-reminder] 命令注册失败:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.__test = {
			PANEL_ID,
			DIAG_KEY,
			/** 自测用：把诊断记录读回来（浏览器里出问题时也能用它取现场）。 */
			readDiag: () => {
				try {
					return JSON.parse(localStorage.getItem(DIAG_KEY) ?? "null");
				} catch {
					return null;
				}
			},
			recordDiag,
			DEFAULT_SETTINGS,
			KIND_DEFS,
			KIND_IDS,
			kindDef,
			kindCfg,
			kindEnabled,
			kindTarget,
			kindColor,
			activeKinds,
			TIPS,
			TONES,
			TONE_IDS,
			isFullscreenActive,
			playBeep,
			notifySystem,
			announce,
			commandContributions,
			summaryText,
			recordCount,
			runtimeDiffers,
			clone,
			clamp,
			dayKey,
			isoDay,
			hm,
			parseHM,
			inWindow,
			normalizeSettings,
			inSchedule,
			isAllowed,
			nextAllowedAt,
			daySlots,
			nextSlotAt,
			lastSlotAt,
			nextAtFor,
			migrateRuntime,
			styles: S,
			windowMinutes,
			estimate,
			store,
			freshRuntime,
			defaultState,
			ensureRuntime,
			computeDue,
			tick,
			fireNow,
			updateSettings,
			updateKind,
			completeKind,
			skipKind,
			snoozeKind,
			muteKindToday,
			recordOn,
			isDayMet,
			streakOf,
			lastDays,
			reportOf,
			buildExport,
			parseImport,
			importSummary,
			mergeImport,
			csvOf,
			stampFilename,
			EXPORT_SCHEMA,
			EXPORT_VERSION,
			planConfigOf,
			planKey,
			planNameOf,
			defaultPlanName,
			normalizePlans,
			planById,
			activePlanOf,
			planDrifted,
			seedPlan,
			savePlan,
			applyPlanById,
			renamePlan,
			duplicatePlan,
			removePlan,
			revertToActivePlan,
			planLines,
			applyPlan,
			openPlanEditor,
			closePlanEditor,
			savePlanEditor,
			patchPlanEditor,
			patchPlanEditorKind,
			planEditorOf,
			PLAN_NAME_MAX,
			reminderCopy,
			humanDuration,
			shortNext,
			setDockOpen,
			isDockOpen: () => dockOpen,
			requestConfirm,
			runConfirm,
			closeConfirm,
			isConfirmOpen: () => confirmState.current !== null
		};
		//#endregion

		return module.exports;
	}
});
