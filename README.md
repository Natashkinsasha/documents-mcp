# documents-mcp

A read/write MCP server over an existing document folder. **One executable, one installation command.** No Node.js, Docker, Tesseract, Poppler or separate cloudflared installation is needed on the destination server. The executable includes Node, SQLite FTS5, PDF extraction, multilingual WASM OCR and Cloudflare Tunnel. All application UI, tools and errors are in Russian. Writing is enabled by default; optional `READ_ONLY=1` hides all seven write/trash tools.

## Install: Windows (download and double-click)

1. Download `documents-mcp-win-x64.exe` and verify its SHA-256 against `SHA256SUMS`.
2. Double-click the executable. It is **unsigned**. If SmartScreen says **«Windows защитил ваш компьютер»**, use **«Подробнее» → «Выполнить в любом случае»** only if you trust the download and your organization's policy permits it.
3. Accept the UAC administrator request. If declined, the program explains that administrator rights are required and waits for Enter.
4. Choose a **local documents folder** in the Windows folder picker (or type its path if the picker is unavailable).
5. Select **«Адрес и код из Cue (рекомендуется)»**, then enter the address (for example `vs.cuechat.org`) and one-time code issued in Cue. The code is valid for **24 hours**; its input is hidden and it is never saved.
6. After installation, the program prints the address and **«Ключ для Cue: …»** and copies the key to the clipboard. In Cue, open **Коннекторы → Документы компании → Ключ из программы → Проверить и подключить** and paste this key. Wait for the public health check; if the tunnel is still starting, the program shows a warning rather than failing the installation.

Open the downloaded executable again to see the installed version versus this file, task state, documents folder and address. The wizard offers **update**, **show/copy address and key**, **change folder**, **reconnect with a new Cue address/code**, and **uninstall**. Updates, folder changes and reconnects keep the existing MCP key. Uninstall keeps settings and index unless you separately confirm their deletion; source documents are never deleted. The window waits for **«Нажмите Enter, чтобы закрыть окно»**, including on errors.

The program installs under `%ProgramFiles%\documents-mcp`, with config under `%ProgramData%\documents-mcp`. The index goes to `documents-mcp-data` at the root of the documents drive when that drive is not the one holding `%ProgramData%` (for example `E:\documents-mcp-data` for `E:\Documents`), otherwise to `%ProgramData%\documents-mcp`; `--index-dir <path>` chooses another local folder outside the documents. Upgrades, folder changes and reconnects keep the existing index folder. ACLs restrict these locations to **SYSTEM and Administrators**. It registers a native Task Scheduler task named `documents-mcp`: a boot trigger, SYSTEM identity, no logged-in user required, no execution time limit, and restart-on-failure every minute (up to 999 consecutive retries). The task always uses `run --config …`, never the wizard.

Only **local document folders** are supported. SYSTEM normally has access to local folders, but restricted ACLs still apply. UNC paths and `--user` are rejected; synchronize network documents locally or arrange a domain-account task with your administrator.

For terminal or unattended use, open PowerShell **as Administrator** and run `.\documents-mcp-win-x64.exe install` with the same flags as Linux below. Double-click detection applies only to Windows, with no arguments and an interactive console. On Linux/macOS no arguments still means `run`. macOS supports `run`, `status`, help and version for local use/testing, not service installation.

## Install: Linux

Download the executable for the server architecture (`documents-mcp-linux-x64` or `documents-mcp-linux-arm64`), verify it against the accompanying `SHA256SUMS`, and give it execute permission. You may rename it to `documents-mcp`.

```sh
chmod +x documents-mcp
sudo ./documents-mcp install
```

The **installation command** first asks **«Как подключить к Cue?»**: **1 — «Адрес и код из Cue (рекомендуется)»**, **2 — «Свой туннель Cloudflare (токен)»**, **3 — «Только на этом компьютере»**. For option 1 enter the address and one-time code from Cue, then the existing documents folder. Addresses may also include `https://` or a trailing `/mcp`. It generates a new 256-bit MCP key, installs and starts a systemd service, checks local health, and checks public `/healthz` for the exact `ok` response for up to 60 seconds. Only then does it say the tunnel works; failure of the public check is a warning. It prints the address, key and the Cue paste instruction shown above. Installation requires root and a Linux host running systemd.

Unattended setup (prefer interactive hidden input to avoid storing the code in shell history):

```sh
sudo ./documents-mcp install --yes --docs /srv/company/documents \
  --cue-address vs.cuechat.org --cue-code XXXX-XXXX-XXXX
```

