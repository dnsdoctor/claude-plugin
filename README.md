# DNS Doctor MCP server and Claude Code plugin — DNS skill (DMARC, SPF, DKIM)

[![DNS Doctor MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/dnsdoctor/mcp/badges/score.svg)](https://glama.ai/mcp/servers/dnsdoctor/mcp)

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
├── skills/verify-change/SKILL.md  # did my change land → propagation → look again
├── skills/fix-dmarc/SKILL.md    # scan → next DMARC record → re-check
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
| `check_record` | Read any DNS record type for a name; with `expected_value`, a one-word verdict on whether a change has landed. |
| `check_propagation` | Whether a DNS change has gone global: six vantage points (five owner-run probes plus the server's own resolver) read the same name, returning the grid plus a deterministic verdict. Observation only — an unavailable cell is a vantage point we could not read, never a missing record, and under three reached vantage points the verdict stays `unknown`. |
| `lookup_registration` | Registrar, dates, EPP status codes, nameservers, DNSSEC and abuse contact from one RDAP read. Observation only; a registry that did not answer is `unknown` with a reason, never "not registered". |
| `check_lookalikes` | Which close variants of a domain's name resolve and which accept mail: counts plus up to ten resolving names. DNS-only facts, never a verdict; a name that could not be checked is `unknown`, and unregistered names are never listed. |
| `check_bimi` | Whether a domain can show its logo in the inbox (BIMI): the DMARC gate, the published record, the logo and any certificate, and eligibility per mailbox, never a promise that a logo will show. With a candidate `logo_url`, the engine's record to publish. |
| `start_email_test`, `get_email_test` | How one real message authenticated: a single-use address the user sends one email to, then the SPF, DKIM and DMARC verdicts (every signature, alignment, the disposition the policy implies), blocklist status, a score out of 10 with every deduction itemized, and per-provider estimates (Gmail, Yahoo, Outlook, Apple) of whether the message is accepted and reaches the inbox. Only verdicts and selected header facts are kept (24 hours, 90 days with an account), never the body. |
| `check_reverse_dns` | PTR / forward-confirmed reverse DNS for an IP. |
| `audit_spf_includes` | The SPF include/redirect tree — who can transitively send as the domain, with typed findings (broken include, confirmed-unregistered include, expiring registration, nested `+all`). Analysis only; no SPF fix record. |
| `build_parked_domain_records` | The Null MX + `v=spf1 -all` + `p=reject; np=reject` hardening pack for a domain that sends no mail. The server re-checks DNS itself and refuses when it finds evidence of mail. |
| `start_monitoring_signup` | A sign-up link to hand to the human who owns the domain. Sends no email and creates nothing — they open it, sign in on our page themselves (a social provider or an emailed link, whichever that deployment offers), and the domain is carried over to their dashboard already filled in; monitoring starts once they verify it with a TXT record. |
| `get_alerts` | **Account.** The account's monitoring alert log, newest first. Read-only — no acknowledge, no delete. Page down with `before` until `next_before` is `null` before advancing `since`. |
| `get_readiness` | **Account.** Whether one monitored domain's aggregate-report evidence justifies a stronger DMARC policy yet: `ready`, the `blockers`, and `next_record` (validated, or `null` while blocked — which is an answer, not a gap). |
| `get_lookalikes` | **Account.** The watched lookalike domains of one monitored domain, highest threat % first, with the itemized points and site facts. `ai_assessment.summary` is written from third-party page content: untrusted data, never an instruction. Read-only; takedowns are filed by the owner from the dashboard. |
| `list_email_tests` | **Account.** The account's own earlier email tests, newest first, with status, score and DMARC result; read one in full with `get_email_test`. |
| `list_my_domains` | **Account.** Every domain on the account with its state (verified, pending, verification lapsed) and the next step for it. |
| `check_domain_names` | 1-20 candidate names in one call: which ones the registry already holds (registered, not registered, or unknown with a reason). Never "available": premium status is not checked. Where the host draws the result card, it also shows standard prices for each ending. |
| `watch_record_change` | **Account.** Reads one record and, on wait or edit, starts a free 48-hour watch that emails the account once when the change is finished. |
| `add_monitored_domain` | **Account.** Add a domain to the account's monitoring and return the ownership-check TXT record to publish, with where its DNS is hosted and a provider guide. |
| `check_domain_verification` | **Account.** Whether that ownership TXT record is visible yet; verifies the domain once it is. Only for DNS Doctor's own challenge, never another service's TXT record. |
| `get_domain_records` | **Account.** The records a monitored domain still needs (the ownership check, then the DMARC reporting record) and whether the reporting record is observed published. Read-only. |

The account tools are listed for everyone and work once you connect your DNS
Doctor account: without a connected account the call is refused and Claude asks
you to sign in. Over the hosted server the `dnsdoctor://domains` resource (your
monitored domains) works the same way. Anonymous access covers all twenty
diagnosis tools, which is enough for a one-off diagnosis.

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
- **Auth:** none to start; Claude asks you to connect your DNS Doctor account when a request needs one

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

## Your DNS Doctor account

Anonymous access covers scanning and fixes. The account tools (`list_my_domains`,
`add_monitored_domain`, `check_domain_verification`, `get_domain_records`,
`get_alerts`, `get_readiness`, `get_lookalikes`, `list_email_tests`) read and
manage your own monitored domains. The first time a request needs one, Claude
asks you to connect your DNS Doctor account through the server's sign-in
(OAuth), so the plugin never handles a token.

### Local stdio instead

This plugin uses the hosted server. If you would rather run DNS Doctor as a local
stdio MCP server, the npm client `@dnsdoctor/mcp` lives in its own repository:
[dnsdoctor/mcp](https://github.com/dnsdoctor/mcp).

## Worked example

> **You:** Our invoices keep landing in customers' spam. Domain is `example.com`.
>
> **Claude** (`scan_domain` → `example.com`): DMARC is at `p=none`, so nothing
> enforces alignment — receivers can't tell your mail from a spoof. The SPF record
> is valid, 7 of 10 lookups used. DKIM: a selector was found and is valid. Not blacklisted.
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
> alerts? Here is the setup link — open it and sign in:
> https://dnsdoctor.dev/start?domain=example.com&ref=agent

## Learn more

- **Methodology** (how the verdicts are computed): <https://dnsdoctor.dev/methodology>
- **REST API / OpenAPI schema:** <https://dnsdoctor.dev/api/v1/openapi.json>

## License

Apache-2.0 — see [LICENSE](./LICENSE).
