/**
 * GLM Coding Plan balance plugin.
 *
 * Host half:
 * - registers the `glm_balance` tool;
 * - serves same-origin `GET /api/glm-balance/quota` on the Harness web server
 *   (with a short in-memory cache) for the Client status widget.
 *
 * Data source: Zhipu BigModel (or Z.ai) coding-plan monitor endpoints.
 */

const TOOL_NAME = "glm_balance";
const ROUTE_PATH = "/api/glm-balance/quota";
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_POLL_MS = 5 * 60 * 1000;

/** Services used by this plugin. */
export const inject = ["tools", "credentials", "webServer"];

const UNIT_LABELS = {
	// Observed on the official monitor endpoint; label by semantics, keep the
	// raw pair available so unknown variants still make sense.
	"3:5": "每 5 小时额度 (5-hour window)",
	"6:1": "每周额度 (weekly)",
};

function unitKey(limit) {
	return `${limit.unit}:${limit.number}`;
}

function describeWindow(limit) {
	if (limit.type === "TIME_LIMIT") {
		return "工具调用额度 (Tools / MCP calls)";
	}
	return UNIT_LABELS[unitKey(limit)] ?? `额度窗口 unit=${limit.unit} number=${limit.number}`;
}

function fmtTime(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
	const d = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}`
	);
}

function fmtPct(n) {
	return `${Math.round(n)}%`;
}

function fmtTokens(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

async function fetchJson(url, apiKey, signal) {
	const res = await fetch(url, {
		headers: {
			Authorization: apiKey,
			"Accept-Language": "zh-CN,zh,en-US,en",
			"Content-Type": "application/json",
		},
		signal,
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
	}
	if (!res.ok || body.success === false) {
		throw new Error(`${url} failed: HTTP ${res.status}, ${body.msg ?? "unknown error"}`);
	}
	return body;
}

function dayRangeLocal() {
	const pad = (n) => String(n).padStart(2, "0");
	const now = new Date();
	const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return { start: `${day} 00:00:00`, end: `${day} 23:59:59` };
}

/** Collect quota + today's model usage into one plain-JSON snapshot. */
async function collectSnapshot(cfg, signal) {
	const hit = await ctxRef.credentials.resolve(cfg.apiKeyRef);
	if (hit === undefined || !hit.value) {
		throw new Error(`未找到凭据 ${cfg.apiKeyRef}（GLM Coding Plan API Key）`);
	}
	const key = hit.value;

	const quotaBody = await fetchJson(
		`${cfg.baseURL}/api/monitor/usage/quota/limit`,
		key,
		signal,
	);
	const data = quotaBody.data ?? {};
	const limits = Array.isArray(data.limits) ? data.limits : [];

	// Today's model usage is best-effort: a failure here must not break the bar.
	let today = null;
	try {
		const { start, end } = dayRangeLocal();
		const usageBody = await fetchJson(
			`${cfg.baseURL}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
			key,
			signal,
		);
		const total = usageBody.data?.totalUsage;
		if (total) {
			today = {
				modelCalls: total.totalModelCallCount ?? null,
				tokens: total.totalTokensUsage ?? null,
			};
		}
	} catch {
		today = null;
	}

	return { level: data.level ?? null, limits, today, fetchedAt: Date.now() };
}

let ctxRef = null;
const snapshotCache = new Map(); // cfgKey -> { at, promise }

async function cachedSnapshot(cfg, signal) {
	const cfgKey = `${cfg.apiKeyRef}|${cfg.baseURL}`;
	const entry = snapshotCache.get(cfgKey);
	if (entry !== undefined && Date.now() - entry.at < cfg.cacheTtlMs) return entry.promise;
	const promise = collectSnapshot(cfg, signal).catch((error) => {
		snapshotCache.delete(cfgKey);
		throw error;
	});
	snapshotCache.set(cfgKey, { at: Date.now(), promise });
	return promise;
}