Cue activation calls `POST https://app.cuechat.org/api/document-servers/claim` with Russian errors and a 30-second request timeout. A `503` is retried every 10 seconds for up to two minutes; other errors are shown immediately, including rate-limit retry instructions. Repeating redemption returns the same tunnel settings until the code expires or the connector is activated. Cue chooses the port; `--port` cannot override it. The code is never stored or logged; only the protected config stores the tunnel token, which is never printed or put on a child process command line. `CUE_URL` changes **only** the claim endpoint, requires HTTPS, and permits HTTP solely for `localhost`/`127.0.0.1` tests. It is not a public URL or a runtime server setting.

On upgrade, Enter keeps the current connection; `--yes` keeps it without asking. Choose a new connection method or pass new Cue flags to reconnect, keeping the MCP key. Choosing option 3 clears the previous tunnel and public address. A first unattended install without connection flags is local-only. Existing `--tunnel-token` / `--public-url` flags remain available for a manually managed tunnel.

Paths:

| Item | Location |
| --- | --- |
| Executable | `/usr/local/bin/documents-mcp` |
| Config | `/etc/documents-mcp/config.env` |
| Index and runtime assets | `/var/lib/documents-mcp`, or `--index-dir <path>` |
| Service | `/etc/systemd/system/documents-mcp.service` |

By default the service runs as the dedicated system user `documents-mcp`, not root. The config is mode `0600`, owned by that service user; root can also read it. The service has read-only filesystem protection, a private temporary directory and explicit `ReadWritePaths` exceptions for its data directory and the documents folder. With `READ_ONLY=1`, documents use `ReadOnlyPaths` instead. Installation and upgrades always regenerate this unit; there is no write-permission question.

The service account must be able to **traverse every parent directory and read/write the documents**. Installation checks read/traverse/write access to the root folder (read/traverse only with `READ_ONLY=1`) and reports the exact ACL fix when it fails. For example, with ACL tools already available:

```sh
sudo setfacl -R -m u:documents-mcp:rwX /srv/company/documents
sudo setfacl -R -d -m u:documents-mcp:rwX /srv/company/documents
sudo setfacl -m u:documents-mcp:x /srv /srv/company
```

The default ACL applies to future files and folders. Alternatively, choose an **existing** account with read/write access:

```sh
sudo ./documents-mcp install --user document-editor
```

The application does not install ACL utilities or modify document permissions automatically. Permission to read/write the folder itself does not guarantee permission to every child; unreadable children cannot be indexed and protected descendants cannot be changed.

## Alternative: create your own Cloudflare Tunnel

1. In your Cloudflare account, add a domain you control. Open **Zero Trust → Networks → Connectors / Tunnels** and create a **remotely managed Cloudflare Tunnel**. Dashboard labels may change.
2. Copy only its tunnel token, not the entire suggested Docker/shell command. Enter that token during `install`. You do not install Cloudflare's command-line program separately.
3. Add a public hostname, for example `documents.example.com`, with service type **HTTP** and service URL **`http://localhost:3000`**. Replace the port if you changed it with `--port`.
4. Enter `https://documents.example.com` as the installer's optional public URL. Do not add `/mcp` there.

The embedded supervisor starts `cloudflared tunnel --no-autoupdate run`. The tunnel token is passed in the child's **`TUNNEL_TOKEN` environment variable**, never its arguments. The child does not receive `MCP_TOKEN`. Output lines are prefixed `[tunnel]`, the exact tunnel token is redacted, and failed children restart with exponential backoff from 1 to 30 seconds. Shutdown stops the child. With a tunnel, the HTTP server always binds **`127.0.0.1`**, even if `HOST` says otherwise. No inbound firewall port needs to be opened.

Without a tunnel, installation is local-only by default. Cloudflare Access login pages are not MCP bearer authentication; if you put an additional Access policy in front, the client must be able to satisfy it. Configure WAF/rate limiting as appropriate. Manual mode does not provision a Cloudflare account, hostname or tunnel; the recommended Cue mode obtains an already provisioned installation from Cue.

## Connect an MCP client

The installer prints exactly the connection values. Configure a Streamable HTTP connection with:

```text
URL: https://documents.example.com/mcp
Authorization: Bearer <the generated MCP_TOKEN>
```

For clients accepting a JSON definition (the outer schema varies by client):

