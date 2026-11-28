# Security

Do not commit data, credentials, JWTs or read tokens. Run a single instance behind HTTPS with durable storage. Keep source access disabled until confirmed by each provider; HTTP 403 persists until operator review. Only fixed upstream URLs and read-only bounded APIs. Source timestamps are immutable on cached reads. Report vulnerabilities privately to the repository owner. No personal or intra-company data is collected. Production rollout requires backup/restore drills, end-to-end testing and rate limits at the ingress. These controls are not a security certification.

Browser transport: MOSE only, explicit opt-in, sandbox required, no challenge interaction or retry after denial; restrict network egress at hosting layer. Keep Chromium patched and dependency lock reviewed. Never pass URLs from API callers to the browser.