function renderSummary(snapshot) {
	const lines = [];
	lines.push(`GLM Coding Plan 余量（套餐等级：${snapshot.level ?? "unknown"}）`);
	lines.push("=".repeat(46));
	for (const limit of snapshot.limits) {
		lines.push(describeWindow(limit));
		const usedPct = limit.percentage ?? 0;
		const remainingPct = 100 - usedPct;
		if (limit.type === "TIME_LIMIT" && typeof limit.usage === "number") {
			lines.push(
				`  已用 ${limit.currentValue ?? limit.usage} / ${limit.usage} 次（剩余 ${limit.remaining ?? "?"}，约 ${remainingPct}% 可用）`,
			);
			if (Array.isArray(limit.usageDetails) && limit.usageDetails.length > 0) {
				const detail = limit.usageDetails
					.map((d) => `${d.modelCode}: ${d.usage}`)
					.join("、");
				lines.push(`  明细：${detail}`);
			}
		} else {
			lines.push(`  已用 ${fmtPct(usedPct)}，剩余 ${fmtPct(remainingPct)}`);
		}
		lines.push(`  重置时间：${fmtTime(limit.nextResetTime)}`);
		lines.push("");
	}
	if (snapshot.today) {
		lines.push(
			`今日模型调用：${snapshot.today.modelCalls ?? "?"} 次，消耗 ${fmtTokens(snapshot.today.tokens ?? 0)} tokens`,
		);
	}
	return lines.join("\n").trimEnd();
}