```json
{
  "mcpServers": {
    "documents": {
      "url": "https://documents.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Retrieve the saved values later with `sudo documents-mcp token`, or `documents-mcp.exe token` from an Administrator terminal. This is a shared bearer credential granting access to **all visible documents**, not OAuth or per-user document authorization.

| Tool | Purpose |
| --- | --- |
| `search_documents` | Stemmed Russian/English search, optional folder, ranked documents and excerpts |
| `list_folder` | Visible files and folders, readability and indexing status |
| `read_document` | Text with page/sheet labels and character-offset paging |
| `documents_status` | Index progress, partial documents and failures, counted from the index without checking each file; changes on disk appear after the next pass |
| `create_folder` | `path`; creates intermediate folders, idempotent for existing folders |
| `write_document` | `path`, `content`, optional `overwrite=false`, `expected_modified`, `replace_office=false` |
| `edit_document` | `path`, required `expected_modified`, 1–50 `edits: [{old_text, new_text, replace_all?}]` |
| `move_path` | `from`, `to`, optional `overwrite=false`; files and folders |
| `delete_path` | `path`; recursively moves the item to the 30-day trash |
| `list_trash` | No arguments; newest 200 entries, ids, paths, kinds, sizes, reasons and expiration |
| `restore_from_trash` | `id`, optional `to`, optional `overwrite=false` |

The original four tools keep `readOnlyHint: true`, non-destructive, idempotent, closed-world annotations. All seven additional tools have `readOnlyHint: false` and `openWorldHint: false`; only `create_folder` is idempotent, and all mutation tools except `create_folder` are destructive (`list_trash` is non-destructive). An MCP client may offer only read-only tools in unattended runs, so writes happen in conversations with a person. No resources or prompts are exposed. `/healthz` returns only `ok`, without credentials or document details.

### Indexing control HTTP API

These endpoints let a client such as Cue show and manage indexing. They are not MCP tools, so agents cannot call them: the tool list, tool descriptions, server instructions and `documents_status` text are unchanged. They use the same `Authorization: Bearer <MCP_TOKEN>`, refuse any request with an `Origin` header, and accept JSON bodies up to 4 KiB.

| Request | Effect |
| --- | --- |
| `GET /control/status` | Returns `version`, `paused`, `recognitionPaused`, `scanning`, `lastScanAt`, `scanFailed`, `counts` (`total`, `processed`, `ready`, `pending`, `recognition`, `partial`, `failed`, `unsupported`), up to 20 `failures` (`path`, `error`) and `failuresTruncated` |
| `GET /control/failures?offset=<n>&limit=<1-50>` | Returns one page of files that could not be read, in path order: `failures` (`path`, `error`), `total` and `nextOffset` (`null` on the last page). `offset` defaults to `0`, `limit` to `20`. A file deleted or hidden since the last scan is left out of its page |
| `POST /control/indexing` with `{"paused": true}` or `false` | Pauses or resumes background indexing and returns the status |
| `POST /control/recognition` with `{"paused": true}` or `false` | Defers or resumes background recognition of images and scanned pages and returns the status |
| `POST /control/rescan` | Returns `202` and checks the folder now. While paused it only finds new and deleted files. A request during a pass runs one more pass afterwards |

`GET /control/status` reads the counts from the index without touching each file, so it stays fast on very large folders; changed and deleted files are reflected after the next scan. Pauses limit only background work: the file being processed finishes, and a document an agent asks for is still read at once, including recognition. Resuming starts a pass. Both switches are stored in `indexing-controls.json` in the index directory, survive restarts and index rebuilds; a damaged file is ignored with a warning.

### Read-only file browser HTTP API

Two additional read-only HTTP endpoints let a client such as Cue show expandable folders and preview original files. They are not MCP tools: the tool list, tool descriptions and server instructions are unchanged. They use the same `Authorization: Bearer <MCP_TOKEN>`, refuse any request with an `Origin` header (browser requests), answer only `GET`, send `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and share the `/mcp` limit of 64 concurrent requests; at most 4 file downloads are buffered at once. `READ_ONLY=1` does not change them, and they never write, index or touch the trash.

`GET /browse/files?path=<relative>&offset=<n>` lists one folder. `path` is relative with `/` separators, `''` (or omitted) is the root; `offset` is a non-negative integer (default `0`). The response is:

```json
{
  "path": "Договоры",
  "entries": [
    { "name": "2026", "path": "Договоры/2026", "kind": "directory", "size": null, "version": null },
    { "name": "Договор 2.pdf", "path": "Договоры/Договор 2.pdf", "kind": "file", "size": 48213, "version": "<64 hex>" }
  ],
  "nextOffset": null
}
```

Pages hold 200 entries: folders first, then files, each sorted by name with the Russian numeric collation (`Папка 2` before `Папка 10`). `nextOffset` is the offset of the next page, or `null` at the end; an offset past the end returns an empty page. `size` is the exact byte size. `version` is an opaque SHA-256 of the file's dev, inode, size, mtime and ctime; it changes on every modification or replacement, and is `null` for folders. Only visible entries are listed: symlinks (to files or folders, inside or outside the root), hidden/ignored names, the trash and anything outside `DOCS_ROOT` are omitted, and requested paths are resolved component by component without following symlinks.

