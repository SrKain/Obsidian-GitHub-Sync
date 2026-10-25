### Changelog 1.1.0-beta.1 (fork: SrKain)
- Experimental Android and iOS support using isomorphic-git and Obsidian Vault adapters.
- Mobile GitHub HTTPS authentication via Obsidian SecretStorage.
- Initial clone collision protection and serialized synchronization.
- Mobile compilation and filesystem smoke tests in GitHub Actions.
- [Read the mobile setup guide and safety limitations](docs/MOBILE.md).

> **Beta notice:** Tested through automated compilation and simulated mobile filesystem operations, **not yet verified on real Android/iOS devices**. Back up your vault before testing.

### Changelog 1.0.7
- Simplified the sync success notice so successful runs show a shorter confirmation message.

### Changelog 1.0.6
- Plugin loads faster on start up

### Changelog 1.0.5
- Added option to automatically sync on start up if behind remote
- Added "Sync with Remote" command to command palette

### Changelog 1.0.4
- Simplified setup process.
- Allow SSH url for remote.

![](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22github-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)

# GitHub Sync

Simple plugin that allows you to sync your vault to a personal GitHub repo for **syncing across devices**.

## Highlights
- Sync your vault with a single ribbon action.
- Reduce notice noise with configurable notice levels.
- Keep the success notice to one short confirmation message or hide it entirely.

![](screenshots/ribbon-button.png)

## How to Use
Click the **Sync with Remote** ribbon icon to pull changes from your GitHub repo and push local changes. 
If there are merge conflicts, the plugin opens the affected files and stops the sync. Resolve each conflict and stage the resolved files with `git add <path>` (or through another Git client) before syncing again. Do not push unresolved conflict markers.

The plugin also pushes existing local commits when the working tree is clean. If a sync is already running, a second request is skipped to avoid overlapping Git operations.

## Resolve conflicts inside Obsidian (desktop beta)

When a sync encounters conflicting Markdown edits, **GitHub Sync opens a
side-by-side resolver** on desktop. You can also open **Resolve GitHub Sync
conflicts** from the command palette.

1. Inspect the **Local version** and **GitHub version** for each `.md` file.
2. Select **Use local**, **Use GitHub**, or edit the **Final note** to preserve
   content from both versions. The editable result initially includes the
   working-tree text, which may contain Git conflict markers.
3. Select **Apply to this note**. The plugin first saves a JSON backup under
   the local vault's `.git/github-sync-backups/`, writes the selected content,
   and stages only that resolved path. It does **not** push automatically.
4. Repeat for every conflicted note, then select **Finish and sync**. The plugin
   resumes the merge and pushes only if there are no remaining conflicts.

**Safety and limitations:** Resolve from one device at a time. If a note changes
while the dialog is open, applying is rejected and you must reopen the resolver.
The visual workflow supports two-sided text conflicts in Markdown files up to
200,000 characters per version. Binary attachments, deletion conflicts,
non-Markdown files, and mobile merge completion still need a desktop Git client.
The mobile beta continues to show non-destructive guidance. Do not manually
remove Git conflict markers and assume that the merge is complete; Git's index
must also be resolved. Always test with a backup vault before upgrading.

## Setup

### Setting up a GitHub repo
If your vault is already set up as a GitHub repository, you can skip this step. Otherwise, create a new public or private GitHub repository that you want to use for your vault.

Navigate to your vault and `git init` the folder. 
At this point, add anything you don't want syncing across your devices to a `.gitignore`.

This is not required, but you should try pushing your vault to your GitHub repository before continuing to make sure you can do that in the first place before using this plugin:
```
git add .
git commit -m "my obsidian vault first commit"
git branch -M main
git remote add origin <remote-url>
git push -u origin main
```
Verify that this works before continuing.

> For simplicity, this plugin does not support branching. Everything gets pushed to main.

### Setting up remote URL
All this plugin needs now is your GitHub repo's remote URL. You can grab this from the GitHub repo page for your vault:

![](screenshots/remote-url.png)

You can use either the HTTPS or SSH url. Grab it and paste it in the GitHub Sync settings tab like so:

![](screenshots/new-settings-page.png)

Done. Try clicking the Sync button now - it should work.

The first time may prompt you to authenticate if you haven't, or it may ask you to configure git with your email and name.

### Optional

You can reduce UI noise from sync operations with the `Notice level` setting:
- `ALL` shows every GitHub Sync notice.
- `WARNING` shows only warnings and errors.
- `ERROR` shows only error notices, so sync can run mostly in the background.

You can also use `Hide Success Message` to suppress the single confirmation notice shown after a successful sync. With the toggle off and `Notice level` set to `ALL`, a successful sync shows exactly one success message instead of multiple informational notices.

If your git binary is not accessible from your system PATH (i.e. if you open up Command Prompt or Terminal and can't use git), you need to provide its location. I initialize git only when launching Cmder, so I need to input a custom path like so: `C:/Users/Kevin/scoop/apps/cmder-full/current/vendor/git-for-windows/cmd/`. Note that I excluded `git.exe` from the end of the path.

You can also include your GitHub username and personal access token in the remote url. Like so: `https://{username}:{personal access token}@github.com/{username}/{repository name}`. This is not recommended anymore, but it was how the plugin worked prior to 1.0.4. If you're doing this, you'll have to add `.obsidian/plugins/github-sync/data.json` to your `.gitignore`. See: https://github.com/kevinmkchin/Obsidian-GitHub-Sync/issues/2#issuecomment-2168384792.

## Rationale

This plugin is for personal use, but I figured others might find it useful too. This is basically a glorified script - the code is tiny its like ~200 SLOC.
I keep a private GitHub repository for my Markdown notes, and I wanted some way to pull/push my notes from within Obsidian without opening a command line to run a script or set up an auto sync script on a timer. I don't use Git branches for my notes so this plugin doesn't support branching. 

The Node API used by this plugin works with any remote host, but I use GitHub so I centered the whole plugin around that.

Mobile support could come in the future depending on how much I need it myself.

Follow my stuff at https://kevin.gd/

