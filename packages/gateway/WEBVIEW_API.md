# rdsh-gateway WebView API

The gateway injects a small JavaScript contract into the DSH web page it serves, so a WebView client can drive the conversation without re-implementing DSH DOM details.

## Injection

A `<script>` is inserted before `</head>` (see `injectHtmlScript`). It defines `window.__rdshWebViewApi`. Injection is **idempotent**: if the object already exists, it is left untouched.

## Contract

```js
window.__rdshWebViewApi = {
  version: 2,
  fillAndSend(text) -> 'ok' | 'no-composer' | 'fill-failed',
  readReply() -> base64 JSON,
  isDshPage() -> '1' | '0',
}
```

### `version`

Monotonic implementation version. A client with its own built-in bridge compares the two `version` values and uses the **higher** one; a missing or non-numeric version is treated as `1` (lowest), so an older gateway automatically loses to a newer client bridge.

### `fillAndSend(text)`

Writes `text` into the composer and presses Enter. Returns a bare status token:

- `ok` — inserted and submitted;
- `no-composer` — no Lexical / contenteditable / textarea composer found;
- `fill-failed` — the insert pipeline failed.

While inserting, the gateway sets `window.__rdshInserting = true` and clears it right after, so the client's focus gate can allow the programmatic focus. The gateway does **not** implement a keyboard guard of its own.

### `readReply()`

Returns a UTF-8-safe base64 encoding of:

```json
{
  "dsh": true,
  "streaming": 0,
  "text": "",
  "turn": -1,
  "userTurn": -1,
  "userText": "",
  "reasoning": "",
  "activity": { "kind": "thinking", "label": "", "detail": "" },
  "rich": { "code": 0, "table": 0, "file": 0 },
  "question": { "key": "", "text": "" }
}
```

`question` is `null` when no question card is pending.

Field rules (v2):

- `text` — latest agent answer prose (reasoning / think / code / table excluded); on a non-DSH page it is the whole visible text.
- `streaming` — count of `[data-streaming]` elements (>0 while generating).
- `turn` — highest `data-chat-turn` among answer parts; `userTurn` — highest among user messages; both `-1` when absent.
- `userText` — latest user message text.
- `reasoning` — latest reasoning text with the `思考` title prefix (and optional `:`/whitespace) stripped.
- `activity` — `thinking` while reasoning runs (`[data-variant="think"][data-state="running"]`); `writing` while streaming; finer `commands` / `edit` / `read` / `web` / `tools` / `subagents` / `plan` / `questions` from the process header (`[data-process-activity]`, mapped from `commands`+`code` / `edit`+`write` / `read`+`readImage`+`search` / `webSearch`+`webFetch` / `tools` / `subagents` / `plan` / `questions`); else `tool` while a command/tool card runs (`[data-variant="others"][data-state="running"]`), a current-turn `tool-call` exists (`userTurn > turn`), or the `深度求索中` marker is present (`[data-chat-running]` without `data-holding`); otherwise `idle`.
  - `activity.label` — the specific argument (command / file path / query / URL) for the finer kinds, taken from the process-header title after the fixed ` · ` separator; empty when the header shows no detail.
- `rich` — `code`/`table` count within the latest-turn answer; `file` counts `[data-presented-file]` cards **page-wide** (deliverables persist in the session).
- `question` — the pending question card (`[data-question-key]`), read-only: its `key` and visible `text` (header + question + options).

### `isDshPage()`

Lightweight flag: `'1'` when `[data-chat-flow-kind]` nodes exist, else `'0'`. Safe to poll right after page load.

## Safety

- Idempotent: already-injected is a no-op.
- Defensive: any missing DOM or exception returns a safe default; the script never throws.
