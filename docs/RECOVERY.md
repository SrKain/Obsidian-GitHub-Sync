# GitHub Sync 2.0 — safe recovery

GitHub Sync refuses force-push, hard reset and automatic overwrite of conflicting
notes. A failed synchronization does **not** mean your local changes are lost:
inspect the repository state before attempting cleanup.

## Connection setup
1. Open **GitHub Sync → Guided setup** or the command **Set up GitHub Sync**.
2. Paste the HTTPS GitHub clone URL. SSH remains available only on desktop.
3. On mobile, select a fine-grained GitHub token from Obsidian SecretStorage,
   scoped to the correct repository with Contents read/write.
4. Use **Test GitHub connection**. A successful test verifies read connectivity,
   not write permission, which is confirmed by the first push.
5. Inspect whether the current vault is empty or already has a Git history.
   Do not merge unrelated Git histories automatically.

## After a conflict
1. Do **not** delete `.git`, force-push or reset the repository to make the error disappear.
2. The conflict dialog lists affected paths when Git exposes them.
3. Use **Open note** to inspect the conflicted file. Use **Save copy** to duplicate
   the currently visible content (it may include conflict markers).
4. On desktop, resolve the merge with your Git client. For Markdown you may
   combine text; for binaries, choose the intended file version after making
   external backups.
5. Stage each resolved file and commit the merge. Retry synchronization.
6. If working on mobile and the Git engine cannot complete the merge, perform
   advanced resolution on desktop, where native Git is supported.

The plugin does not yet provide a fully automatic three-way merge editor. It
will not pick a winner silently.

## Credential exposure and tracked plugin settings

Do not put a personal access token in a remote URL. The plugin refuses an
authenticated URL, and it will refuse to sync if Git tracks
`.obsidian/plugins/github-sync/data.json`. For a vault using a different
Obsidian config folder, that folder's corresponding settings file is also
protected by the desktop runner.

From desktop, after making a backup, untrack the sensitive settings file:

```sh
git rm --cached .obsidian/plugins/github-sync/data.json
printf '\n/.obsidian/plugins/github-sync/data.json\n' >> .git/info/exclude
git commit -m "Stop tracking plugin settings"
```

The historical contents may remain in Git history even after the removal.
Rotate exposed tokens and consider purging affected histories before sharing
a previously public repository. Do not distribute personal notes publicly.

## Failure categories

| Condition | Safe response |
| --- | --- |
| Offline, HTTP 502/503/504, connection reset | Fetch retries a limited number of times; no force-push |
| Missing/expired token | Select a valid SecretStorage secret; stop retrying until repaired |
| Rejected write permissions | Check fine-grained token scope and branch rules |
| Wrong origin | Check both remote addresses; plugin does not silently redirect |
| Git merge conflicts | Resolve files without deleting Git metadata or forcing remote changes |
| Missing Git history in populated vault | Connect a new vault or import existing history first |

Automatic sync operates only while Obsidian is running. Device shutdown or
background suspension may interrupt it, particularly on Android and iOS.

**Release criterion:** integration tests in a simulated vault do not replace
real-device testing of startup, suspension, large attachments, and Git credentials.
