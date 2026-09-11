# dsh-agent-mesh

> ⚠️ **Placeholder release (0.0.1).** This package currently only **reserves the npm name**. There is no functional code yet — calling into it throws on purpose, so that nothing fails silently. **Please do not install it yet.**

## What it will be

A **cross-host agent mesh for DeepSeek Harness**: let the DSH agents running on *your own* machines (same account) discover each other, hand work to each other and answer each other — with messages end-to-end encrypted and relayed through your existing outbound tunnel (no public IP, no new ports, no shared session state).

It is for the everyday situation where **the machine that can do the work is not the machine you are working on**:

- the data, the GPU, the device, or the network position lives somewhere else;
- you want to dispatch a long task to another machine and come back for the result;
- you want to ask several of your machines at once and collect the answers.

## Status

| Version | State |
|---|---|
| `0.0.1` | **Name reservation only** — no functionality |

Design, requirements and decisions live in the repository:

- [What & why (plain-language version included)](https://github.com/floatinghotpot/remote-dsh/blob/main/doc/feature/21-agent-mesh/what-and-why.md)
- [Requirements and acceptance criteria](https://github.com/floatinghotpot/remote-dsh/blob/main/doc/feature/21-agent-mesh/req.md)
- [Facts, decisions and implementation notes](https://github.com/floatinghotpot/remote-dsh/blob/main/doc/feature/21-agent-mesh/discussion.md)

## Not to be confused with

- **`dsh-mesh`** — an unrelated third-party package about crash-isolated multi-agent coordination **on a single machine** (files as messages, leases, dead-letter adoption). Different axis: that one keeps work from being lost when a process dies; this one moves work **between machines**.
- **`dsh-agent`** — an unrelated name reservation by another author.

## License

MIT — see the [repository](https://github.com/floatinghotpot/remote-dsh).

---

中文说明：`dsh-agent-mesh@0.0.1` 只是一个**占名版本**，没有任何功能；调用它会明确报错，不会有静默行为。设计与需求见仓库 `doc/feature/21-agent-mesh/`。
