import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
} from "obsidian";

interface InstapaperSyncSettings {
	feedUrl: string;
	notePath: string;
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	videoHeading: string;
	articleHeading: string;
	videoDomains: string;
}

interface PluginData {
	settings: InstapaperSyncSettings;
	/** Every URL ever written to the note. Checked/removed items won't come back. */
	seenUrls: string[];
}

const DEFAULT_SETTINGS: InstapaperSyncSettings = {
	feedUrl: "",
	notePath: "_INSTAPAPER.md",
	syncIntervalMinutes: 30,
	syncOnStartup: true,
	videoHeading: "Videos",
	articleHeading: "Articles",
	videoDomains: [
		"youtube.com",
		"youtu.be",
		"vimeo.com",
		"twitch.tv",
		"dailymotion.com",
		"tiktok.com",
		"nebula.tv",
	].join("\n"),
};

const MAX_SEEN = 5000;
/** Matches `- [Title](url)` and `- [ ] [Title](url)` / `- [x] [Title](url)`. Groups: 1 = checkbox state (or undefined), 2 = url. */
const LINK_ITEM_RE = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?\[.*\]\((\S+?)\)\s*$/;

interface FeedItem {
	title: string;
	url: string;
}

export default class InstapaperSyncPlugin extends Plugin {
	settings: InstapaperSyncSettings = DEFAULT_SETTINGS;
	seenUrls: Set<string> = new Set();
	private intervalId: number | null = null;
	private syncing = false;

