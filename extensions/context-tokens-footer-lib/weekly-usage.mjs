import { createRequire } from "node:module";
import { join } from "node:path";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// Poll every 5min by default; use Codex CLI's 30/15/5s tiers only below
// 20% weekly remaining. Schedule after completion, back off on errors.
export const TTL_MS = 5 * 60 * 1000;
export const TIMEOUT_MS = 15_000;

function weeklyUsageIntervalMs(remainingPercent, baselineMs) {
	// Compare raw quota, not the rounded footer label; 20% stays on baseline.
	if (remainingPercent <= 1) return 5_000;
	if (remainingPercent <= 10) return 15_000;
	if (remainingPercent < 20) return 30_000;
	return baselineMs;
}

export function parseWeeklyUsage(body) {
	const windows = body?.rate_limit;
	const candidates = [windows?.primary_window, windows?.secondary_window]
		.filter((window) => typeof window?.limit_window_seconds === "number" &&
			Math.abs(window.limit_window_seconds - 604800) <= 604800 * 0.05);
	// Ambiguous windows are not a trustworthy weekly quota.
	if (candidates.length !== 1) return undefined;
	const window = candidates[0];
	if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return undefined;
	const resetMs = typeof window.reset_at === "number" ? window.reset_at * 1000 : NaN;
	return {
		remainingPercent: Math.max(0, Math.min(100, 100 - window.used_percent)),
		resetAt: Number.isFinite(resetMs) && resetMs > 0 && resetMs <= 8.64e15 ? resetMs : undefined,
	};
}

export function accountIdFromToken(token) {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : undefined;
	} catch { return undefined; }
}

export function selectProxy(env) {
	for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
		if (env[key]?.trim()) {
			// Undici ProxyAgent supports HTTP(S) proxies, not SOCKS. Never silently go direct.
			let url;
			try { url = new URL(env[key]); } catch { throw new Error("Usage proxy configuration unavailable"); }
			if (!["http:", "https:"].includes(url.protocol)) throw new Error("Usage proxy configuration unavailable");
			return env[key];
		}
	}
	return undefined;
}

export function loadUndici(packageDir) {
	// Pi aliases its public API for extensions, but not undici. Resolve from the
	// running Pi installation, not the extension directory or a hardcoded global path.
	return createRequire(join(packageDir, "package.json"))("undici");
}

export async function requestWeeklyUsage({ token, accountId, signal, packageDir }, {
	env = process.env, undici, timeoutMs = TIMEOUT_MS,
} = {}) {
	let dispatcher;
	try {
		const proxy = selectProxy(env);
		const transport = undici ?? loadUndici(packageDir);
		if (proxy) dispatcher = new transport.ProxyAgent({ uri: proxy });
		const response = await transport.fetch(USAGE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": accountId, Accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			...(dispatcher ? { dispatcher } : {}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Usage unavailable");
		}
		const usage = parseWeeklyUsage(await response.json());
		if (!usage) throw new Error("Usage unavailable");
		return usage;
	} catch {
		// Never propagate server bodies, JWTs, account IDs, proxy URLs or transport errors.
		throw new Error("Usage unavailable");
	} finally {
		if (dispatcher) await dispatcher.destroy().catch(() => {});
	}
}

export function isCodexOAuth(ctx) {
	return ctx.model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(ctx.model);
}

export class WeeklyUsageCache {
	constructor({ packageDir, onChange, request = requestWeeklyUsage, now = Date.now, ttlMs = TTL_MS }) {
		this.packageDir = packageDir;
		this.onChange = onChange;
		this.request = request;
		this.now = now;
		this.ttlMs = ttlMs;
		this.generation = 0;
	}

	start(ctx) {
		this.dispose();
		this.active = true;
		this.ctx = ctx;
		void this.refresh();
	}

	select(ctx) {
		if (!this.active) return;
		this.generation++;
		this.controller?.abort();
		this.ctx = ctx;
		this.cached = undefined;
		this.nextAttempt = undefined;
		this.failures = 0;
		clearTimeout(this.timer);
		this.onChange();
		void this.refresh();
	}

	label(ctx) {
		if (!this.active || !isCodexOAuth(ctx)) return "";
		if (ctx.model !== this.ctx?.model || ctx.modelRegistry !== this.ctx?.modelRegistry) return " | usage weekly: unavailable";
		const fresh = this.cached && this.now() - this.cached.at < weeklyUsageIntervalMs(this.cached.remainingPercent, this.ttlMs) &&
			(this.cached.resetAt === undefined || this.now() < this.cached.resetAt);
		return fresh ? ` | usage weekly: ${Math.round(this.cached.remainingPercent)}% left` : " | usage weekly: unavailable";
	}

	async refresh() {
		if (!this.active || this.busy) return;
		const ctx = this.ctx;
		if (!isCodexOAuth(ctx)) {
			this.cached = undefined;
			return;
		}
		if (this.nextAttempt !== undefined && this.now() < this.nextAttempt) return;
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		this.busy = true;
		// Clear before resolving auth: an account change must not inherit cached quota.
		this.cached = undefined;
		this.onChange();
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!this.active || generation !== this.generation || controller.signal.aborted) return;
			if (!isCodexOAuth(ctx) || !auth.ok || !auth.apiKey) throw new Error("Usage unavailable");
			const accountId = accountIdFromToken(auth.apiKey);
			if (!accountId) throw new Error("Usage unavailable");
			const usage = await this.request({ token: auth.apiKey, accountId, signal: controller.signal, packageDir: this.packageDir });
			if (this.active && generation === this.generation && !controller.signal.aborted && isCodexOAuth(ctx)) {
				this.cached = { ...usage, at: this.now() };
				this.failures = 0;
			}
		} catch {
			if (generation === this.generation) {
				this.cached = undefined;
				this.failures = Math.min(4, (this.failures ?? 0) + 1);
			}
		} finally {
			this.busy = false;
			if (this.controller === controller) this.controller = undefined;
			if (this.active) {
				this.onChange();
				if (generation !== this.generation) void this.refresh();
				else {
					const delay = this.failures
						? Math.min(30 * 60_000, TTL_MS * 2 ** (this.failures - 1))
						: weeklyUsageIntervalMs(this.cached?.remainingPercent, this.ttlMs);
					this.nextAttempt = this.now() + delay;
					clearTimeout(this.timer);
					this.timer = setTimeout(() => { void this.refresh(); }, delay);
					this.timer.unref?.();
				}
			}
		}
	}

	dispose() {
		this.active = false;
		this.generation++;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.controller?.abort();
		this.ctx = undefined;
		this.cached = undefined;
		this.nextAttempt = undefined;
		this.failures = 0;
	}
}
