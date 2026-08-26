# remote-dsh

Secure remote access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The npm package name is `remote-dsh`; the CLI command is `rdsh`.

```bash
npm install -g remote-dsh
rdsh host setup lan   # write ~/.rdsh/host.json (LAN gateway: pair auth)
rdsh host serve       # run the gateway in the foreground
```

> See `doc/overview/usage.md` for the full manual (`rdsh host setup lan|cloud`, `rdsh host join <hub>`, `rdsh hub serve`, ...).

## License

MIT — see [LICENSE](LICENSE). Brand assets are excluded (see project NOTICE).
