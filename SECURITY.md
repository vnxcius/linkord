# Security

Please don't report vulnerabilities in public issues. Use GitHub's private reporting instead: the repository's
**Security** tab → **Report a vulnerability**. Include what's affected (server, web, desktop, Android, monitor), how
to reproduce it and what an attacker could do with it.

Only the latest `master` is supported; fixes ship as new releases, which installed apps pick up through their updaters.

If you run your own instance: keep `LINKORD_DEV_LOGIN` off, keep the monitor on loopback or your LAN, and back up
`server/data/message.key` (messages are encrypted at rest with it) and your signing keys somewhere off the machine.
