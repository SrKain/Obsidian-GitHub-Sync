import { App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { SimpleGitOptions } from 'simple-git';
import type { MobileSync } from './src/mobile/MobileSync';
import { classifySyncError, publicErrorMessage, retryRead, SyncConflictError, validateRemote } from './src/core/SyncSafety';

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
    const { runDesktopSync } = await import('./src/desktop/DesktopSync');
    await runDesktopSync(git, remote, this.app.vault.configDir + '/plugins/github-sync/data.json');
  }

  /** Connectivity test without committing, cloning, or changing user notes. */
  async diagnoseConnection(): Promise<boolean> {
    try {
      const remote = validateRemote(this.settings.remoteURL, Platform.isMobile);
      if (Platform.isMobile) {
        await (await this.mobileEngine()).verifyConnection();
      } else {
        const git = await this.desktopGit();
        await retryRead(() => git.listRemote(['--heads', remote]));
      }
      this.showNotice('GitHub repository is reachable. Write permissions will be verified on the first push.', 'INFO', 7000);
      return true;
    } catch (error) {
      this.showNotice(publicErrorMessage(error), 'ERROR', 10000);
      return false;
    }
  }

  async openSetupWizard(): Promise<void> {
    const { SetupWizard } = await import('./src/ui/SetupWizard');
    new SetupWizard(this.app, this).open();
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
      if (classifySyncError(error) === 'conflict') {
        const { ConflictRecoveryModal } = await import('./src/ui/ConflictRecoveryModal');
        const files = error instanceof SyncConflictError ? error.files : [];
        new ConflictRecoveryModal(this.app, files).open();
      }
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
			id: 'github-sync-setup',
			name: 'Set up GitHub Sync',
			callback: () => { void this.openSetupWizard(); }
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

		new Setting(containerEl)
			.setName('Guided setup')
			.setDesc('Connect your vault with step-by-step checks. No terminal commands are needed for an empty mobile vault.')
			.addButton(button => button
				.setButtonText('Start setup')
				.setCta()
				.onClick(() => { void this.plugin.openSetupWizard(); }));

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
