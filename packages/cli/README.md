# remote-dsh

Secure remote access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The npm package name is `remote-dsh`; the CLI command is `rdsh`.

```bash
npm install -g remote-dsh
rdsh setup lan   # write ~/.rdsh/host.json (LAN gateway: pair auth)
rdsh serve       # run the gateway in the foreground
```

> `rdsh host <cmd>` 仍可用（兼容别名）。Hub 命令已拆分到 `rdsh-hub-cli`（bin `rdsh-hub`），自建 hub 请 `npm install -g rdsh-hub-cli`。

> See `doc/overview/usage.md` for the full manual (`rdsh setup lan|cloud`, `rdsh join <hub>`, ...).

## License

MIT — see [LICENSE](LICENSE). Brand assets are excluded (see project NOTICE).
