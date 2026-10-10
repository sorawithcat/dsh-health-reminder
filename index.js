/**
 * dsh-health-reminder · 宿主半区
 *
 * 提醒、统计、方案都跑在浏览器半区（席位注入的 client.js，数据也只存在浏览器本地），
 * 宿主这一边只留一个只读探针：`GET /health-reminder/status`。
 *
 * 它不加载模型、不读用户数据，只回答两件事：
 * 宿主半区装的是哪个版本、客户端半区是不是也该跟着刷新了。
 * 判断「插件有没有随桌面端重启生效」时，先戳这个路由就够了。
 */
export const name = "dsh-health-reminder";

/** 只需要 webServer：宿主半区不碰模型、连接和任何用户数据。 */
export const inject = ["webServer"];

/** 只读探针的路径。 */
const STATUS_PATH = "/health-reminder/status";

/** 版本号；测试会拿它和 package.json 比对，两边必须一致。 */
const VERSION = "0.5.3";

/**
 * 回一个 JSON 响应。
 *
 * @param res - 宿主响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 会被 JSON 序列化的内容。
 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(body);
}

/**
 * 挂载宿主半区：注册一条只读路由，并留一行日志方便确认插件行确实被加载了。
 *
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
	try {
		ctx?.logger?.info?.(`[health-reminder] 宿主半区已挂载（v${VERSION}，只读探针 ${STATUS_PATH}）`);
	} catch {
		/* 日志失败不影响插件可用性 */
	}

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: STATUS_PATH,
				handler: (req, res) => {
					if (req.method !== "GET" && req.method !== "HEAD") {
						res.setHeader("allow", "GET, HEAD");
						sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", message: "只支持 GET" });
						return;
					}
					sendJson(res, 200, { ok: true, name, version: VERSION, client: "web" });
				}
			}),
		`health-reminder: GET ${STATUS_PATH}`
	);
}

/** 供自测使用的内部常量与纯函数。 */
export const internals = { STATUS_PATH, VERSION, sendJson };