`GET /browse/file?path=<relative>&version=<version>` returns the original bytes as `application/octet-stream` with `Content-Length`, `Content-Disposition: attachment` (no file name) and a sandboxing `Content-Security-Policy`; no response header contains the path or other request data. `version` must be the exact value from the listing. The file is checked before opening, opened without following symlinks, checked again by descriptor and by path, read whole, and checked once more before any byte is sent. The limit is 30 MiB, or `MAX_FILE_MB` when lower.

Errors are JSON `{ "error": "<neutral Russian text>", "code": "<code>" }` and never include absolute paths or system error text:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Missing `path`/`version` on `/browse/file`, malformed `version`/`offset`, repeated or unknown parameters, path over 4096 characters |
| 401 | `invalid_request` | Missing or wrong bearer token (`WWW-Authenticate: Bearer`) |
| 403 | `invalid_request` | `Origin` header present |
| 404 | `file_missing` | Missing path, traversal, absolute or Windows path, symlink, hidden/ignored entry, folder requested as a file or file as a folder |
| 405 | `invalid_request` | Method other than `GET` (`Allow: GET`) |
| 409 | `file_changed` | `version` no longer matches, or the file changed while being read; list the folder again |
| 413 | `file_too_large` | File over the browse limit |
| 429 / 503 | `unavailable` | Too many concurrent requests (`Retry-After: 1`) / unexpected failure |

`/mcp` and `/healthz` behave as before.

### Writing and recovery

Read before editing. `read_document` and every file in `list_folder` report modification time as **ISO UTC with milliseconds**, e.g. `2026-11-13T12:34:56.789Z`. Pass that exact value as `expected_modified`; a stale/missing value refuses replacement and asks you to re-read. File listings and reads also identify editable text, replaceable Office documents, or read-only formats. Prefer `edit_document` for small text changes. Edits apply in order, require one exact match unless `replace_all=true`, normalize line endings while matching, preserve the file's CRLF/LF style, and write nothing if any edit fails.

- Freely writable text: `.txt .md .markdown .csv .tsv .json .xml .yaml .yml .log .ini .html .htm`. New files are UTF-8; replacements and edits preserve UTF-8/UTF-16 BOMs and Windows-1251 encoding. Unencodable characters cause an error rather than data loss.
- Create `.docx` with `docx` (pure JavaScript): `#`–`###` headings, paragraphs, `-`/`1.` lists, `**bold**`, `*italic*`, and `|` tables (first row header). Output uses Calibri 11, A4 and normal margins. This is a deliberately small Markdown-like subset, not a full Markdown renderer.
- Create `.xlsx` with the bundled SheetJS: CSV, TSV or Markdown tables; start sheets with `## Лист: Имя`. Numbers, ISO dates and percentages become typed cells; column widths are fitted. SheetJS Community 0.20.3 does not write custom font styling or frozen panes: **bold headers and frozen rows are not emitted**. Untrusted strings are written as strings, not formulas.
- Existing DOCX/XLSX require **both** `overwrite=true` with `expected_modified` **and** `replace_office=true`: replacement rebuilds the entire document and **loses previous formatting**. PDF, images, DOC, XLS, PPTX, RTF and ODS remain read-only, but may be moved, renamed and deleted.
- Before replacement/editing, the previous version is copied to `<DOCS_ROOT>/.documents-mcp-trash/<id>/item`. Deletes and overwritten move targets are renamed there on the same filesystem. `meta.json` records original path, kind, bytes, reason and deletion time. Keep backups separately too: this is recovery, not permanent backup.
- Trash entries expire after 30 days and are purged on each rescan (purging is disabled in read-only mode). `list_trash` hides expired entries. Restore to the original path or `to`; a conflict needs `overwrite=true`, which backs up the current item first. Trash is never indexed, listed or directly addressable by document tools; Windows also receives a best-effort hidden attribute.
- Content is capped at 5,000,000 UTF-16 code units; the complete HTTP JSON request must fit 30,100,000 bytes, including escaping and edit arrays. Writes are atomic, file-synced, preserve existing modes and are serialized in-process with folder changes and scans. New files use exclusive atomic hard-link publication (the filesystem must support hard links); replacement uses same-folder temporary files and rename, with a final modification check. The index is refreshed before a successful mutation returns. Logs contain tool, paths, bytes and outcome, never document content.
- Writes refuse the root, symlinks (including inside-root aliases), excluded/hidden names, Windows-invalid/control characters, reserved device names, trailing dots/spaces, components over 255 UTF-8 bytes and paths over 1000 characters. Recursive folder operations also refuse protected descendants, including descendants that would become ignored at the destination. Create parent folders explicitly with `create_folder`; restore can recreate parents.

Document contents are data, not instructions. Bearer access now authorizes changes to all visible documents: share it accordingly. Mutation serialization covers this server process, not other applications or multiple server processes; arbitrary malicious concurrent filesystem replacement is not a complete OS-level sandbox.

