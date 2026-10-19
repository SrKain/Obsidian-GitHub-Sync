import { App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { SimpleGitOptions } from 'simple-git';
import type { MobileSync } from './src/mobile/MobileSync';

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

	async SyncNotes()
	{
		if (this.syncInProgress) {
			this.showNotice('GitHub Sync: synchronization already in progress.', 'WARNING');
			return;
		}

		this.syncInProgress = true;
		try {
		if (Platform.isMobile) {
			await (await this.mobileEngine()).sync();
			this.showSyncSuccessNotice();
			return;
		}
		const { simpleGit } = await import('simple-git');
		const remote = this.settings.remoteURL.trim();
		if (!remote) {
			this.showNotice('GitHub Sync: configure a remote URL before syncing.', 'ERROR');
			return;
		}

		const simpleGitOptions: Partial<SimpleGitOptions> = {
			//@ts-ignore
		    baseDir: this.app.vault.adapter.getBasePath(),
		    binary: this.settings.gitLocation + "git",
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		};
		const git = simpleGit(simpleGitOptions);

		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => {
			this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
			return; })

		if (!statusResult) {
			return;
		}

		if (statusResult.conflicted.length > 0) {
			this.showNotice('GitHub Sync: resolve and stage existing merge conflicts before syncing.', 'WARNING', 10000);
			return;
		}

		//@ts-ignore
		let clean = statusResult.isClean();

    	let date = new Date();
    	let msg = hostname + " " + date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate() + ":" + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds();

		// git add .
		// git commit -m hostname-date-time
		if (!clean) {
			try {
				await git
		    		.add("./*")
		    		.commit(msg);
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return;
		    }
		}

		// Preserve the existing origin when it already points to the configured remote.
		try {
			const remotes = await git.getRemotes(true);
			const origin = remotes.find((entry) => entry.name === 'origin');
			if (!origin) {
				await git.addRemote('origin', remote);
			} else {
				if (origin.refs.fetch !== remote) {
					await git.remote(['set-url', 'origin', remote]);
				}
				if (origin.refs.push !== remote) {
					await git.remote(['set-url', '--push', 'origin', remote]);
				}
			}
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}
		// check if remote url valid by fetching
		try {
			await git.fetch();
		} catch (e) {
			this.showNotice(String(e) + "\nGitHub Sync: Invalid remote URL.", 'ERROR', 10000);
			return;
		}

		// git pull origin main
	    try {
	    	await git.pull('origin', 'main', { '--no-rebase': null });
	    } catch (e) {
	    	let conflictStatus = await git.status().catch((error) => { this.showNotice(error, 'ERROR', 10000); return; });
	    	if (!conflictStatus) {
	    		return;
	    	}
			if (conflictStatus.conflicted.length === 0) {
				this.showNotice(e, 'ERROR', 10000);
				return;
			}
    		let conflictMsg = "Merge conflicts in:";
	    	//@ts-ignore
			for (let c of conflictStatus.conflicted)
			{
				conflictMsg += "\n\t"+c;
			}
			conflictMsg += "\nResolve and stage these files with git add, then sync again."
			this.showNotice(conflictMsg, 'WARNING');
			//@ts-ignore	
			for (let c of conflictStatus.conflicted)
			{
				this.app.workspace.openLinkText("", c, true);
			}
	    	return;
	    }

		// Push even if the vault was initially clean: local commits or a merge
		// performed by pull may still need to be sent to origin.
		try {
			const finalStatus = await git.status();
			if (finalStatus.conflicted.length > 0) {
				this.showNotice('GitHub Sync: merge conflicts must be resolved before pushing.', 'WARNING', 10000);
				return;
			}
			await git.push('origin', 'main', ['-u']);
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}

		this.showSyncSuccessNotice();
		} catch (error) {
			this.showNotice(error, 'ERROR', 10000);
		} finally {
			this.syncInProgress = false;
		}
	}

	async CheckStatusOnStart()
	{
		if (Platform.isMobile) {
			try {
				if (this.settings.isSyncOnLoad) {
					await this.SyncNotes();
				} else if (await (await this.mobileEngine()).checkRemote()) {
					this.showNotice('GitHub Sync: remote changes are available. Tap Sync with Remote.', 'WARNING');
				}
			} catch (error) {
				this.showNotice(error, 'ERROR', 10000);
			}
			return;
		}
		// check status
		try {
			const { simpleGit } = await import('simple-git');
			const simpleGitOptions: Partial<SimpleGitOptions> = {
				//@ts-ignore
			    baseDir: this.app.vault.adapter.getBasePath(),
			    binary: this.settings.gitLocation + "git",
			    maxConcurrentProcesses: 6,
			    trimmed: false,
			};
			const git = simpleGit(simpleGitOptions);

			//check for remote changes
			// git branch --set-upstream-to=origin/main main
			await git.branch({'--set-upstream-to': 'origin/main'});
			let statusUponOpening = await git.fetch().status();
			if (statusUponOpening.behind > 0)
			{
				// Automatically sync if needed
				if (this.settings.isSyncOnLoad == true)
				{
					this.SyncNotes();
				}
				else
				{
					this.showNotice("GitHub Sync: " + statusUponOpening.behind + " commits behind remote.\nClick the GitHub ribbon icon to sync.", 'WARNING');
				}
			}
			else
			{
				this.showNotice("GitHub Sync: up to date with remote.", 'INFO');
			}
		} catch (e) {
			// don't care
			// based
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
			callback: () => {
				this.SyncNotes();
			}
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
        linkEl.createEl('a', { href: 'https://github.com/kevinmkchin/Obsidian-GitHub-Sync/blob/main/README.md', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

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