/** Register the tool and the status route for this composition. */
export function apply(ctx, config = {}) {
	ctxRef = ctx;
	const cfg = {
		apiKeyRef: config.apiKeyRef ?? "ZAI_CODING_CN_API_KEY",
		baseURL: (config.baseURL ?? "https://open.bigmodel.cn").replace(/\/+$/, ""),
		pollMs: clampInt(config.pollSeconds, 30, 3600, DEFAULT_POLL_MS / 1000) * 1000,
		cacheTtlMs: clampInt(config.cacheTtlSeconds, 5, 600, DEFAULT_CACHE_TTL_MS / 1000) * 1000,
	};

	const disposers = [];

	ctx.effect(() => {
		registerAll();
		return () => {
			for (const dispose of disposers.splice(0)) {
				try {
					dispose?.();
				} catch {
					// best-effort teardown
				}
			}
		};
	});

	function registerAll() {
		disposers.push(
			ctx.tools.register({
			name: TOOL_NAME,
			description:
				"查询 GLM Coding Plan（智谱 BigModel / Z.ai 订阅套餐）当前余量：每 5 小时额度、每周额度的已用百分比与重置时间，以及工具/MCP 调用量。无需参数，直接调用即可。Query the current GLM Coding Plan quota: 5-hour and weekly usage percentages, reset times, and tool/MCP call usage.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			output: {
				schema: {
					type: "object",
					properties: {
						summary: { type: "string" },
						level: { type: "string" },
						limits: { type: "array", items: { type: "object" } },
					},
					required: ["summary"],
					additionalProperties: true,
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			async execute(_args, exec) {
				const signal = exec?.signal ?? AbortSignal.timeout(20000);
				const snapshot = await cachedSnapshot(cfg, signal);
				return {
					summary: renderSummary(snapshot),
					level: snapshot.level ?? "unknown",
					limits: snapshot.limits,
				};
			},
		}),
	);

	try {
		disposers.push(
			ctx.webServer.register({
				kind: "exact",
				path: ROUTE_PATH,
				async handler(req, res) {
					try {
						const refresh = new URL(req.url ?? "/", "http://x").searchParams.get("refresh") === "1";
						if (refresh) snapshotCache.clear();
						const snapshot = await cachedSnapshot(cfg, AbortSignal.timeout(20000));
						res.writeHead(200, {
							"Content-Type": "application/json; charset=utf-8",
							"Access-Control-Allow-Origin": "*",
						});
						res.end(JSON.stringify({ ok: true, ...snapshot }));
					} catch (error) {
						res.writeHead(502, {
							"Content-Type": "application/json; charset=utf-8",
							"Access-Control-Allow-Origin": "*",
						});
						res.end(
							JSON.stringify({ ok: false, error: String(error?.message ?? error) }),
						);
					}
				},
			}),
		);
	} catch (error) {
		// A leftover registration from an earlier generation can collide; reuse it.
		const message = String(error?.message ?? error);
		if (!message.includes("duplicate")) throw error;
		ctx.logger?.warn?.(`glm-balance: reusing existing ${ROUTE_PATH} route`);
	}

	// Inline status bar injected into the app index HTML. This bypasses the
	// client-module registry entirely, so it renders on every page load.
	if (typeof ctx.webServer.tapIndex === "function") {
		try {
			disposers.push(
				ctx.webServer.tapIndex((html) => {
					const script = barScript(cfg.pollMs);
					return html.includes("</body>") ? html.replace("</body>", script + "</body>") : html + script;
				}),
			);
		} catch (error) {
			ctx.logger?.warn?.(`glm-balance: tapIndex unavailable: ${String(error?.message ?? error)}`);
		}
	}
	}
}

function barScript(pollMs) { return `<script data-glm-balance>(function(){
if (window.__glmBalanceBar) return; window.__glmBalanceBar = true;
var POLL = ${pollMs};
function fmtClock(ms){var d=new Date(ms),p=function(n){return String(n).padStart(2,'0')};return p(d.getHours())+':'+p(d.getMinutes());}
function fmtDay(ms){var d=new Date(ms),p=function(n){return String(n).padStart(2,'0')};return (d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());}
function fmtTok(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n);}
function col(p){return p>=90?'#e5484d':p>=70?'#f5a623':'#30a46c';}
var bar=document.createElement('div');
bar.dataset.glmBalanceBar='1';
bar.style.cssText='display:none;align-items:center;justify-content:center;flex-wrap:wrap;gap:10px;padding:2px 10px;border-radius:8px;font:11px/16px -apple-system,system-ui,sans-serif;color:var(--dsw-alias-label-secondary,rgba(140,140,140,.95));background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#1e1e20) 72%,transparent);backdrop-filter:blur(6px);border:1px solid var(--dsw-alias-border-l1,transparent);user-select:none;box-shadow:0 1px 6px rgba(0,0,0,.18);width:fit-content;margin:2px auto 0;';
document.documentElement.appendChild(bar);
function dockFollow(){
var dock=document.querySelector('[data-composer-dock]');
if(!dock||!dock.parentNode)return;
if(bar.nextSibling===dock)return;
if(bar.parentNode!==dock.parentNode||dock.parentNode.lastChild===bar&&bar.previousSibling!==dock)dock.parentNode.insertBefore(bar,dock.nextSibling);
}
var mo=new MutationObserver(function(){dockFollow();});
mo.observe(document.documentElement,{childList:true,subtree:true});
dockFollow();
function chip(label,pct,reset,long){return '<span title="'+label+'：已用 '+Math.round(pct)+'%，重置 '+long+'" style="white-space:nowrap">'+label+' <b style="color:'+col(pct)+'">'+Math.round(pct)+'%</b><span style="display:inline-block;width:34px;height:4px;border-radius:2px;background:rgba(128,128,128,.35);overflow:hidden;vertical-align:middle;margin-left:4px"><span style="display:block;height:100%;width:'+Math.min(100,Math.max(0,Math.round(pct)))+'%;background:'+col(pct)+';border-radius:2px"></span></span><span style="opacity:.75">'+reset+'</span></span>';}
function bindRefresh(){var el=bar.querySelector('#glm-bal-refresh');if(el)el.onclick=function(){el.textContent='\\u27f3';load(true);};}
function render(d){
bar.style.display='flex';
var html='<span style="font-weight:700;color:var(--dsw-alias-brand-primary,#4a9eda)">GLM '+String(d.level||'plan').toUpperCase()+'</span>';
var lim=d.limits||[];
for (var i=0;i<lim.length;i++){var L=lim[i];
 if(L.type==='TOKENS_LIMIT'&&L.unit===3)html+=chip('5h',L.percentage||0,fmtClock(L.nextResetTime),fmtDay(L.nextResetTime));
 else if(L.type==='TOKENS_LIMIT'&&L.unit===6)html+=chip('周',L.percentage||0,fmtDay(L.nextResetTime),fmtDay(L.nextResetTime));
 else if(L.type==='TIME_LIMIT'&&typeof L.usage==='number')html+='<span title="工具/MCP 调用：'+(L.currentValue||L.usage)+' / '+L.usage+'，重置 '+fmtDay(L.nextResetTime)+'">MCP '+(L.currentValue||L.usage)+'/'+L.usage+'</span>';}
if(d.today&&d.today.tokens!=null)html+='<span title="今日模型调用与 token 消耗">今日 '+(d.today.modelCalls!=null?d.today.modelCalls:'?')+'次 '+fmtTok(d.today.tokens)+'tok</span>';
html+='<span id="glm-bal-refresh" title="立即刷新" style="cursor:pointer;font-size:12px">\\u21bb</span>';
bar.innerHTML=html;bindRefresh();
}
function load(refresh){
fetch('/api/glm-balance/quota'+(refresh?'?refresh=1':''),{cache:'no-store'}).then(function(r){return r.json();}).then(function(b){
 if(b.ok){render(b);}else{bar.style.display='flex';bar.innerHTML='<span style="color:#f5a623">GLM</span><span title="'+String(b.error||'').replace(/"/g,'')+'">余额获取失败</span><span id="glm-bal-refresh" style="cursor:pointer">\\u21bb</span>';bindRefresh();}
}).catch(function(){bar.style.display='flex';bar.innerHTML='<span style="color:#f5a623">GLM 余额获取失败</span>';});}
load(false);setInterval(function(){load(false);},POLL);
})();</script>`; }