## Upgrade, status and uninstall

Download a new executable to a **different file** from the installed copy and run `install` again as root/Administrator. Existing settings and the bearer token are kept unless a flag changes the corresponding setting. Installation stops the previous service/task, replaces its executable, and starts it again. Do not overwrite a running executable manually, especially on Windows.

```sh
sudo ./documents-mcp install --yes --docs /srv/documents --port 3000
sudo documents-mcp status
sudo documents-mcp token
sudo documents-mcp uninstall          # keep config and index
sudo documents-mcp uninstall --purge  # also remove config and data
```

Use the `.exe` equivalents on Windows. If you might need `--purge`, supply it on the first uninstall: the installed executable is removed. The Windows executable removes itself via a short-lived built-in PowerShell process after exiting. The Linux system user is left in place on uninstall. **Uninstall never deletes source documents or their trash**; document tools can delete into trash and the retention job permanently removes expired trash.

Unattended installation accepts `--docs`, `--cue-address` with `--cue-code`, the alternative `--tunnel-token` / `--public-url`, `--port`, `--user` (Linux) and `--yes`. The first unattended install requires `--docs`; omitted settings retain their previous values. Cue always sets the port returned by the claim endpoint. Do not mix Cue flags with manual-tunnel flags. An explicitly empty `--tunnel-token ""` disables the tunnel. Prefer interactive hidden secret input: a code/token supplied to the **installer flag** can be visible in shell history and the installer's process arguments. Secrets are never copied into child process arguments or the generated unit/task.

## Configuration

`documents-mcp` or `documents-mcp run` starts the server. `--config <path>` selects a file; an explicitly selected missing file is an error. Defined environment variables override file values. The default config location is platform-specific as listed above; on macOS it is `~/Library/Application Support/documents-mcp/config.env`. Missing default files are allowed for an environment-only/source run.

