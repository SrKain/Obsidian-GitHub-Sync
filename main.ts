import { App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { SimpleGitOptions } from 'simple-git';
import type { MobileSync } from './src/mobile/MobileSync';
import { PLUGIN_SETTINGS_PATH, publicErrorMessage, retryRead, sameRemote, validateRemote } from './src/core/SyncSafety';

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';


interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
	mobileTokenKey: string;
	mobileAuthorName: string;
	mobileAuthorEmail: string;
	lastSuccessfulSync: string;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
	mobileTokenKey: '',
	mobileAuthorName: 'Obsidian Mobile',
	mobileAuthorEmail: 'obsidian-mobile@users.noreply.github.com',
	lastSuccessfulSync: '',
}


export default class GHSyncPlugin extends Plugin {

	settings: GHSyncSettings;
	private syncInProgress = false;
	private mobileSync?: MobileSync;

	private async mobileEngine(): Promise<MobileSync> {
		if (!this.mobileSync) {
			const { MobileSync } = await import('./src/mobile/MobileSync');
			this.mobileSync = new MobileSync(this.app, () => this.settings);
		}
		return this.mobileSync;
	}

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity === 'WARNING' || severity === 'ERROR';
			case 'ALL':
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (!this.shouldShowNotice(severity)) {
			return;
		}

