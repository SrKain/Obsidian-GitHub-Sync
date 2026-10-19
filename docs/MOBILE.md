# GitHub Sync — Android / iPhone / iPad (beta)

Mobile support starts with plugin **1.1.0-beta.1** and Obsidian **1.11.4+**.
The plugin uses `isomorphic-git` on mobile and retains native Git (`simple-git`) on desktop.

## Prerequisites
- Your notes are already in a GitHub repository whose active branch is **main**.
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
5. Use the **Sync with Remote** command. The first sync fetches the repository without checking out files, checks for filenames that would overwrite existing local files, then checks out the remote notes.
6. Verify a small test note syncs from mobile to desktop and back.

**Safety:** The plugin refuses initial checkout when an existing local file would be overwritten.
If setup pauses on a filename collision, back up or move the local file, then retry.
If the vault already contains unrelated notes, it will refuse initial cloning.
This version cannot merge independently created vault histories.

## How syncing works
- Local changes are committed first (including additions and deletions).
- Remote changes are fetched and merged into `main`.
- Sync aborts on conflicts or network failures without executing push.
- Outgoing commits are pushed to `main`, even if no additional files changed.
- One sync operation runs at a time.
- Scheduled sync runs while Obsidian is open. iOS and Android may suspend it in the background; closed-app/background sync is **not** supported.
- The desktop keeps its existing support for SSH, native Git and the configured Git binary.

## Important limitations
- **Beta:** Test with copies of your notes before relying on this for primary data.
- **main only:** Other branches and Git submodules are not supported.
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

The GitHub Actions compilation is not a substitute for on-device integration testing.
