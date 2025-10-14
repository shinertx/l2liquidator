#!/usr/bin/env node
/**
 * Aggregates structured log files (JSON lines) into a compact summary.
 *
 * Usage: node log_insights.js [logFileOrDirectory ...]
 *  - If no paths are supplied, LOG_PATH env or ./logs/live.log is used.
 *  - Accepts .jsonl and .log files. Non-JSON lines are ignored.
 *  - Outputs a single JSON object to stdout for consumption by other tools.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_LOG_CANDIDATES = [
	process.env.LOG_PATH,
	path.resolve(process.cwd(), 'logs/live.log'),
	path.resolve(process.cwd(), 'logs/live.jsonl'),
	path.resolve(process.cwd(), 'logs/dryrun_latest.jsonl'),
	'/tmp/liquidator-dryrun.log',
].filter(Boolean);

function usage() {
	console.error('Usage: node log_insights.js [logFileOrDirectory ...]');
	process.exit(1);
}

function collectInputPaths(argv) {
	const args = argv.filter(Boolean);
	if (args.length === 0) {
		for (const candidate of DEFAULT_LOG_CANDIDATES) {
			if (candidate && fs.existsSync(candidate)) {
				return [candidate];
			}
		}
		console.error('[log_insights] No log files found. Specify a path or set LOG_PATH.');
		process.exit(2);
	}
	return args;
}

function expandPaths(paths) {
	const out = [];
	for (const input of paths) {
		if (!fs.existsSync(input)) {
			console.warn(`[log_insights] Skipping missing path: ${input}`);
			continue;
		}
		const stat = fs.statSync(input);
		if (stat.isDirectory()) {
			const files = fs
				.readdirSync(input)
				.filter((f) => !f.startsWith('.'))
				.map((f) => path.join(input, f))
				.sort();
			out.push(...files);
		} else {
			out.push(input);
		}
	}
	return out;
}

function createNumericAggregator() {
	return { values: [] };
}

function pushValue(agg, value) {
	if (value === null || value === undefined) return;
	if (typeof value !== 'number') {
		const num = Number(value);
		if (!Number.isFinite(num)) return;
		value = num;
	}
	if (!Number.isFinite(value)) return;
	agg.values.push(value);
}

function summarizeNumeric(agg) {
	if (!agg || agg.values.length === 0) return null;
	const values = agg.values.slice().sort((a, b) => a - b);
	const count = values.length;
	const sum = values.reduce((a, b) => a + b, 0);
	const min = values[0];
	const max = values[count - 1];
	const avg = sum / count;
	const quantile = (p) => {
		if (count === 0) return null;
		const idx = Math.min(count - 1, Math.max(0, Math.floor(((p / 100) * (count - 1)) + 0.5)));
		return values[idx];
	};
	return {
		count,
		min,
		max,
		avg,
		p50: quantile(50),
		p90: quantile(90),
		p95: quantile(95),
		p99: quantile(99),
	};
}

function increment(map, key, delta = 1) {
	if (!key && key !== 0) return;
	const next = (map.get(key) || 0) + delta;
	map.set(key, next);
}

function topEntries(map, limit = 5) {
	const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
	return entries.slice(0, limit).map(([key, count]) => ({ key, count }));
}

function parseLine(raw) {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const braceIdx = trimmed.indexOf('{');
	if (braceIdx === -1) return null;
	const jsonPart = trimmed.slice(braceIdx);
	try {
		return JSON.parse(jsonPart);
	} catch (err) {
		return null;
	}
}

async function processFile(filePath, state) {
	const fileInfo = { path: filePath, lines: 0, parsed: 0 };
	state.files.push(fileInfo);
	const rl = readline.createInterface({
		input: fs.createReadStream(filePath, { encoding: 'utf8' }),
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		state.totalLines += 1;
		fileInfo.lines += 1;
		const log = parseLine(line);
		if (!log) {
			state.parseErrors += 1;
			continue;
		}
		state.parsedLines += 1;
		fileInfo.parsed += 1;
		const timestamp = typeof log.time === 'number' ? log.time : Number(log.time);
		if (Number.isFinite(timestamp)) {
			if (state.timeRange.start == null || timestamp < state.timeRange.start) {
				state.timeRange.start = timestamp;
			}
			if (state.timeRange.end == null || timestamp > state.timeRange.end) {
				state.timeRange.end = timestamp;
			}
		}

		const level = typeof log.level === 'number' ? log.level : Number(log.level);
		if (Number.isFinite(level)) {
			increment(state.levelCounts, level);
		}

		const msg = typeof log.msg === 'string' ? log.msg : 'unknown';
		increment(state.msgCounts, msg);

		if (msg === 'candidate-considered') state.pipeline.candidates += 1;
		if (msg === 'plan-null') state.pipeline.planNull += 1;
		if (msg === 'DRY-RUN') state.pipeline.dryRuns += 1;
		if (msg === 'liquidation-sent') state.pipeline.sent += 1;

		if (/^skip-/.test(msg) || /-skip$/.test(msg) || msg === 'plan-null') {
			const key = msg === 'plan-null' ? 'plan-null' : msg;
			increment(state.skipReasons, key);
		}

		if (level >= 40) {
			increment(state.warnCounts, msg);
			increment(state.warnLevels, level);
			if (log.err) {
				const errKey = typeof log.err === 'string' ? log.err.split('\n')[0] : JSON.stringify(log.err);
				increment(state.errorReasons, errKey);
			}
		}

		const chain = log.chain || (log.chainId != null ? `chain-${log.chainId}` : undefined);
		const chainId = log.chainId;
		const chainKey = chain ? `${chain}:${chainId ?? 'na'}` : undefined;
		if (chainKey) {
			if (!state.chainStats.has(chainKey)) {
				state.chainStats.set(chainKey, {
					chain,
					chainId,
					count: 0,
					byMsg: new Map(),
					warnings: 0,
					errors: 0,
					netBps: [],
					dryRuns: 0,
					sent: 0,
					skipReasons: new Map(),
					firstTime: timestamp,
					lastTime: timestamp,
				});
			}
			const chainStat = state.chainStats.get(chainKey);
			chainStat.count += 1;
			increment(chainStat.byMsg, msg);
			if (level >= 40) chainStat.warnings += 1;
			if (level >= 50) chainStat.errors += 1;
			if (timestamp && Number.isFinite(timestamp)) {
				if (chainStat.firstTime == null || timestamp < chainStat.firstTime) chainStat.firstTime = timestamp;
				if (chainStat.lastTime == null || timestamp > chainStat.lastTime) chainStat.lastTime = timestamp;
			}
			if (/^skip-/.test(msg) || /-skip$/.test(msg) || msg === 'plan-null') {
				const key = msg === 'plan-null' ? 'plan-null' : msg;
				increment(chainStat.skipReasons, key);
			}
		}

		if (msg === 'DRY-RUN') {
			pushValue(state.dry.netBps, log.netBps);
			if (chainKey) state.chainStats.get(chainKey).dryRuns += 1;
		}

		if (msg === 'liquidation-sent') {
			pushValue(state.live.netBps, log.netBps);
			pushValue(state.live.repayUsd, log.repayUsd);
			if (typeof log.netBps === 'number' && typeof log.repayUsd === 'number') {
				const estProfit = (log.netBps / 10_000) * log.repayUsd;
				pushValue(state.live.estProfitUsd, estProfit);
			}
			if (chainKey) state.chainStats.get(chainKey).sent += 1;
			if (log.mode) increment(state.live.byMode, log.mode);
			if (log.precommit) state.live.precommit += 1;
		}

		if (msg === 'DRY-RUN' || msg === 'liquidation-sent') {
			const target = chainKey ? state.chainStats.get(chainKey) : null;
			if (target) {
				const nb = Number(log.netBps);
				if (Number.isFinite(nb)) target.netBps.push(nb);
			}
		}
	}
}

function toLevelSummary(levelCounts) {
	const map = new Map([
		[10, 'trace'],
		[20, 'debug'],
		[30, 'info'],
		[40, 'warn'],
		[50, 'error'],
		[60, 'fatal'],
	]);
	const summary = {};
	for (const [lvl, name] of map.entries()) {
		summary[name] = levelCounts.get(lvl) || 0;
	}
	return summary;
}

function mapToObject(map) {
	const obj = {};
	for (const [key, value] of Array.from(map.entries()).sort((a, b) => b[1] - a[1])) {
		obj[key] = value;
	}
	return obj;
}

function safeIso(timestamp) {
	if (!Number.isFinite(timestamp)) return null;
	return new Date(timestamp).toISOString();
}

function buildInsights(state) {
	const insights = [];
	if (state.pipeline.sent === 0 && state.pipeline.dryRuns > 0) {
		insights.push('No live executions recorded; review dry-run outcomes.');
	}
	if (state.pipeline.candidates > 0) {
		const conversion = state.pipeline.sent / state.pipeline.candidates;
		insights.push(`Candidate→execution rate ${(conversion * 100).toFixed(1)}% (${state.pipeline.sent}/${state.pipeline.candidates}).`);
	}
	if (state.skipReasons.size) {
		const topSkips = topEntries(state.skipReasons, 3)
			.map(({ key, count }) => `${key} (${count})`)
			.join(', ');
		if (topSkips) insights.push(`Top skip reasons: ${topSkips}.`);
	}
	const rpc429 = Array.from(state.errorReasons.entries()).find(([err]) => err.includes('Too Many Requests'));
	if (rpc429) {
		insights.push(`RPC rate limits encountered ${rpc429[1]} times; consider backoff or alternate providers.`);
	}
	if (state.parseErrors > 0) {
		insights.push(`Encountered ${state.parseErrors} unstructured log lines.`);
	}
	return insights;
}

async function main() {
	const inputArgv = process.argv.slice(2);
	const rawPaths = collectInputPaths(inputArgv);
	const expanded = expandPaths(rawPaths);
	if (expanded.length === 0) {
		console.error('[log_insights] No readable log files after expansion.');
		process.exit(3);
	}

	const state = {
		files: [],
		totalLines: 0,
		parsedLines: 0,
		parseErrors: 0,
		timeRange: { start: null, end: null },
		levelCounts: new Map(),
		msgCounts: new Map(),
		warnCounts: new Map(),
		warnLevels: new Map(),
		errorReasons: new Map(),
		skipReasons: new Map(),
		pipeline: { candidates: 0, planNull: 0, dryRuns: 0, sent: 0 },
		chainStats: new Map(),
		dry: { netBps: createNumericAggregator() },
		live: {
			netBps: createNumericAggregator(),
			repayUsd: createNumericAggregator(),
			estProfitUsd: createNumericAggregator(),
			byMode: new Map(),
			precommit: 0,
		},
	};

	for (const file of expanded) {
		await processFile(file, state);
	}

	const chainSummaries = Array.from(state.chainStats.values()).map((chainStat) => {
		const netBpsSummary = summarizeNumeric({ values: chainStat.netBps });
		return {
			chain: chainStat.chain,
			chainId: chainStat.chainId,
			count: chainStat.count,
			dryRuns: chainStat.dryRuns,
			sent: chainStat.sent,
			warnings: chainStat.warnings,
			errors: chainStat.errors,
			netBps: netBpsSummary,
			topMsgs: topEntries(chainStat.byMsg, 5),
			topSkips: topEntries(chainStat.skipReasons, 5),
			first: safeIso(chainStat.firstTime),
			last: safeIso(chainStat.lastTime),
		};
	});

	const output = {
		files: state.files,
		totalLines: state.totalLines,
		parsedLines: state.parsedLines,
		parseErrors: state.parseErrors,
		timeRange: {
			startMs: state.timeRange.start,
			endMs: state.timeRange.end,
			startIso: safeIso(state.timeRange.start),
			endIso: safeIso(state.timeRange.end),
			durationMinutes:
				state.timeRange.start != null && state.timeRange.end != null
					? (state.timeRange.end - state.timeRange.start) / 1000 / 60
					: null,
		},
		levels: mapToObject(state.levelCounts),
		levelSummary: toLevelSummary(state.levelCounts),
		byMsg: mapToObject(state.msgCounts),
		warnings: mapToObject(state.warnCounts),
		warningLevels: mapToObject(state.warnLevels),
		errorReasons: topEntries(state.errorReasons, 10),
		skipReasons: topEntries(state.skipReasons, 10),
		pipeline: state.pipeline,
		dryRuns: {
			count: state.pipeline.dryRuns,
			netBps: summarizeNumeric(state.dry.netBps),
		},
		liveExecutions: {
			count: state.pipeline.sent,
			netBps: summarizeNumeric(state.live.netBps),
			repayUsd: summarizeNumeric(state.live.repayUsd),
			estProfitUsd: summarizeNumeric(state.live.estProfitUsd),
			byMode: mapToObject(state.live.byMode),
			precommitCount: state.live.precommit,
		},
		chainSummaries,
		insights: buildInsights(state),
	};

	process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
	console.error('[log_insights] Failed:', err);
	process.exit(99);
});
