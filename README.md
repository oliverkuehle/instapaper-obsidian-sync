# Instapaper Sync (Obsidian plugin)

Pulls your Instapaper **Unread** links into a single note (`_INSTAPAPER.md` by default), split into a video list and an article list.

## How it works

- Reads your private Instapaper RSS feed (no API keys or OAuth needed).
- Adds each new link as a checklist item under the right heading:

  ```markdown
  ## Articles

  - [ ] [Some blog post](https://example.com/post)

  ## Videos

  - [ ] [Some talk](https://youtube.com/watch?v=…)
  ```

- Links on video domains (YouTube, youtu.be, Vimeo, Twitch, Dailymotion, TikTok, Nebula; editable) go under **Videos**. Everything else goes under **Articles**.
- New items go at the end of each list, oldest first.

## Marking items as read

Tick the checkbox. Ticked items are removed at the next sync. A sync that can't reach the feed skips removal, so they wait for the next successful one.
The plugin remembers every link it has added, so removed items (ticked or deleted by hand) never come back.

Read state is **not** sent back to Instapaper, because the RSS feed is read-only.

## Syncing

- Runs on startup and then every 30 minutes (configurable; 0 = off).
- Commands:
  - **Sync now**
  - **Remove checked items now**
  - **Import Instapaper CSV export (Unread only)**: one-time backfill from Instapaper's CSV export; skips links already in the note or already removed.

## Setup

1. Build (`npm run build`), then copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/instapaper-sync/`.
2. Enable **Instapaper Sync** under Settings → Community plugins.
3. Paste your Unread RSS URL (`https://www.instapaper.com/rss/…`) into the plugin settings.

## Settings

| Setting | Default |
|---|---|
| RSS feed URL | – |
| Note path | `_INSTAPAPER.md` |
| Sync interval (min) | `30` |
| Sync on startup | on |
| Video / Article headings | `Videos` / `Articles` |
| Video domains | see above |
| Forget read history | button: clears the list of links the plugin remembers, so the next sync re-adds anything still in the feed |

## Development

```bash
npm install
npm run build   # type-check + bundle to main.js
npm run dev     # rebuild on change
```

Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/instapaper-sync/` (or symlink the folder).

## Limitations

- The RSS feed only holds your 10 most recent saves; use the CSV import for older ones.
- Archiving in Instapaper would need the full Instapaper API (xAuth).
