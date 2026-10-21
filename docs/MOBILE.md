# GitHub Sync — Android / iPhone / iPad (beta)

Mobile support starts with plugin **1.1.0-beta.1** and Obsidian **1.11.4+**.
The plugin uses `isomorphic-git` on mobile and retains native Git (`simple-git`) on desktop.

## Prerequisites
- Use a GitHub repository with a **main** branch, or a brand-new repository with no commits or branches. Repositories containing only other branches (such as `master`) are not supported.
- All other devices have completed their pending pushes.
- On mobile, use an **HTTPS** GitHub repository URL (not SSH).
- For private repositories create a **fine-grained GitHub personal access token**:
  grant repository **Contents: read and write** for only the target repository.
  Do not put the token in the remote URL.
- Keep vaults backed up, particularly during this beta.

## Set up a new mobile device
1. Install the plugin into your Obsidian mobile vault. Select a **new, otherwise empty vault**. The default `.obsidian` settings directory is acceptable as long as its files do not overlap files in the remote vault.
2. In plugin settings, paste the remote HTTPS URL (`https://github.com/OWNER/NOTES.git`).
3. Under **GitHub token**, create/select a secret in Obsidian SecretStorage, then choose it for the plugin. A public repository does not necessarily need a token for fetch, but push requires authentication.
4. Set commit author name and email.
5. Use the **Sync with Remote** command. For an existing `main`, the first sync fetches without checking out files, checks for collisions and checks out remote notes. For a brand-new empty repository, it initializes a local unborn `main` without checking out anything. The first note you create and sync creates `main` on GitHub.
6. Verify a small test note syncs from mobile to desktop and back.

**Safety:** The plugin refuses initial checkout when an existing local file would be overwritten.
If setup pauses on a filename collision, back up or move the local file, then retry.
If the vault already contains unrelated notes, it will refuse initial cloning.
This version cannot merge independently created vault histories.

## How syncing works
- Local changes are committed first (including additions and deletions).
- Remote changes are fetched and merged into `main` when it exists. Empty remotes do not require fetch or pull.
- Sync aborts on conflicts or network failures without executing push.
- Outgoing commits are pushed to `main`, even if no additional files changed.
- One sync operation runs at a time.
- Scheduled sync runs while Obsidian is open. iOS and Android may suspend it in the background; closed-app/background sync is **not** supported.
- The desktop keeps its existing support for SSH, native Git and the configured Git binary.

## Important limitations
- **Beta:** Test with copies of your notes before relying on this for primary data.
- **main only:** Only `main` is synchronized; other branches and Git submodules are not supported. A remote that has only `master` requires creating or renaming `main` first.
- **Mobile HTTPS only:** SSH transport is desktop-only.
- Git history, images, attachments and large vaults can consume significant RAM on phones.
- Simultaneous edits can create conflicts; solve these on desktop with a Git client, then retry the mobile sync.
- Git metadata is stored under `.git` using Obsidian's DataAdapter.
- Secrets reside in Obsidian SecretStorage, not in the plugin's `data.json`.
- Do not use GitHub Sync together with another automated sync service writing the same vault, unless you understand the conflict risks.

## Validation matrix
- [ ] Fresh clone: Android phone
- [ ] Fresh clone: Android tablet
- [ ] Fresh clone: iPhone
- [ ] Fresh clone: iPad
- [ ] Fresh clone with a remote vault that tracks .obsidian settings
- [ ] Local edit → commit → push; desktop pull
- [ ] Desktop edit → mobile pull
- [ ] Concurrent edits with divergent commit histories
- [ ] Binary attachments and folders with spaces/Unicode
- [ ] Interrupted network connection, then retry
- [ ] App suspended or terminated during fetch/checkout
- [ ] No duplicate sync when invoked twice
- [ ] Private repository with a read/write fine-grained token
- [ ] Verify desktop functionality remains unchanged

## Diagnosing a failed sync on Android or iOS

If **Sync with Remote** still fails, open **GitHub Sync → Settings → Last sync error**
and select **Copy**. The report stores a timestamp, sanitized error name,
short redacted message and up to five safe function/file/line frames. It never
includes the raw stack, token, URL or absolute file path. A successful sync
clears the prior report. The console still records the original error where
developer tools are available.

The mobile bundle includes its own browser `Buffer` implementation and does
not require Node's `buffer` module. A Node-only test is not sufficient to
validate the Obsidian WebView: install the updated build on the real device
and try **Test GitHub connection**, followed by **Sync with Remote**.
If the vault previously entered `pending`, do not delete `.git`; retry the
sync with the updated build.

The GitHub Actions compilation is not a substitute for on-device integration testing.
