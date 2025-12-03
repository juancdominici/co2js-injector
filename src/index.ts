import * as core from "@actions/core";
import { co2 } from "@tgwf/co2";
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

type CloudflareAnalyticsResult = {
	zone_id: string;
	time_range: {
		since: string;
		until: string;
	};
	totals: {
		requests: number;
		bytes: number;
	};
	daily: {
		date: string;
		requests: number;
		bytes: number;
	}[];
};

type CloudflareConfig = {
	apiToken?: string;
	zoneId?: string;
	since?: string;
	until?: string;
	enabled: boolean;
};

async function run(): Promise<void> {
	try {
		const inputPath = core.getInput("path") || ".";
		const greenHosting = core.getInput("green-hosting") === "true";
		const destination = core.getInput("destination") || ".";

		const cloudflareEnabled =
			core.getInput("cloudflare-enabled") === "true";
		const cloudflareApiToken = core.getInput("cloudflare-api-token");
		const cloudflareZoneId = core.getInput("cloudflare-zone-id");
		const cloudflareSinceInput = core.getInput("cloudflare-since");
		const cloudflareUntilInput = core.getInput("cloudflare-until");

		console.log(`Measuring size for path: ${inputPath}`);
		console.log(`Green hosting: ${greenHosting}`);
		console.log(`Destination: ${destination}`);
		console.log(`Cloudflare integration enabled: ${cloudflareEnabled}`);

		const bytes = await calculateBytes(inputPath);
		console.log(`Total bytes: ${bytes}`);

		const emissions = new co2({ model: "1byte" });
		const estimatedCO2 = emissions.perByte(bytes, greenHosting);

		console.log(`Estimated CO2 emissions: ${estimatedCO2} grams`);
		core.setOutput("emissions", estimatedCO2);

		const cloudflareConfig: CloudflareConfig = {
			apiToken: cloudflareApiToken,
			zoneId: cloudflareZoneId,
			since: cloudflareSinceInput,
			until: cloudflareUntilInput,
			enabled: cloudflareEnabled,
		};

		const cloudflareAnalytics = await fetchCloudflareAnalytics(
			cloudflareConfig
		);

		const carbonTxt = buildCarbonTxt({
			bytes,
			greenHosting,
			estimatedCO2,
			cloudflareAnalytics,
			emissions,
		});

		// Ensure destination directory exists
		if (!fs.existsSync(destination)) {
			fs.mkdirSync(destination, { recursive: true });
		}

		const reportPath = path.join(destination, "report.txt");
		fs.writeFileSync(reportPath, carbonTxt);
		console.log(`Created report.txt at ${reportPath}`);
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message);
	}
}

async function calculateBytes(targetPath: string): Promise<number> {
	let totalBytes = 0;

	// Check if path exists
	if (!fs.existsSync(targetPath)) {
		throw new Error(`Path not found: ${targetPath}`);
	}

	const stats = fs.statSync(targetPath);

	if (stats.isFile()) {
		return stats.size;
	}

	if (stats.isDirectory()) {
		const pattern = "**/*";
		const files = await glob(pattern, {
			cwd: targetPath,
			ignore: ["**/.git/**", "**/node_modules/**"],
			nodir: true,
			absolute: true,
		});

		for (const file of files) {
			const fileStats = fs.statSync(file);
			totalBytes += fileStats.size;
		}
	}

	return totalBytes;
}