The config uses literal `KEY=value` lines, or `KEY="JSON-escaped value"` as generated by the installer, plus whole-line `#` comments. No shell expansion, command evaluation, interpolation or implicit `.env` loading occurs. Restrict config permissions and backups; it contains both tokens.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCS_ROOT` | required | Existing absolute document directory |
| `MCP_TOKEN` | required | At least 32 printable ASCII characters without spaces; installer generates 64 hex characters |
| `HOST` | `127.0.0.1` | Listening address; forced to loopback with a tunnel |
| `PORT` | `3000` | Port, 1–65535 |
| `INDEX_DIR` | `./data` for environment-only runs | Private index, outside documents; installer sets the system data directory |
| `TUNNEL_TOKEN` | empty | Optional remotely managed Cloudflare tunnel token |
| `PUBLIC_URL` | empty | Optional HTTPS origin, used to print/check the connection, not to configure Cloudflare |
| `OCR_LANGS` | `rus+bel+eng` | Nonempty subset of these three **bundled** languages |
| `RESCAN_MINUTES` | `10` | Positive interval between scans |
| `MAX_FILE_MB` | `100` | Maximum input size in MiB, up to 1024 |
| `OCR_MAX_PAGES` | `300` | Maximum scanned PDF pages OCRed per document |
| `IGNORE` | empty | Comma-separated relative globs, e.g. `**/archive/**,**/*.bak` |
| `READ_ONLY` | unset (writing enabled) | Optional `1` hides all seven write/trash tools and disables trash purge; other values leave writing enabled |
| `REMOTE_UPDATE` | `0` (disabled) | `1` explicitly allows remotely triggered, signed Windows x64 updates; independent of `READ_ONLY` |
| `SERVICE_USER` | `documents-mcp` | Saved Linux installer account; change with `install --user` |

Dotfiles/directories, `~$*`, `Thumbs.db`, `desktop.ini` and `node_modules` are hidden. Ignore rules apply to both requested paths and symlink targets; a directory match hides descendants. Tool paths use `/`, never absolute paths or Windows backslashes. Escaping symlinks and traversal are rejected.

## Formats, OCR and limits

Supported: UTF-8/BOM UTF-16/Windows-1251 text, Markdown, CSV/TSV, JSON, XML, YAML, logs, INI, basic RTF/HTML, DOCX/DOC, XLSX/XLS/ODS, PDF, **PNG/JPEG/BMP/TIFF/WEBP**, and PPTX slide text. All five image families were exercised with offline OCR; unknown image signatures are marked unsupported instead of being passed blindly to OCR. Word tables retain row boundaries and `|` separators; spreadsheets use tabs and ISO dates.

PDF extraction uses **unpdf's serverless pdf.js build**, without canvas or native modules. Text is ordered by baseline and horizontal position, preserving line breaks and table-column gaps. Pages with fewer than 20 letters use decoded image XObjects/inline images from the operator list. The largest image is converted from RGB/RGBA/packed 1-bit or grayscale pixels into a PNG and OCRed. PDF.js handles JPEG, CCITT and JBIG2 decoding. This does **not** render vector-only scans, composite a tiled page or merge multiple image fragments; unavailable/failed scan extraction is marked partial. PDF image decoding is capped at 36 million pixels.

Tesseract.js/WASM runs on a worker thread. One OCR worker is reused across pages and files, with offline `4.0.0_best_int` Russian, Belarusian and English data from npm. No language or WASM downloads occur at runtime. Each OCR operation has a 60-second deadline; an extraction is stopped after 10 minutes without progress and retried up to twice, resuming after the pages already recognized, which are kept in the index. Inputs are copied through guarded file descriptors to private snapshots before parsing, with a file-size limit and change detection. Extracted text is capped at 5 million UTF-16 code units; sheets at 100001 rows and 1000 columns. Cap truncations are marked partial. Reads stop waiting after 45 seconds while the queued job continues.

Scans are periodic, not file watchers. Changes and deletions are checked before disclosure; unchanged failed files are retried after modification or index rebuild. One extraction runs at a time, and concurrent reads share the same job. A requested file goes ahead of background indexing, and recognition in progress gives way at the next page. After 45 seconds `read_document` answers with the text available so far and the pages still waiting, or with the processing state, while the work continues. Offsets count UTF-16 code units of the rendered text including part labels, zero-based and end-exclusive.

Unsupported/limited: encrypted documents, arbitrary archives, legacy `.ppt`, macros, formula recalculation, embedded attachments, DOCX image OCR, chart/image interpretation, full visual layout and guaranteed handwriting accuracy. Multi-frame TIFF is not split into separately labelled pages. OCR is imperfect: verify important numbers and facts against originals. This is not a complete hostile-document sandbox; WASM/native allocations are not a hard process-memory quota. The SQLite index contains original document text and must be protected like the documents.

## Build from source and build executables

Source development requires **Node >=24** and pnpm 11. The release binaries pin **Node 24.22.3 LTS** in `scripts/binary-versions.json`, independent of the build machine's Node. No extraction CLI tools are needed.

```sh
pnpm install
pnpm build                    # TypeScript + bundled runtime; downloads host cloudflared once
pnpm test                     # offline after package installation; no external OCR/PDF tools
pnpm dev -- run --config /absolute/path/config.env
pnpm build:binary             # all four targets
pnpm build:binary --target linux-x64,linux-arm64
```

Alternatively run `node dist/main.js run --config ...` or use environment variables. `pnpm dev` prepares runtime assets and can run without a tunnel before a build. For source-mode tunneling, run `pnpm build` first to populate the pinned host cloudflared cache. `pnpm sample` exercises generated fixtures using the SDK.

`pnpm exec tsx scripts/verify-cue-install.ts` runs a root-free install-flow smoke test on macOS: a local fake Cue HTTP server, a separate client process with `CUE_URL=http://127.0.0.1:<port>`, real claim/configuration/connection output, and fake OS deployment/health checks. Temporary settings are removed afterwards. This does not verify a real Cloudflare tunnel, Windows UAC/picker/clipboard or service installation.

Outputs are `release/documents-mcp-<target>[.exe]` and `release/SHA256SUMS`. Supported targets: `linux-x64`, `linux-arm64`, `win-x64`, `darwin-arm64`. Downloads and temporary build products are under git-ignored `.cache/`; outputs under ignored `release/`.

Linux executables use the official glibc Node builds, tested on Debian bookworm; Alpine/musl is not a supported target. See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) for measured sizes, actual MCP/OCR output, service restart/upgrade checks and remaining platform limitations.

The build verifies each official Node archive/executable against that version's `https://nodejs.org/dist/v<VERSION>/SHASUMS256.txt`. If the local Node version differs, the build downloads and uses the **exact pinned host version** to generate every SEA blob. Code cache and snapshots are disabled for cross-target compatibility. esbuild produces a CommonJS main and bundled extraction/OCR workers. Worker scripts, pdf.js including its JS/WASM decoders, traineddata, OCR core JS/WASM and target-specific cloudflared are SEA assets. `postject` injects the blob. A macOS host with `codesign` is required to remove the original Darwin signature and ad-hoc sign the result; Windows outputs are not Authenticode signed. ELF/PE injection can emit informational section/signature warnings.

At first start, assets are verified and extracted under `<INDEX_DIR>/runtime/<version>-<manifest content hash>/`, with private directories and files. Existing assets are SHA-256 checked and reused; corrupted assets are replaced from the executable and old version directories removed. The main process and extraction workers do not need the source tree or an installed `node_modules` directory.