	async onload() {
		await this.loadPluginData();

		this.addCommand({
			id: "sync",
			name: "Sync now",
			callback: () => this.sync(true),
		});

		this.addCommand({
			id: "import-csv",
			name: "Import Instapaper CSV export (Unread only)",
			callback: () => this.pickAndImportCsv(),
		});

		this.addCommand({
			id: "remove-checked",
			name: "Remove checked items now",
			callback: () => this.removeCheckedNow(),
		});

		this.addSettingTab(new InstapaperSyncSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncOnStartup) this.sync(false);
		});
		this.restartInterval();
	}

	onunload() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
	}

	notePath(): string {
		let path = normalizePath(this.settings.notePath.trim() || DEFAULT_SETTINGS.notePath);
		if (!path.endsWith(".md")) path += ".md";
		return path;
	}

	// ---------- removing checked items ----------

	async removeCheckedNow() {
		const file = this.app.vault.getAbstractFileByPath(this.notePath());
		if (!(file instanceof TFile)) return;
		let removed = 0;
		await this.app.vault.process(file, (content) => {
			const { content: out, removedUrls } = stripChecked(content);
			removed = removedUrls.length;
			for (const u of removedUrls) this.seenUrls.add(normalizeUrl(u));
			return removed > 0 ? out : content;
		});
		if (removed > 0) await this.savePluginData();
	}

	// ---------- persistence ----------

	async loadPluginData() {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
		this.seenUrls = new Set(data?.seenUrls ?? []);
	}

	async savePluginData() {
		let seen = Array.from(this.seenUrls);
		if (seen.length > MAX_SEEN) seen = seen.slice(seen.length - MAX_SEEN);
		this.seenUrls = new Set(seen);
		const data: PluginData = { settings: this.settings, seenUrls: seen };
		await this.saveData(data);
	}

	restartInterval() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const mins = this.settings.syncIntervalMinutes;
		if (mins > 0) {
			this.intervalId = window.setInterval(() => this.sync(false), mins * 60 * 1000);
			this.registerInterval(this.intervalId);
		}
	}

	// ---------- sync ----------

	async sync(manual: boolean) {
		if (this.syncing) return;
		if (!this.settings.feedUrl.trim()) {
			if (manual) new Notice("Instapaper Sync: set your RSS feed URL in the plugin settings first.");
			return;
		}
		this.syncing = true;
		try {
			const items = await this.fetchFeed(this.settings.feedUrl.trim());
			const added = await this.addItems(items);

			if (manual || added > 0) {
				new Notice(
					added > 0
						? `Instapaper Sync: added ${added} link${added === 1 ? "" : "s"}.`
						: "Instapaper Sync: nothing new."
				);
			}
		} catch (e) {
			console.error("Instapaper Sync failed", e);
			if (manual) new Notice(`Instapaper Sync failed: ${(e as Error).message}`);
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * Adds items (given newest-first) to the note, skipping seen ones; also strips checked items.
	 * "top" = new saves from the feed; "bottom" = older items from a CSV backfill.
	 */
	async addItems(items: FeedItem[], position: "top" | "bottom" = "top"): Promise<number> {
		const file = await this.getOrCreateNote();

		let added = 0;
		await this.app.vault.process(file, (original) => {
			// Drop anything already ticked off.
			const stripped = stripChecked(original);
			// Drop duplicate links, e.g. after Obsidian Sync merged two devices' additions.
			let content = dedupeLinks(stripped.content);

			// Anything in the note (or just removed) counts as seen.
			for (const u of stripped.removedUrls) this.seenUrls.add(normalizeUrl(u));
			for (const line of content.split("\n")) {
				const m = line.match(LINK_ITEM_RE);
				if (m) this.seenUrls.add(normalizeUrl(m[2]));
			}

			// Items arrive newest-first; lists read newest → oldest either way.
			const fresh = items.filter((i) => !this.seenUrls.has(normalizeUrl(i.url)));
			if (fresh.length === 0) return content;

			const domains = this.videoDomainList();
			const videos: string[] = [];
			const articles: string[] = [];
			for (const item of fresh) {
				const key = normalizeUrl(item.url);
				if (this.seenUrls.has(key)) continue; // duplicate within this batch
				this.seenUrls.add(key);
				(isVideo(item.url, domains) ? videos : articles).push(formatItem(item));
			}
			added = videos.length + articles.length;
			if (added === 0) return content;

			let out = ensureSection(content, this.settings.articleHeading);
			out = ensureSection(out, this.settings.videoHeading);
			const insert = position === "top" ? prependToSection : appendToSection;
			out = insert(out, this.settings.videoHeading, videos);
			out = insert(out, this.settings.articleHeading, articles);
			return out;
		});
		await this.savePluginData();
		return added;
	}

	// ---------- CSV import ----------

	pickAndImportCsv() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".csv,text/csv";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const items = parseInstapaperCsv(await file.text());
				const added = await this.addItems(items, "bottom");
				new Notice(`Instapaper Sync: imported ${added} of ${items.length} unread link${items.length === 1 ? "" : "s"}.`);
			} catch (e) {
				console.error("Instapaper CSV import failed", e);
				new Notice(`Instapaper import failed: ${(e as Error).message}`);
			}
		};
		input.click();
	}

	async fetchFeed(url: string): Promise<FeedItem[]> {
		const res = await requestUrl({ url, method: "GET" });
		const doc = new DOMParser().parseFromString(res.text, "text/xml");
		if (doc.querySelector("parsererror")) throw new Error("Feed is not valid XML");

		const items: FeedItem[] = [];
		doc.querySelectorAll("item").forEach((el) => {
			const link = el.querySelector("link")?.textContent?.trim() ?? "";
			if (!link) return;
			const title = el.querySelector("title")?.textContent?.trim() || link;
			items.push({ title, url: link });
		});
		return items;
	}

	async getOrCreateNote(): Promise<TFile> {
		const path = this.notePath();
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		const initial =
			`## ${this.settings.articleHeading}\n\n` +
			`## ${this.settings.videoHeading}\n`;
		return await this.app.vault.create(path, initial);
	}

	videoDomainList(): string[] {
		return this.settings.videoDomains
			.split(/[\n,]/)
			.map((d) => d.trim().toLowerCase().replace(/^www\./, ""))
			.filter(Boolean);
	}

}

