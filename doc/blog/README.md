# remote-dsh blog index (by use case)

> All posts are bilingual (`doc/blog/zh/` 中文 / `doc/blog/en/` English).
> Organized by "**how you reach your DSH**": pick your scenario, then the post.

---

## 1. LAN / VPN: direct IP access

| Scenario | Post |
|---|---|
| 1.1 Same Wi-Fi/LAN — browse the dev machine's IP from any device (pair code) | [LAN direct access](en/01-01-lan-access.md) |
| 1.2 On the road — VPN back into the LAN, then access by IP | [VPN back into the LAN](en/01-02-vpn-lan.md) |

## 2. Cloud server (ECS): direct public IP / domain access

| Scenario | Post |
|---|---|
| 2.1 Standalone with built-in cert / HTTPS (simplest) | [Cloud server direct (built-in TLS)](en/02-01-cloud-single-tls.md) |
| 2.2 Host behind Apache2 (443 + auto-renewed certs) | [Host behind Apache2](en/02-02-cloud-apache-acme.md) |
| 2.3 Host behind nginx | [Host behind nginx](en/02-03-cloud-nginx.md) |

## 3. No public IP (NAT / inner VM): relayed via a hub (host onboarding)

### 3.1 Add hosts (hosts belong to the hub user)

| Scenario | Post |
|---|---|
| 3.1.1 Sign up | ⏳ planned (see roadmap); currently accounts are created by the hub admin |
| 3.1.2 Sign in to the portal (user / password) | see usage.md §8.3 |
| 3.1.3 Add a host (join token): | |
| 3.1.3.1 Foreground (`rdsh host join <hub> --token <t>`) | [Join token one-click onboarding](en/03-04-join-token.md) |
| 3.1.3.2 Always-on service (`rdsh host service install`, boot-start / crash-restart) | [Join token one-click onboarding](en/03-04-join-token.md) (service variant) + [usage.md §8.5 service tips](../overview/usage.md) |

> No hub available yet? Run your own — see **Chapter 4** (run your own hub).

## 4. Run your own hub (relay service, hub admin)

### 4.1 Deploy the hub

| Scenario | Post |
|---|---|
| 4.1.1 Deploy hub on an ECS (built-in TLS) | [Hub public deployment](en/03-01-hub-public.md) (deployment part; host onboarding: see 3.1.3) |
| 4.1.2 Hub behind Apache2 | [Hub behind Apache2](en/03-02-hub-behind-apache-https.md) |
| 4.1.3 Hub behind nginx | [Hub behind nginx](en/03-03-hub-behind-nginx.md) |

### 4.2 Hub user management (create / password / revoke)

| Scenario | Post |
|---|---|
| 4.2.1 User management | see [usage.md §8.3](../overview/usage.md) |

> Once the hub is up, onboarding hosts is **Chapter 3** (relayed via a hub).

## 5. Manuals

| Doc | What |
|---|---|
| [usage.md](../overview/usage.md) | Full operations manual (install / config / commands / security / troubleshooting) |
| [roadmap](../overview/roadmap.md) | Milestones & plans (sign-up, multi-tenant, mobile, …) |
