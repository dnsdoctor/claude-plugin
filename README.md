# DNS Doctor — Claude Code plugin

Diagnose and fix a domain's email authentication (SPF, DMARC, DKIM, MX, blacklist,
domain/SSL expiry) from inside Claude. This plugin bundles the DNS Doctor **skill**
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
├── LICENSE                      # Apache-2.0
└── README.md
```

## Tools it adds

| Tool | Does |
|---|---|
| `scan_domain` | Fresh scan of a domain; full report. |
| `get_report` | Persisted report (scans once if none exists). |
| `build_dmarc_upgrade` | A validated DMARC enforcement record — `p=reject` only when the server-derived alignment gate passes. |
| `enroll_monitoring_trial` | Emails a human a double-opt-in link that creates their free account; monitoring starts once they add the domain and verify it with a TXT record. |

The `dnsdoctor://domains` resource (your monitored domains) is always listed;
reading it needs an API token and is refused without one. Anonymous access is
enough for a one-off diagnosis.

## Install

### Claude Code

Add the marketplace/repo and enable the plugin:

```bash
/plugin marketplace add dnsdoctor/claude-plugin
/plugin install dns-doctor
```

> Public home: [github.com/dnsdoctor/claude-plugin](https://github.com/dnsdoctor/claude-plugin)
> (org `dnsdoctor`, domain-verified). The plugin is developed in the DNS Doctor
> monorepo and published there as clean release snapshots — see
> `docs/oss-conventions.md` for the publish rules.

Or point Claude Code at a local checkout of this directory during development.
Once enabled, the skill auto-loads and the `dns-doctor` MCP server connects to
`https://dnsdoctor.dev/mcp`.

### claude.ai (MCP connector)

Add a custom connector with:

- **URL:** `https://dnsdoctor.dev/mcp`
- **Transport:** Streamable HTTP
- **Auth:** none (anonymous) — or a Bearer token (below)

## Optional: API token for monitored domains

Anonymous access covers scanning and fixes. A per-account API token unlocks the
`dnsdoctor://domains` resource (your continuously-monitored domains and their
latest per-check statuses).

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

### Local (stdio) instead of hosted HTTP

From a checkout of the DNS Doctor repo:

```json
{
  "mcpServers": {
    "dns-doctor": {
      "command": "python",
      "args": ["-m", "dns_doctor.mcp_server"]
    }
  }
}
```

stdio runs anonymous (scanner tools only; no `domains` resource).

## Worked example

> **You:** Our invoices keep landing in customers' spam. Domain is `example.com`.
>
> **Claude** (`scan_domain` → `example.com`): DMARC is at `p=none`, so nothing
> enforces alignment — receivers can't tell your mail from a spoof. SPF passes with
> 7 of 10 lookups used. DKIM: a selector was found and is valid. Not blacklisted.
> Domain expires in 240 days.
>
> **Claude** (`build_dmarc_upgrade` → `example.com`): SPF is aligned and DKIM is
> present, so enforcement to `p=reject` is safe. Publish this exact TXT record at
> `_dmarc.example.com` — **paste it verbatim, don't edit it**:
>
> ```
> v=DMARC1; p=reject; rua=mailto:dmarc@example.com; adkim=r; aspf=r
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