// ---------- helpers ----------

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes). */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	text = text.replace(/^\uFEFF/, "");
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') { field += '"'; i++; }
				else inQuotes = false;
			} else field += c;
		} else if (c === '"') inQuotes = true;
		else if (c === ",") { row.push(field); field = ""; }
		else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field); field = "";
			if (row.some((f) => f !== "")) rows.push(row);
			row = [];
		} else field += c;
	}
	row.push(field);
	if (row.some((f) => f !== "")) rows.push(row);
	return rows;
}

/** Parses Instapaper's CSV export (URL, Title, Selection, Folder, Timestamp, …) into newest-first Unread items. */
function parseInstapaperCsv(text: string): FeedItem[] {
	const rows = parseCsv(text);
	if (rows.length === 0) throw new Error("CSV is empty");
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const col = (name: string) => header.indexOf(name);
	const iUrl = col("url"), iTitle = col("title"), iFolder = col("folder"), iTime = col("timestamp");
	if (iUrl === -1) throw new Error("No 'URL' column found — is this an Instapaper export?");

	const items: { item: FeedItem; ts: number }[] = [];
	for (const r of rows.slice(1)) {
		const url = (r[iUrl] ?? "").trim();
		if (!/^https?:\/\//i.test(url)) continue;
		const folder = iFolder === -1 ? "unread" : (r[iFolder] ?? "").trim().toLowerCase();
		if (folder !== "unread") continue;
		const title = (iTitle === -1 ? "" : (r[iTitle] ?? "").trim()) || url;
		const ts = iTime === -1 ? 0 : Number(r[iTime]) || 0;
		items.push({ item: { title, url }, ts });
	}
	items.sort((a, b) => b.ts - a.ts); // newest first, like the feed
	return items.map((x) => x.item);
}

/** Removes checked link items (`- [x] [..](..)`) and returns their URLs. */
function stripChecked(content: string): { content: string; removedUrls: string[] } {
	const removedUrls: string[] = [];
	const kept = content.split("\n").filter((line) => {
		const m = line.match(LINK_ITEM_RE);
		if (m && m[1] && m[1].toLowerCase() === "x") {
			removedUrls.push(m[2]);
			return false;
		}
		return true;
	});
	return { content: kept.join("\n"), removedUrls };
}

/** Removes repeated link items with the same URL, keeping the first one. */
function dedupeLinks(content: string): string {
	const seen = new Set<string>();
	return content
		.split("\n")
		.filter((line) => {
			const m = line.match(LINK_ITEM_RE);
			if (!m) return true;
			const key = normalizeUrl(m[2]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.join("\n");
}

function normalizeUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		u.hostname = u.hostname.replace(/^www\./, "");
		let s = u.toString();
		if (s.endsWith("/")) s = s.slice(0, -1);
		return s;
	} catch {
		return url.trim();
	}
}

function isVideo(url: string, domains: string[]): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
		return domains.some((d) => host === d || host.endsWith("." + d));
	} catch {
		return false;
	}
}