Cloudflared **2026.11.0** and the four download SHA-256 values are pinned together in `scripts/binary-versions.json`. To bump: inspect the official `cloudflare/cloudflared` GitHub release, download its four named assets, independently compute SHA-256 (the Darwin hash covers the `.tgz`), update the version/hashes in that one file, rebuild all targets, and rerun binary verification. The builder rejects checksum mismatches, including corrupted cache entries. Bump Node in the same file after confirming LTS support and rerun all tests. Cloudflared does not self-update separately.

## Signed remote updates (Windows x64 only, since 1.5.0)

Remote update is **off by default**. An Administrator can opt in with
`documents-mcp.exe install --allow-remote-update` or answer the explicit question
in the first-install Windows wizard. This saves `REMOTE_UPDATE=1` in the protected
`config.env`. Ordinary upgrades preserve the existing value and never enable it
implicitly. To revoke consent, set `REMOTE_UPDATE=0` and restart the service.
Read-only document access is independent of update consent. Linux, macOS and
non-x64 Windows report `supported:false`; their service privileges do not permit
this update mechanism. Version 1.4.0 must first be upgraded locally to 1.5.0.

`GET /control/update` returns `supported`, `allowed`, `current`, `available`,
`state`, `target`, `received`, `size`, and `error`. The state is `idle`, `checking`,
`downloading`, `verifying`, `installing`, or `failed`. Availability is checked in
the background, at most once per hour (including failed checks); GET never waits
for GitHub. `POST /control/update` has **no body and no query parameters**. It
returns 202, also for a duplicate request while work is running, 403/`disabled`
without consent, or 409/`unsupported` on other platforms. These routes use the
same bearer authentication, refusal of any Origin header, 64-request limit and
`{error,code}` failures as other control routes. `/control/status` is unchanged;
there is no update MCP tool. No cabinet button is included in this change.

### Trust and download

The caller cannot choose a URL, version, path, hash, command or arguments. The
only download origin is
`https://github.com/Natashkinsasha/documents-mcp/releases/latest/download/`.
Redirects are manual, bounded, HTTPS-only, and restricted to `github.com` and
subdomains of `githubusercontent.com`. The MCP token is never sent to GitHub.
The pinned Ed25519 SPKI key lives in `src/update-public-key.json`. The detached
base64 signature is verified over **exact manifest bytes before JSON parsing**.
The strict schema accepts only a stable `x.y.z` version newer than the running
version and the fixed Windows asset name, bounded size, and SHA-256. Prereleases
and build metadata are deliberately not accepted in this first version.

Downloads stream into the protected system data directory's `update/` child,
never the served documents or a separately configured index folder. There is
no whole-download timeout: headers and each network read have a 60-second
deadline, so a download at 40 KB/s may take over an hour. Eight attempts use
exponential backoff up to 60 seconds, Range, strict Content-Range/length checks,
and on-disk progress. Every attempt re-fetches the signed manifest; changed
manifest bytes discard the partial download. A crash is reported as
`failed`/`interrupted`; a new POST resumes the retained partial file, with a fresh
signature check. A SHA-256/size failure discards it. Disk headroom includes the
download, staging, backup, and a 64 MiB margin. Files on a separate executable
volume can still fail during staging; that failure must not stop the service.

### SYSTEM apply and rollback

A private SQLite transaction supplies the OS-released cross-process mutex;
operational state and availability are atomically written JSON, not a database
record. Only after verification is a separate SYSTEM task `documents-mcp-update`
registered. Its sole command is the verified `candidate.exe apply-update`, with
no parameters. It is independent of the service task, uses IgnoreNew, and keeps
a boot trigger and bounded failure retries until completion for crash recovery.
The internal command requires Administrator privileges, its fixed candidate
location, the stored signature, matching embedded version, and its own file hash.

It saves the previous executable and exact config, stages the new executable,
stops the service, swaps the binary, changes only `INSTALLED_VERSION`, starts the
service, and requires both loopback `/healthz` and authenticated
`/control/status.version` to confirm the new version, plus a private startup
receipt from the new live process after it successfully binds the HTTP port
(not just a potentially spoofed loopback HTTP response). A swap/start failure records
`install`; a failed health/version check records `health`. Both restore the old
binary and config and start the service. An interrupted apply rolls back on the
helper's next scheduled run. A failed rollback retains its journal and backups
for recovery; do not delete these files before investigating. After completion
the task and temporary files are removed, leaving `<binary>.previous`. Windows
cannot delete a running helper executable, so the service retries its cleanup
every five seconds after the helper exits.

