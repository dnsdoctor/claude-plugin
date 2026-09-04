# DNS Doctor — Claude Code plugin & DNS skill (DMARC, SPF, DKIM)

Scan, fix and verify a domain's DNS — email authentication (SPF, DMARC, DKIM)
first, plus multi-region propagation, SPF include supply-chain audits, MX, DNS
health, blacklists and domain/SSL expiry — from inside Claude. This plugin bundles the DNS Doctor **skill**
(the scan → diagnose → fix workflow) and an **MCP server config** pointing at the
hosted DNS Doctor tools.

The moat: every fix record you get back is generated and validated by a
deterministic engine — RFC grammar plus the SPF 10-lookup counter — **never an LLM
guess**. Your agent hands the human a record that already parses correctly, not a
plausible-looking string that silently fails.

## What's inside

```
claude-plugin/
├── .claude-plugin/plugin.json   # plugin manifest
├── .mcp.json                    # MCP server: https://dnsdoctor.dev/mcp (HTTP)
├── skills/dns-doctor/SKILL.md   # the scan → diagnose → fix workflow
├── src/                         # @dnsdoctor/mcp — the local stdio MCP server
├── tools.json                   # the 16 tool definitions (generated, never hand-edited)
├── instructions.txt             # the server's own `initialize` guidance (generated)
├── tests/                       # vitest suite for the stdio server
├── package.json  tsconfig.json  # npm package + build
├── LICENSE                      # Apache-2.0
└── README.md
```

## Tools

