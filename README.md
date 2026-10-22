# libby-downloader

[![CI](https://github.com/pdugan20/libby-downloader/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/pdugan20/libby-downloader/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pdugan20/libby-downloader)](https://github.com/pdugan20/libby-downloader/releases/latest)
[![License](https://img.shields.io/github/license/pdugan20/libby-downloader)](LICENSE)

A Chrome extension and CLI for downloading audiobooks from Libby for offline listening. The extension grabs files directly from Libby; the CLI tags MP3s with title, author, narrator, and cover art, or merges chapters into a single M4B audiobook with chapter markers.

## Setup

```bash
git clone https://github.com/pdugan20/libby-downloader.git
cd libby-downloader
npm install
npm run build:extension
```

Load the extension in Chrome:

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" and select the `chrome-extension` folder

To use the CLI (optional):

```bash
npm run build && npm link
```

## Usage

### Downloading

Open an audiobook in Libby, then click the download button in the top-right navigation bar. Files save to `~/Downloads/libby-downloads/[Book Title]/`.

### CLI

The CLI provides tagging and merging for downloaded books. Run `libby` for the interactive menu, or use commands directly:

```bash
libby                      # Interactive menu
libby list                 # List all downloaded books
libby tag                  # Tag MP3 files with metadata (interactive)
libby tag ~/path/to/book/  # Tag a specific folder
libby merge                # Merge chapters into M4B audiobook (interactive)
libby merge ~/path/to/book/
libby watch --final-dir ~/audiobooks  # Auto-merge finished downloads into a library
```

Options:

- `--data-dir <path>` — Override the downloads directory
- `--title`, `--author`, `--narrator`, `--cover-url` — Override tag metadata
- `--verbose` — Enable debug logging

### Audiobookshelf (auto-merge)

`libby watch` keeps running in the background. When a download finishes (every chapter plus `metadata.json` present, and no files changed for 30s), it merges the chapters into an M4B and moves it into your library using the layout [Audiobookshelf](https://www.audiobookshelf.org/) expects:

```
<final-dir>/<Author>/<Title>/<Title>.m4b
```

The original download folder then moves to `~/Downloads/libby-downloads/_archive/`. Everything in the archive is already in your library, so it's safe to delete.

```bash
libby watch --final-dir /mnt/audiobooks                       # Watch continuously
libby watch --final-dir /mnt/audiobooks --once                # Process ready books, then exit (for cron)
LIBBY_FINAL_DIR=/mnt/audiobooks libby watch                   # Or configure via env
libby watch --final-dir /mnt/audiobooks --archive-dir ~/done  # Custom archive location
```

Watch options: `--interval <s>` (scan frequency, default 10), `--settle <s>` (quiet period before processing, default 30). A book already in the library is skipped and reported, never overwritten.

## Development

```bash
npm run build              # Build CLI and extension
npm run dev -- list        # Run CLI without building
npm run dev:extension      # Watch mode for extension
npm run check-all          # Full validation (typecheck, lint, format, test)
npm test                   # Run unit tests
npm run test:cli           # Run CLI integration tests against fixtures
```

See [docs/architecture.md](docs/architecture.md) for system design and [docs/releasing.md](docs/releasing.md) for the release process.

## Disclaimer

This tool is for educational purposes only. Users are responsible for complying with their library's terms of service and respecting copyright agreements.
