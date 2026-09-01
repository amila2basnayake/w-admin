# Waterfind AUS CRM — source checkouts

SVN working copies of the legacy CRM projects, checked out here for local dev. **These are managed
by SVN, not git** — everything in `crm/` except this README is gitignored.

- **Repository:** `svn+ssh://chris@svn.nowmarketservices.com/svn/repo/WaterfindDev`
- **Branch:** `Iteration46` (each project's `branches/Iteration46`)
- **Auth:** SSH key `~/.ssh/waterfind_svn.pem` (passphrase-protected). The server is OpenSSH 6.6.1, so
  ssh must be told to use the legacy `ssh-rsa` (SHA-1) signature — see `../onboarding_log.md` §SVN.

## Projects (the 7 from the onboarding doc)

| Folder | SVN path |
|---|---|
| `dataimport` | `dataimport/branches/Iteration46` |
| `datascraper` | `datascraper/branches/Iteration46` |
| `MyobService` | `MyobService/branches/Iteration46` |
| `NotificationService` | `NotificationService/branches/Iteration46` |
| `pbxapp` | `pbxapp/branches/Iteration46` |
| `waterfind.com.au` | `waterfind.com.au/branches/Iteration46` |
| `WaterfindServiceModel` | `WaterfindServiceModel/branches/Iteration46` (doc calls it `waterfindServiceModel`) |

## Updating

```sh
cd crm/<project>
svn update
```

If a checkout was interrupted, run `svn cleanup` then `svn update` to resume.