| Tool | Does |
|---|---|
| `scan_domain` | Fresh scan of a domain; full report. |
| `get_report` | Persisted report (scans once if none exists). |
| `build_dmarc_upgrade` | A validated DMARC enforcement record, capped at `p=quarantine` and returned only when the server-derived alignment gate passes; without that evidence the answer is reporting-first and no record is returned. `p=reject` comes from the readiness engine's aggregate-report evidence, never from a scan. |
| `count_spf_lookups` | The SPF DNS-lookup count against the RFC limit of 10. |
| `validate_dmarc_record` | Parse and validate a DMARC record, tag by tag. |
| `generate_dmarc_record` | Build a DMARC record from a policy + reporting address. |
| `check_dkim_selector` | Look up one DKIM selector and check the key. |
| `parse_dmarc_report` | Parse an aggregate (RUA) report file into rows. |
| `check_record` | Read any DNS record type for a name. |
| `check_propagation` | Whether a DNS change has gone global: six vantage points (five owner-run probes plus the server's own resolver) read the same name, returning the grid plus a deterministic verdict. Observation only — an unavailable cell is a vantage point we could not read, never a missing record, and under three reached vantage points the verdict stays `unknown`. |
| `check_reverse_dns` | PTR / forward-confirmed reverse DNS for an IP. |
| `audit_spf_includes` | The SPF include/redirect tree — who can transitively send as the domain, with typed findings (broken include, confirmed-unregistered include, expiring registration, nested `+all`). Analysis only; no SPF fix record. |
| `build_parked_domain_records` | The Null MX + `v=spf1 -all` + `p=reject; np=reject` hardening pack for a domain that sends no mail. The server re-checks DNS itself and refuses when it finds evidence of mail. |
| `start_monitoring_signup` | A sign-up link to hand to the human who owns the domain. Sends no email and creates nothing — they open it, sign in on our page themselves (a social provider or an emailed link, whichever that deployment offers), and the domain is carried over to their dashboard already filled in; monitoring starts once they verify it with a TXT record. |
| `get_alerts` | **Token required.** The account's monitoring alert log, newest first. Read-only — no acknowledge, no delete. Page down with `before` until `next_before` is `null` before advancing `since`. |
| `get_readiness` | **Token required.** Whether one monitored domain's aggregate-report evidence justifies a stronger DMARC policy yet: `ready`, the `blockers`, and `next_record` (validated, or `null` while blocked — which is an answer, not a gap). |

The two monitoring reads are **listed for everyone and callable with a token**:
they appear in the tool list on both transports, and without a valid token the
call is refused with the page the account owner mints one on. Over the hosted
HTTP transport the `dnsdoctor://domains` resource (your monitored domains) is
likewise always listed and refused without a token; the local stdio server
registers the tools only — no resource. Anonymous access covers all fourteen
diagnosis tools, which is enough for a one-off diagnosis either way.

## Install

### Claude Code

Add the marketplace/repo and enable the plugin:

```bash
/plugin marketplace add dnsdoctor/claude-plugin
/plugin install dns-doctor
```

> Public home: [github.com/dnsdoctor/claude-plugin](https://github.com/dnsdoctor/claude-plugin)
> (org `dnsdoctor`, domain-verified). The plugin is developed in the DNS Doctor
> monorepo and published here as clean release snapshots.

Or point Claude Code at a local checkout of this directory during development.
Once enabled, the skill auto-loads and the `dns-doctor` MCP server connects to
`https://dnsdoctor.dev/mcp`.

### claude.ai (MCP connector)

Add a custom connector with:

- **URL:** `https://dnsdoctor.dev/mcp`
- **Transport:** Streamable HTTP
- **Auth:** none (anonymous) — or a Bearer token (below)

### Any MCP client (standard config)

```json
{
  "mcpServers": {
    "dns-doctor": {
      "url": "https://dnsdoctor.dev/mcp"
    }
  }
}
```

## Optional: API token for monitored domains

Anonymous access covers scanning and fixes. A per-account API token unlocks the
account's own monitoring data: the `get_alerts` and `get_readiness` tools, and
the `dnsdoctor://domains` resource (your continuously-monitored domains and
their latest per-check statuses).

1. Sign in at <https://dnsdoctor.dev> → **Settings → API tokens** → create a token.
   The plaintext (`dnsd_…`) is shown once; copy it.
2. Add the `Authorization` header to the server in `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "dns-doctor": {
         "type": "http",
         "url": "https://dnsdoctor.dev/mcp",
         "headers": { "Authorization": "Bearer ${DNSDOCTOR_API_TOKEN}" }
       }
     }
   }
   ```

   Then export `DNSDOCTOR_API_TOKEN=dnsd_YOUR_TOKEN` in your environment. Never
   commit the token.

### Transport

Two supported public transports, same 16 tools:

- **Hosted streamable HTTP** — `https://dnsdoctor.dev/mcp`, wired in this
  plugin's `.mcp.json`. No install, no keys.
- **Local stdio** — `npx -y @dnsdoctor/mcp`. A thin server that runs on your
  machine and calls the public DNS Doctor REST API; it holds no diagnosis logic
  of its own and relays every record string verbatim.

```json
{
  "mcpServers": {
    "dns-doctor": {
      "command": "npx",
      "args": ["-y", "@dnsdoctor/mcp"],
      "env": { "DNSDOCTOR_API_TOKEN": "dnsd_YOUR_TOKEN" }
    }
  }
}
```

`DNSDOCTOR_API_TOKEN` is optional (anonymous access covers scanning and fixes;
the two monitoring reads need it).
`DNSDOCTOR_API_BASE` overrides the origin — it must be an origin that serves the
`/api/…` paths, i.e. the public site rather than a bare backend port.

### Build the stdio server from source

```bash
npm ci
npm test
npm run build      # -> dist/index.js, the package's bin entrypoint
```

`tools.json` and `instructions.txt` are **generated from the hosted server** and
pinned by a backend test — never hand-edit them, and never add a tool
description to `src/`. Both files ship in the npm tarball; without them the
client has no tools and none of its safety guidance.

## Worked example

> **You:** Our invoices keep landing in customers' spam. Domain is `example.com`.
>
> **Claude** (`scan_domain` → `example.com`): DMARC is at `p=none`, so nothing
> enforces alignment — receivers can't tell your mail from a spoof. SPF passes with
> 7 of 10 lookups used. DKIM: a selector was found and is valid. Not blacklisted.
> Domain expires in 240 days.
>
> **Claude** (`build_dmarc_upgrade` → `example.com`): SPF is aligned and DKIM is
> present, so the recommendation reaches its ceiling, `p=quarantine`. Publish this
> exact TXT record at `_dmarc.example.com` — **paste it verbatim, don't edit it**:
>
> ```
> v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=r; aspf=r; np=reject
> ```
>
> Apply it in your DNS host once you've confirmed it's approved, then ask me to
> re-scan to verify. Want the domain watched continuously with aggregate-report
> alerts? I can send a setup link to your email.

## Learn more

- **Methodology** (how the verdicts are computed): <https://dnsdoctor.dev/methodology>
- **REST API / OpenAPI schema:** <https://dnsdoctor.dev/api/v1/openapi.json>

## License

Apache-2.0 — see [LICENSE](./LICENSE).
