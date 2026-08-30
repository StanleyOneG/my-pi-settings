import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	SettingsManager,
	type ExtensionAPI,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

// Keep one decimal place for occupied context, as in "13.8K".
function formatContextTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}K`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function addUsage(totals: Totals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export default function contextTokensFooter(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const autoCompactEnabled = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionEnabled();

		ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const totals: Totals = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
					};
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = entry.message.usage;
							addUsage(totals, usage);
							const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.usage
						) {
							addUsage(totals, entry.message.usage);
						} else if (
							(entry.type === "branch_summary" || entry.type === "compaction") &&
							entry.usage
						) {
							addUsage(totals, entry.usage);
						}
					}

					const model = ctx.model;
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent == null ? "?" : contextPercentValue.toFixed(1);
					const occupiedTokens =
						contextUsage?.tokens == null ? "?" : formatContextTokens(contextUsage.tokens);

					let pwd = formatCwd(
						ctx.sessionManager.getCwd(),
						process.env.HOME || process.env.USERPROFILE,
					);
					const branch = footerData.getGitBranch();
					if (branch) pwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;

					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if (
						(totals.cacheRead > 0 || totals.cacheWrite > 0) &&
						latestCacheHitRate !== undefined
					) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}

					const provider = model ? ctx.modelRegistry.getProvider(model.provider) : undefined;
					const usingSubscription =
						model?.provider === "kimi-coding" ||
						(model !== undefined &&
							ctx.modelRegistry.isUsingOAuth(model) &&
							provider?.auth?.oauth?.isSubscription === true);
					if (totals.cost || usingSubscription) {
						statsParts.push(
							`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
						);
					}

					const autoIndicator = autoCompactEnabled ? " (auto)" : "";
					const contextDisplay = `${
						contextPercent === "?" ? "?" : `${contextPercent}%`
					}/${formatTokens(contextWindow)}${autoIndicator} | ${occupiedTokens}`;
					const coloredContext =
						contextPercentValue > 90
							? theme.fg("error", contextDisplay)
							: contextPercentValue > 70
								? theme.fg("warning", contextDisplay)
								: contextDisplay;
					statsParts.push(coloredContext);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = model?.id ?? "no-model";
					let rightWithoutProvider = modelName;
					if (model?.reasoning) {
						const thinking = ctx.thinkingLevel ?? "off";
						rightWithoutProvider =
							thinking === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinking}`;
					}

					const minPadding = 2;
					let right = rightWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && model) {
						const withProvider = `(${model.provider}) ${rightWithoutProvider}`;
						if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
							right = withProvider;
						}
					}

					const rightWidth = visibleWidth(right);
					let statsLine: string;
					if (statsLeftWidth + minPadding + rightWidth <= width) {
						statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + right;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(right, availableForRight, "");
							statsLine =
								statsLeft +
								" ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
								truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const remainder = statsLine.slice(statsLeft.length);
					const lines = [
						truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
						theme.fg("dim", statsLeft) + theme.fg("dim", remainder),
					];

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatus(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