function formatItem(item: FeedItem): string {
	const title = item.title
		.replace(/\s+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
	const url = item.url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
	return `- [ ] [${title}](${url})`;
}

function headingIndex(lines: string[], heading: string): number {
	const target = heading.trim().toLowerCase();
	return lines.findIndex((l) => {
		const m = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
		return m !== null && m[1].toLowerCase() === target;
	});
}

function ensureSection(content: string, heading: string): string {
	const lines = content.split("\n");
	if (headingIndex(lines, heading) !== -1) return content;
	const trimmed = content.replace(/\s+$/, "");
	return (trimmed ? trimmed + "\n\n" : "") + `## ${heading}\n`;
}

function appendToSection(content: string, heading: string, newLines: string[]): string {
	if (newLines.length === 0) return content;
	const lines = content.split("\n");
	const h = headingIndex(lines, heading);
	if (h === -1) return content;

	// Section ends at the next heading (any level) or EOF.
	let end = lines.length;
	for (let i = h + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	// Insert right after the last non-blank line of the section (keeps the list contiguous).
	let insertAt = h + 1;
	for (let i = end - 1; i > h; i--) {
		if (lines[i].trim() !== "") {
			insertAt = i + 1;
			break;
		}
	}
	const block = insertAt === h + 1 ? ["", ...newLines] : [...newLines];
	// Keep a blank line before the next heading.
	const next = lines[insertAt];
	if (next !== undefined && /^#{1,6}\s/.test(next)) block.push("");
	lines.splice(insertAt, 0, ...block);
	let out = lines.join("\n");
	// Collapse any accidental 3+ newlines and ensure trailing newline.
	out = out.replace(/\n{3,}/g, "\n\n");
	if (!out.endsWith("\n")) out += "\n";
	return out;
}

function prependToSection(content: string, heading: string, newLines: string[]): string {
	if (newLines.length === 0) return content;
	const lines = content.split("\n");
	const h = headingIndex(lines, heading);
	if (h === -1) return content;

	// First non-blank line after the heading (if it's still inside this section).
	let first = h + 1;
	while (first < lines.length && lines[first].trim() === "") first++;
	const sectionEmpty = first >= lines.length || /^#{1,6}\s/.test(lines[first]);

	const block = ["", ...newLines];
	if (sectionEmpty && first < lines.length) block.push(""); // keep blank line before next heading
	// Replace the blank lines between heading and first item with our block.
	lines.splice(h + 1, sectionEmpty ? first - (h + 1) : first - (h + 1), ...block);

	let out = lines.join("\n");
	out = out.replace(/\n{3,}/g, "\n\n");
	if (!out.endsWith("\n")) out += "\n";
	return out;
}

// ---------- settings UI ----------

class InstapaperSyncSettingTab extends PluginSettingTab {
	plugin: InstapaperSyncPlugin;

	constructor(app: App, plugin: InstapaperSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Instapaper RSS feed URL")
			.setDesc("Private RSS URL of your Unread folder (instapaper.com/rss/…).")
			.addText((t) =>
				t
					.setPlaceholder("https://www.instapaper.com/rss/…")
					.setValue(this.plugin.settings.feedUrl)
					.onChange(async (v) => {
						this.plugin.settings.feedUrl = v.trim();
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Note path")
			.setDesc("Note the links are appended to.")
			.addText((t) =>
				t.setValue(this.plugin.settings.notePath).onChange(async (v) => {
					this.plugin.settings.notePath = v.trim() || DEFAULT_SETTINGS.notePath;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("0 disables automatic syncing.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (v) => {
					const n = Math.max(0, parseInt(v, 10) || 0);
					this.plugin.settings.syncIntervalMinutes = n;
					await this.plugin.savePluginData();
					this.plugin.restartInterval();
				})
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
					this.plugin.settings.syncOnStartup = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl).setName("Video heading").addText((t) =>
			t.setValue(this.plugin.settings.videoHeading).onChange(async (v) => {
				this.plugin.settings.videoHeading = v.trim() || DEFAULT_SETTINGS.videoHeading;
				await this.plugin.savePluginData();
			})
		);

		new Setting(containerEl).setName("Article heading").addText((t) =>
			t.setValue(this.plugin.settings.articleHeading).onChange(async (v) => {
				this.plugin.settings.articleHeading = v.trim() || DEFAULT_SETTINGS.articleHeading;
				await this.plugin.savePluginData();
			})
		);

		new Setting(containerEl)
			.setName("Video domains")
			.setDesc("One per line. Links on these domains (and subdomains) go to the video list.")
			.addTextArea((t) => {
				t.setValue(this.plugin.settings.videoDomains).onChange(async (v) => {
					this.plugin.settings.videoDomains = v;
					await this.plugin.savePluginData();
				});
				t.inputEl.rows = 7;
			});

		new Setting(containerEl)
			.setName("Forget read history")
			.setDesc(
				`The plugin remembers ${this.plugin.seenUrls.size} links so removed ones don't come back. Clearing lets the next sync re-add anything still in the feed.`
			)
			.addButton((b) =>
				b.setButtonText("Clear").onClick(async () => {
					this.plugin.seenUrls.clear();
					await this.plugin.savePluginData();
					new Notice("Instapaper Sync: read history cleared.");
					this.display();
				})
			);
	}
}


