# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

Do **not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's [Security Advisories](https://github.com/SuarezPM/claude-gemini-compactor-mcp/security/advisories/new).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You will receive a response within 72 hours. If confirmed, a patch will be released within 14 days.

## Security Model

- **Path traversal:** All file paths validated against `process.cwd()` at server startup.
- **SSRF:** `ask_gemini_url` blocks `file://`, `ftp://`, localhost, and RFC-1918 private IP ranges.
- **Fetch timeout:** URL fetches abort after 15 seconds.
- **Size caps:** Files capped at 50MB; URL responses capped at 10MB.
- **API keys:** Never logged, never sent to Claude's context window.
- **Fail-fast:** Server exits on missing `GEMINI_API_KEY` at startup.
