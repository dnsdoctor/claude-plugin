# DNS Doctor — Claude Code plugin

Diagnose and fix email-deliverability DNS problems (SPF, DMARC, DKIM, MX, blacklists)
from Claude Code. Bundles the DNS Doctor skill and MCP server config in one installable
plugin — deterministic, validated records; the AI never invents a record string.

```bash
/plugin marketplace add dnsdoctor/claude-plugin
/plugin install dns-doctor
```

**First release lands shortly** — the plugin is in final review.

- Site: https://dnsdoctor.dev
- How verdicts are computed: https://dnsdoctor.dev/methodology
- MCP endpoint: `https://dnsdoctor.dev/mcp`

Apache-2.0.