		const text = message instanceof Error ? message.message : String(message);
		new Notice(text, timeout);
	}

	private showSyncSuccessNotice(): void {
		if (!this.settings.showSyncSuccessNotice) {
			return;
		}

		this.showNotice('github sync successful', 'INFO');
	}

  private async desktopGit() {
    const { simpleGit } = await import('simple-git');
    const options: Partial<SimpleGitOptions> = {
      // Desktop only; the adapter exposes a native path on these platforms.
      // @ts-ignore desktop-only API
      baseDir: this.app.vault.adapter.getBasePath(),
      binary: this.settings.gitLocation + 'git',
      maxConcurrentProcesses: 1,
      trimmed: false,
    };
    return simpleGit(options);
  }

  private async syncDesktop(): Promise<void> {
    const remote = validateRemote(this.settings.remoteURL, false);
    const git = await this.desktopGit();
    let status;
    try {
      status = await git.status();
    } catch {
      throw new Error('This vault is not a Git repository or Git is unavailable. Initialize Git and verify the configured executable.');
    }
    const branches = await git.branchLocal();
    if (branches.current !== 'main') {
      throw new Error('The current Git branch is not main. Switch the vault to main before syncing.');
    }
    if (status.conflicted.length) {
      throw new Error('Merge conflicts remain: ' + status.conflicted.slice(0, 5).join(', '));
    }

    // Never silently change the destination of a vault. This can push
    // personal notes to the wrong repository.
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(entry => entry.name === 'origin');
    if (!origin) {
      await git.addRemote('origin', remote);
    } else if (!sameRemote(origin.refs.fetch, remote) || !sameRemote(origin.refs.push, remote)) {
      throw new Error('The configured repository differs from this vault origin. Review the destination before making changes.');
    }

    // A previously committed plugin data.json can contain older URL-embedded
    // credentials. Refuse to sync until the user untracks it.
    const trackedSecret = await git.raw(['ls-files', '--', PLUGIN_SETTINGS_PATH]);
    if (trackedSecret.trim()) {
      throw new Error('Git is tracking plugin settings (data.json). Untrack this file and rotate any exposed credentials before syncing.');
    }
    if (!status.isClean()) {
      // Include deletions but exclude our settings, even when the user has
      // not added it to .gitignore.
      await git.add(['-A', '--', '.', ':' + '!' + PLUGIN_SETTINGS_PATH]);
      const staged = await git.diff(['--cached', '--name-only']);
      if (staged.trim()) {
        await git.commit('Obsidian desktop ' + new Date().toISOString());
      }
    }

    // Fetch is read-only and safely retried on transient network errors.
    await retryRead(() => git.fetch('origin', 'main'));
    try {
      await git.pull('origin', 'main', { '--no-rebase': null });
    } catch (error) {
      const conflicts = (await git.status()).conflicted;
      if (conflicts.length) throw new Error('Merge conflicts remain: ' + conflicts.slice(0, 5).join(', '));
      throw error;
    }
    const after = await git.status();
    if (after.conflicted.length) {
      throw new Error('Merge conflicts remain: ' + after.conflicted.slice(0, 5).join(', '));
    }
    // Push once. Do not automatically retry a write after an uncertain
    // network result; a retry may hide other concurrent writes.
    await git.push('origin', 'main', ['-u']);
  }

  /** Connectivity test without committing, cloning, or changing user notes. */
  async diagnoseConnection(): Promise<void> {
    try {
      const remote = validateRemote(this.settings.remoteURL, Platform.isMobile);
      if (Platform.isMobile) {
        await (await this.mobileEngine()).verifyConnection();
      } else {
        const git = await this.desktopGit();
        await retryRead(() => git.listRemote(['--heads', remote]));
      }
      this.showNotice('GitHub repository is reachable. Write permissions will be verified on the first push.', 'INFO', 7000);
    } catch (error) {
      this.showNotice(publicErrorMessage(error), 'ERROR', 10000);
    }
  }

  async SyncNotes(): Promise<void> {
    if (this.syncInProgress) {
      this.showNotice('GitHub Sync: synchronization is already running.', 'WARNING');
      return;
    }
    this.syncInProgress = true;
    try {
      validateRemote(this.settings.remoteURL, Platform.isMobile);
      if (Platform.isMobile) await (await this.mobileEngine()).sync();
      else await this.syncDesktop();
      this.settings.lastSuccessfulSync = new Date().toISOString();
      await this.saveSettings();
      this.showSyncSuccessNotice();
    } catch (error) {
      this.showNotice(publicErrorMessage(error), 'ERROR', 10000);
    } finally {
      this.syncInProgress = false;
    }
  }

  async CheckStatusOnStart(): Promise<void> {
    if (!this.settings.remoteURL.trim() || this.syncInProgress) return;
    try {
      if (this.settings.isSyncOnLoad) {
        await this.SyncNotes();
        return;
      }
      if (Platform.isMobile) {
        if (await (await this.mobileEngine()).checkRemote()) {
          this.showNotice('Remote changes are available. Select Sync with Remote to download.', 'WARNING');
        }
      } else {
        const git = await this.desktopGit();
        await retryRead(() => git.fetch('origin', 'main'));
        const behind = Number((await git.raw(['rev-list', '--count', 'HEAD..refs/remotes/origin/main'])).trim());
        if (behind > 0) {
          this.showNotice('GitHub Sync: ' + behind + ' remote commits are pending. Select Sync with Remote.', 'WARNING');
        }
      }
    } catch (error) {
      this.showNotice(publicErrorMessage(error), 'WARNING', 10000);
    }
  }

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			this.SyncNotes();
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({
			id: 'github-sync-command',
			name: 'Sync with Remote',
			callback: () => { void this.SyncNotes(); }
		});
		this.addCommand({
			id: 'github-sync-diagnose',
			name: 'Test GitHub connection',
			callback: () => { void this.diagnoseConnection(); }
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		if (!isNaN(this.settings.syncinterval))
		{
			let interval: number = this.settings.syncinterval;
			if (interval >= 1)
			{
				this.registerInterval(window.setInterval(() => {
					void this.SyncNotes();
				}, interval * 60 * 1000));
				this.showNotice('Auto sync enabled while Obsidian is running', 'INFO');
			}
		}

		if (this.settings.checkStatusOnLoad)
		{
			this.CheckStatusOnStart();
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: Platform.isMobile
			? 'Mobile setup: use an HTTPS GitHub repository URL. Select a GitHub token in SecretStorage for private repositories or authenticated push. The initial sync supports an empty vault or one with compatible Git metadata; existing notes will never be overwritten silently.'
			: 'Desktop setup: use the repository HTTPS or SSH URL. Git must be installed and authentication configured. See the README for details.', cls: "howto_text" });
		howto.createEl("br");
        const linkEl = howto.createEl('p');
        linkEl.createEl('span', { text: 'See the ' });
        linkEl.createEl('a', { href: 'https://github.com/SrKain/Obsidian-GitHub-Sync/blob/main/README.md', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('Step 1 of setup: paste the repository HTTPS clone URL (or SSH on desktop). Never put a token in the URL.')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('Check GitHub connection')
			.setDesc('Step 2 of setup: verify the repository address and read access without changing notes. This does not test write permission.')
			.addButton(button => button
				.setButtonText('Test connection')
				.onClick(async () => {
					button.setDisabled(true);
					try { await this.plugin.diagnoseConnection(); }
					finally { button.setDisabled(false); }
				}));
		new Setting(containerEl)
			.setName('Last successful sync')
			.setDesc(this.plugin.settings.lastSuccessfulSync
				? new Date(this.plugin.settings.lastSuccessfulSync).toLocaleString()
				: 'No successful synchronization recorded yet.');

		if (Platform.isMobile) {
			new Setting(containerEl)
				.setName('GitHub token')
				.setDesc('Choose a secret containing a fine-grained GitHub token with Contents read/write access. The token stays in local SecretStorage.')
				.addComponent(el => new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.mobileTokenKey)
					.onChange(async value => {
						this.plugin.settings.mobileTokenKey = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('Commit author name')
				.addText(text => text
					.setValue(this.plugin.settings.mobileAuthorName)
					.onChange(async value => {
						this.plugin.settings.mobileAuthorName = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('Commit author email')
				.addText(text => text
					.setValue(this.plugin.settings.mobileAuthorEmail)
					.onChange(async value => {
						this.plugin.settings.mobileAuthorEmail = value;
						await this.plugin.saveSettings();
					}));
		}
		if (!Platform.isMobile) new Setting(containerEl)
			.setName('git binary location')
			.setDesc('This is optional! Set this only if git is not findable via your system PATH, then provide its location here. See README for more info.')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text2'));

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which GitHub Sync notices are shown in the Obsidian UI.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Success Message')
			.setDesc('Hide the single success notice shown when a sync finishes successfully.')
			.addToggle((toggle) => toggle
				.setValue(!this.plugin.settings.showSyncSuccessNotice)
				.onChange(async (value) => {
					this.plugin.settings.showSyncSuccessNotice = !value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Check to see if you are behind remote when you start Obsidian.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.checkStatusOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.checkStatusOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync with remote when you start Obsidian if there are unsynced changes.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync at interval')
			.setDesc('Set minute interval after which your vault is synced automatically. Auto sync is disabled if this field is left empty or not a positive integer. Restart Obsidan to take effect.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
