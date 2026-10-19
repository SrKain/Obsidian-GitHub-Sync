import { App, Modal, Notice, Platform, SecretComponent, Setting } from 'obsidian';
import { publicErrorMessage, validateRemote } from '../core/SyncSafety';

interface SetupSettings {
  remoteURL: string;
  mobileTokenKey: string;
  mobileAuthorName: string;
  mobileAuthorEmail: string;
}
interface SetupHost {
  settings: SetupSettings;
  saveSettings(): Promise<void>;
  diagnoseConnection(): Promise<boolean>;
  SyncNotes(): Promise<void>;
}

/** Three-stage setup with safe preflight: advancing steps never changes notes. */
export class SetupWizard extends Modal {
  private step = 0;
  private connectionVerified = false;
  constructor(app: App, private readonly host: SetupHost) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('github-sync-wizard');
    this.render();
  }

  private footer(previous = true, next = true): void {
    const footer = this.contentEl.createDiv({ cls: 'github-sync-wizard-footer' });
    if (previous) new Setting(footer).addButton(button => button
      .setButtonText('Back').onClick(() => {
        this.step -= 1;
        this.render();
      }));
    if (next) new Setting(footer).addButton(button => button
      .setButtonText('Continue').setCta().onClick(async () => {
        try {
          validateRemote(this.host.settings.remoteURL, Platform.isMobile);
          await this.host.saveSettings();
          this.step += 1;
          this.render();
        } catch (error) {
          new Notice(publicErrorMessage(error));
        }
      }));
  }

  private render(): void {
    this.contentEl.empty();
    const labels = ['Repository', 'Authentication', 'Check and connect'];
    this.setTitle('Set up GitHub Sync');
    this.contentEl.createEl('p', {
      cls: 'github-sync-wizard-step',
      text: 'Step ' + (this.step + 1) + ' of 3 — ' + labels[this.step],
    });

    if (this.step === 0) {
      this.contentEl.createEl('p', {
        text: 'Paste the HTTPS address of the GitHub repository that stores your notes. Desktop also accepts GitHub SSH addresses.',
      });
      new Setting(this.contentEl)
        .setName('Repository URL')
        .setDesc('Example: https://github.com/owner/notes.git')
        .addText(field => field
          .setPlaceholder('https://github.com/owner/notes.git')
          .setValue(this.host.settings.remoteURL)
          .onChange(async value => {
            this.host.settings.remoteURL = value;
            this.connectionVerified = false;
            await this.host.saveSettings();
          }));
      this.footer(false, true);
      return;
    }

    if (this.step === 1) {
      if (Platform.isMobile) {
        this.contentEl.createEl('p', {
          text: 'For private repositories or uploading changes, use a fine-grained GitHub token with Contents read/write permission for only this repository. Obsidian stores this token outside the vault.',
        });
        new Setting(this.contentEl).setName('GitHub access token')
          .setDesc('Select a secret stored on this device. Never paste the token into the repository URL.')
          .addComponent(el => new SecretComponent(this.app, el)
            .setValue(this.host.settings.mobileTokenKey)
            .onChange(async value => {
              this.host.settings.mobileTokenKey = value;
              this.connectionVerified = false;
              await this.host.saveSettings();
            }));
      } else {
        this.contentEl.createEl('p', {
          text: 'Desktop uses Git authentication configured in your operating system (Git Credential Manager or SSH). This plugin does not require a separate token if Git already authenticates.',
        });
      }
      const link = this.contentEl.createEl('a', {
        href: 'https://github.com/settings/personal-access-tokens/new',
        text: 'GitHub: create a fine-grained access token',
      });
      link.setAttr('target', '_blank');
      this.footer(true, true);
      return;
    }

    this.contentEl.createEl('p', {
      text: 'The connection test reads repository information only. It does not clone, commit, overwrite, or push notes.',
    });
    const status = this.contentEl.createDiv({ cls: 'github-sync-wizard-status' });
    status.setText('Checking local vault...');
    const actions = this.contentEl.createDiv({ cls: 'github-sync-wizard-footer' });
    const verify = new Setting(actions);
    verify.addButton(button => button
      .setButtonText('Test GitHub connection')
      .setCta()
      .onClick(async () => {
        button.setDisabled(true);
        status.setText('Verifying GitHub access...');
        try {
          this.connectionVerified = await this.host.diagnoseConnection();
          status.setText(this.connectionVerified
            ? 'Repository reached successfully. Write permission will be tested during synchronization.'
            : 'Connection failed. Check the repository and token, then retry.');
        } finally { button.setDisabled(false); }
      }));
    verify.addButton(button => button
      .setButtonText('Sync now')
      .onClick(async () => {
        if (!this.connectionVerified) {
          new Notice('Test your GitHub connection before the first sync.');
          return;
        }
        this.close();
        await this.host.SyncNotes();
      }));
    verify.addButton(button => button
      .setButtonText('Back').onClick(() => { this.step = 1; this.render(); }));

    void this.app.vault.adapter.exists('.git').then(hasGit => {
      const files = this.app.vault.getFiles().filter(file =>
        !file.path.startsWith(this.app.vault.configDir + '/'));
      if (!hasGit && files.length) {
        status.setText('Vault contains notes without Git history. To protect them, use an empty vault or import Git history first.');
        this.connectionVerified = false;
      } else if (!hasGit && !Platform.isMobile) {
        status.setText('Desktop requires an initialized Git repository. Initialize the vault on your computer before syncing.');
      } else {
        status.setText(hasGit
          ? 'Existing Git vault detected. Test the connection before syncing.'
          : 'Empty mobile vault detected. A guarded clone will run during first sync.');
      }
    });
  }
}
