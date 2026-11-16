# Security policy

## Report a vulnerability

Report it privately: [new security advisory](https://github.com/HugoLopes45/pi-extensions/security/advisories/new). Do not open a public issue, and do not publish exploit details before the fix.

Give the package and Pi versions, the impact and the steps to reproduce, with fake data. Never send real tokens, credentials, request headers, conversations or session files.

Only the latest release of each package gets fixes. The project is maintained in spare time, with no response deadline.

## What counts

Each extension runs inside Pi with Pi's permissions. Install extensions only from sources you trust. Report privately when:

- **pi-context-kit** discloses data that it should not, for example through `recall` or a handoff note.
- **pi-claude-pro** exposes your Claude login or sends data that it should not. Anthropic can change or refuse subscription access at any time; that is not a vulnerability.
- **pi-onlooker** breaks its read-only boundary. It must not read a secret file such as `.env`, a private key or `.git/config`; read a file outside the project folder or the raw observed session journal; follow project guidance symlinks to ingest unrelated local text; call a tool other than `read`, `grep`, `find`, `ls` and `onlooker_report`; or send the agent's conversation anywhere other than the configured Onlooker model.

A wrong result, a compatibility error or an exhausted quota is not a vulnerability. Report it as a public bug, without private data.
