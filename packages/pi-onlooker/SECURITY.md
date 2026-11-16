# Security

## Report a vulnerability

Report it privately: [new security advisory](https://github.com/HugoLopes45/pi-extensions/security/advisories/new). Do not open a public issue.

Give the pi-onlooker and Pi versions, the impact, and the steps to reproduce. Use fake data. Never send real tokens, credentials, conversations or session files.

Only the latest release gets fixes. The project is maintained in spare time, with no response deadline.

## What counts

The Onlooker must only read, and only inside the project. Report it if the Onlooker can:

- read a secret file, such as `.env`, a private key or `.git/config`;
- read a file outside the project folder through its tools, or read the raw observed session journal;
- follow project guidance symlinks to ingest unrelated local text;
- call a tool other than `read`, `grep`, `find`, `ls` and `onlooker_report`;
- send the agent's conversation anywhere other than the configured Onlooker model.

A wrong or missed finding is not a vulnerability. Report it as a public bug, without private data.