This is SYSTEM-level execution: token leakage or a compromised Cue may trigger
only a newer signed official release, not arbitrary code. It can still cause
bandwidth use and service restarts. The signing key and release/build pipeline
are therefore critical trust roots; a malicious signed release is trusted.
Local Administrators/SYSTEM, writable/reparse-point system directories, and an
already compromised service process are outside the remote-token threat model.
Keep ProgramData/Program Files ACLs restricted to SYSTEM/Administrators. The
mechanism is not Authenticode, does not revoke historical signatures, and cannot
prevent freezing the latest-release endpoint or blocking updates. The initial
pinned key has no automatic rotation/revocation path.
Do not run a privileged manual install/uninstall concurrently with a remote
update; the remote-job mutex does not coordinate the legacy local installer.

### Release signing

After building all release executables, run `node scripts/sign-release.mjs` in a
trusted release environment. Supply the Ed25519 private-key PEM in
`DOCUMENTS_MCP_SIGNING_KEY` or through stdin from your secret manager. Never put
the private key in the repository, a command-line argument, logs or release
assets. The script streams the Windows executable from `release/`, uses the
package version, signs the manifest, verifies against the **same pinned public
key**, and only then writes `release/update-manifest.json` and
`release/update-manifest.json.sig`. A wrong key fails without writing these
assets. Publish both alongside `documents-mcp-win-x64.exe` from that exact build;
publish the complete release before marking it latest. Do not edit manifest bytes
after signing. Tests use only ephemeral generated keys, never the release key.

Before relying on this feature, exercise a **real Windows Server** installation:
SYSTEM ACL inheritance, task registration/security/boot recovery, independent
helper survival after `/End` and taskkill, locked executable rename retries,
antivirus interference, both disk volumes, interrupted power, rollback and
authenticated version health checks. Dependency-injected tests on macOS do not
establish these operating-system guarantees.

## Docker alternative

Docker is **optional**, not the main installation path. The Dockerfile uses Node 24 and the same pure-JS/WASM runtime: it installs no Poppler or OCR packages. Compose uses a non-root user, a read-only container filesystem with a **read-write document bind mount**, a private temporary directory, no added capabilities and a separate index volume. Grant the container user write access to the document folder. Optional `READ_ONLY=1` hides write tools; for an additional mount-level restriction, change the document mount to `:ro`. Cloudflared runs inside the application container from the bundled assets, not a separate image.

Set `DOCS_PATH`, `MCP_TOKEN` and optionally `TUNNEL_TOKEN` in `.env`, protect it with mode `0600`, grant UID/GID 1000 read/traverse access to documents, then run:

```sh
docker compose up -d --build
docker compose logs --tail=50 documents-mcp
docker compose exec documents-mcp node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>console.log(r.status))"
```

Use the same Cloudflare service URL **`http://localhost:3000`**, since the embedded tunnel shares the application container. Compose publishes no host port. If you intentionally need direct local access without a tunnel, add an explicit loopback-only port mapping and keep bearer authentication.

## Troubleshooting

- **Linux service:** `sudo systemctl status documents-mcp`, `sudo journalctl -u documents-mcp -n 100 --no-pager`. `Restart=always` restarts application crashes; the tunnel also has its own backoff loop.
- **Windows:** inspect Task Scheduler → `documents-mcp`, its Last Run Result and task history. `documents-mcp.exe status` displays scheduler output and index counters. Confirm Administrator execution and local folder ACLs.
- **Local health fails:** check `PORT`, another process using it, config/data permissions, free disk space and folder access. Installation remains present for diagnosis if startup checks fail.
- **Public health fails, local works:** inspect `[tunnel]` logs, the saved token, DNS, outbound network policy and the exact Cloudflare service URL. `PUBLIC_URL` alone does not create a route or DNS record.
- **Slow tool calls:** each call logs `duration_ms`. A warning with `blocked_ms` means the main thread was busy for that long and every request waited; `indexing` tells whether a scan was running.
- **401:** use the saved **MCP token**, not the Cloudflare tunnel token. `token` prints it only with elevated privileges.
- **OCR language error:** `OCR_LANGS` accepts only `rus`, `bel`, `eng` joined by `+`; there are no runtime downloads or optional system language packs.
- **Partial/failed file:** use `documents_status`; check page/file/text limits, encryption and scan structure. Correct or modify the file to retry. To rebuild, stop the service first, delete only its index database/WAL/SHM, then start again; keep config/tokens.
- **Runtime integrity/disk error:** runtime files are reconstructible cache. Stop the service, remove only its `runtime` directory, fix permissions/free space, then restart. Never place the index inside documents.
- **Corporate proxies or AV policies:** build downloads require access to nodejs.org/GitHub; destination OCR needs no network, but Cloudflare Tunnel needs permitted outbound access. Ad-hoc signing on macOS is not notarization.
