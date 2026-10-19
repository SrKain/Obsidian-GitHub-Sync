import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';

/**
 * Conflict recovery is deliberately non-destructive. The dialog does not
 * reset the branch, force checkout, select a winner, or perform a push.
 */
export class ConflictRecoveryModal extends Modal {
  constructor(app: App, private readonly paths: string[]) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('github-sync-conflicts');
    this.titleEl.setText('Synchronization paused');
    this.contentEl.createEl('p', {
      text: 'Git detected incompatible edits. Your changes were not force-pushed. Resolve the conflicting files before syncing again.',
    });
    if (!this.paths.length) {
      this.contentEl.createEl('p', {
        text: 'The Git engine did not provide filenames. Use a desktop Git client to inspect unresolved files before attempting another sync.',
      });
    }

    for (const path of this.paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const setting = new Setting(this.contentEl)
        .setName(path)
        .setDesc('Inspect differences before choosing which content to keep.');
      if (file instanceof TFile) {
        setting.addButton(button => button
          .setButtonText('Open note')
          .onClick(async () => {
            await this.app.workspace.getLeaf(true).openFile(file);
          }));
        setting.addButton(button => button
          .setButtonText('Save copy')
          .onClick(async () => {
            try {
              const folder = file.parent?.path === '/' ? '' : file.parent?.path || '';
              const suffix = ' (GitHub Sync backup ' + new Date().toISOString().replace(/[:.]/g, '-') + ')';
              const name = file.basename + suffix + (file.extension ? '.' + file.extension : '');
              const location = normalizePath(folder ? folder + '/' + name : name);
              if (await this.app.vault.adapter.exists(location)) {
                new Notice('A backup with this timestamp already exists. Retry in a moment.');
                return;
              }
              await this.app.vault.copy(file, location);
              new Notice('Backup saved inside this vault. It contains the current file, which may include conflict markers.');
            } catch {
              new Notice('Could not create the safety copy. No original file was deleted.');
            }
          }));
      }
    }

    this.contentEl.createEl('p', {
      text: 'To finish: inspect local and remote versions, remove any conflict markers, stage the resolved files and commit the merge. On mobile, use a compatible Git client on desktop when advanced resolution is needed.',
    });
    new Setting(this.contentEl).addButton(button => button
      .setButtonText('Close')
      .onClick(() => this.close()));
  }
}