async function fetchCloudflareAnalytics(
	config: CloudflareConfig
): Promise<CloudflareAnalyticsResult | null> {
	if (!config.enabled) {
		return null;
	}

	if (!config.apiToken || !config.zoneId) {
		core.warning(
			"Cloudflare analytics enabled but api token or zone id not provided; skipping Cloudflare integration."
		);
		return null;
	}

	// Default to the last 30 days if no explicit range is provided.
	const now = new Date();
	const defaultUntil = now.toISOString().slice(0, 10);
	const defaultSinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	const defaultSince = defaultSinceDate.toISOString().slice(0, 10);

	const since = (config.since || defaultSince).slice(0, 10);
	const until = (config.until || defaultUntil).slice(0, 10);

	const query = `
		query GetZoneAnalytics($zoneTag: String!, $since: String!, $until: String!) {
			viewer {
				zones(filter: { zoneTag: $zoneTag }) {
					httpRequests1dGroups(
						limit: 100,
						filter: { date_geq: $since, date_leq: $until }
					) {
						dimensions {
							date
						}
						sum {
							requests
							bytes
						}
					}
				}
			}
		}
	`;

	try {
		const response = await fetch(
			"https://api.cloudflare.com/client/v4/graphql",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiToken}`,
				},
				body: JSON.stringify({
					query,
					variables: {
						zoneTag: config.zoneId,
						since,
						until,
					},
				}),
			}
		);

		if (!response.ok) {
			core.warning(
				`Cloudflare API request failed: ${response.status} ${response.statusText}`
			);
			return null;
		}

		const data = (await response.json()) as any;

		if (data.errors && data.errors.length > 0) {
			core.warning(
				`Cloudflare API returned errors: ${JSON.stringify(data.errors)}`
			);
			return null;
		}

		const groups =
			data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];

		let totalRequests = 0;
		let totalBytes = 0;
		const daily: CloudflareAnalyticsResult["daily"] = [];

		for (const group of groups) {
			const date = group?.dimensions?.date as string | undefined;
			const requests = (group?.sum?.requests as number | undefined) ?? 0;
			const bytes = (group?.sum?.bytes as number | undefined) ?? 0;

			if (typeof requests === "number") {
				totalRequests += requests;
			}
			if (typeof bytes === "number") {
				totalBytes += bytes;
			}

			if (date) {
				daily.push({ date, requests, bytes });
			}
		}

		return {
			zone_id: config.zoneId,
			time_range: { since, until },
			totals: {
				requests: totalRequests,
				bytes: totalBytes,
			},
			daily,
		};
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown Cloudflare error";
		core.warning(`Failed to fetch Cloudflare analytics: ${message}`);
		return null;
	}
}

function buildCarbonTxt(params: {
	bytes: number;
	greenHosting: boolean;
	estimatedCO2: number;
	cloudflareAnalytics: CloudflareAnalyticsResult | null;
	emissions: co2;
}): string {
	const {
		bytes,
		greenHosting,
		estimatedCO2,
		cloudflareAnalytics,
		emissions,
	} = params;
	const nowIso = new Date().toISOString();

	const lines: string[] = [];

	lines.push("# Generated by CO2.js GitHub Action");
	lines.push(`version = "0.3"`);
	lines.push(`last_updated = "${nowIso}"`);
	lines.push("");
	lines.push("[build]");
	lines.push(`date = "${nowIso}"`);
	lines.push(`total_bytes = ${bytes}`);
	lines.push(`green_hosting = ${greenHosting}`);
	lines.push(`estimated_co2_grams = ${estimatedCO2}`);

	if (cloudflareAnalytics) {
		lines.push("");
		lines.push("[cloudflare]");
		lines.push(`zone_id = "${cloudflareAnalytics.zone_id}"`);
		lines.push(`since = "${cloudflareAnalytics.time_range.since}"`);
		lines.push(`until = "${cloudflareAnalytics.time_range.until}"`);
		lines.push(`requests = ${cloudflareAnalytics.totals.requests}`);
		lines.push(`bytes = ${cloudflareAnalytics.totals.bytes}`);
		lines.push(
			`estimated_co2_grams = ${emissions.perByte(
				cloudflareAnalytics.totals.bytes,
				greenHosting
			)}`
		);

		for (const day of cloudflareAnalytics.daily) {
			lines.push("");
			lines.push("[[cloudflare.daily]]");
			lines.push(`date = "${day.date}"`);
			lines.push(`requests = ${day.requests}`);
			lines.push(`bytes = ${day.bytes}`);
			lines.push(
				`estimated_co2_grams = ${emissions.perByte(
					day.bytes,
					greenHosting
				)}`
			);
		}
	}

	return lines.join("\n");
}

run();
