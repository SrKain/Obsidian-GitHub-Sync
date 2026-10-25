import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type { ConflictVersions } from '../desktop/ConflictResolution';

export interface ConflictResolverActions {
  load(path: string): Promise<ConflictVersions | null>;
  apply(path: string, snapshot: ConflictVersions, resolved: string): Promise<void>;
  resume(): Promise<void>;
}

/**
 * Resolve one file at a time with explicit user action. Mobile and unsupported
 * file types retain the non-destructive guidance instead of choosing a winner.
 */
export class ConflictRecoveryModal extends Modal {
  private readonly paths: string[];
  private index = 0;

  constructor(
    app: App,
    paths: string[],
    private readonly actions?: ConflictResolverActions,
  ) {
    super(app);
    this.paths = [...new Set(paths)];
  }

  onOpen(): void {
    this.modalEl.addClass('github-sync-conflicts');
    this.titleEl.setText('Resolve GitHub Sync conflicts');
    void this.render();
  }

  private createTextArea(parent: HTMLElement, label: string, text: string, readOnly: boolean): HTMLTextAreaElement {
    const wrapper = parent.createDiv({ cls: 'github-sync-conflict-version' });
    wrapper.createEl('label', { text });
    // Replace label content with a descriptive heading, not note contents.
    wrapper.querySelector('label')?.setText(label);
    const field = wrapper.createEl('textarea', { cls: 'github-sync-conflict-text' });
    field.value = text;
    field.readOnly = readOnly;
    field.spellcheck = false;
    field.setAttribute('aria-label', label);
    return field;
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: 'Compare both versions, choose the final Markdown text, then apply. Nothing is pushed until all conflicts are resolved.',
    });

    if (!this.paths.length) {
      this.contentEl.createEl('p', {
        text: this.actions
          ? 'No unresolved files remain in this session. Continue to finish the Git merge and synchronize.'
          : 'The Git engine did not report unresolved filenames. You can retry sync, or inspect Git history on desktop.',
      });
      if (this.actions) new Setting(this.contentEl).addButton(button => button
        .setButtonText('Finish and sync')
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          this.close();
          await this.actions?.resume();
        }));
      new Setting(this.contentEl).addButton(button => button.setButtonText('Close').onClick(() => this.close()));
      return;
    }

    if (this.index >= this.paths.length) this.index = this.paths.length - 1;
    const path = this.paths[this.index];
    const navigation = new Setting(this.contentEl)
      .setName(path)
      .setDesc('File ' + (this.index + 1) + ' of ' + this.paths.length);
    if (this.index > 0) navigation.addButton(button => button
      .setButtonText('Previous')
      .onClick(() => { this.index--; void this.render(); }));
    if (this.index < this.paths.length - 1) navigation.addButton(button => button
      .setButtonText('Next')
      .onClick(() => { this.index++; void this.render(); }));

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      new Setting(this.contentEl).addButton(button => button
        .setButtonText('Open note')
        .onClick(async () => { await this.app.workspace.getLeaf(true).openFile(file); }));
    }

    let snapshot: ConflictVersions | null = null;
    if (this.actions) {
      try {
        snapshot = await this.actions.load(path);
      } catch (error) {
        console.error('[GitHub Sync] Failed to inspect conflict', error);
      }
    }
    // Ignore late async responses when the user has already switched files.
    if (this.paths[this.index] !== path) return;

    if (!snapshot) {
      this.contentEl.createEl('p', {
        text: 'This conflict cannot be resolved in the visual editor (mobile, deleted files, non-Markdown, or large files). The original files are unchanged by this dialog. Use a desktop Git client for this case.',
      });
      if (file instanceof TFile) {
        new Setting(this.contentEl).addButton(button => button
          .setButtonText('Save safety copy')
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
              new Notice('Safety copy saved. It may contain unresolved conflict markers.');
            } catch {
              new Notice('Could not save the copy. The original note was not deleted.');
            }
          }));
      }
    } else {
      const versions = this.contentEl.createDiv({ cls: 'github-sync-conflict-versions' });
      this.createTextArea(versions, 'Local version (this device)', snapshot.local, true);
      this.createTextArea(versions, 'GitHub version (remote)', snapshot.remote, true);

      const result = this.createTextArea(this.contentEl, 'Final note — editable', snapshot.working ?? '', false);
      let edited = false;
      result.addEventListener('input', () => { edited = true; });
      const choices = new Setting(this.contentEl).setName('Choose a version');
      choices.addButton(button => button.setButtonText('Use local').onClick(() => {
        result.value = snapshot.local; edited = true;
      }));
      choices.addButton(button => button.setButtonText('Use GitHub').onClick(() => {
        result.value = snapshot.remote; edited = true;
      }));
      this.contentEl.createEl('p', {
        text: 'To combine both, edit the final note directly. Remove all <<<<<<< and >>>>>>> conflict markers.',
        cls: 'github-sync-conflict-hint',
      });
      new Setting(this.contentEl).addButton(button => button
        .setButtonText('Apply to this note')
        .setCta()
        .onClick(async () => {
          if (!edited) {
            new Notice('Choose a version or edit the final note before applying.');
            return;
          }
          button.setDisabled(true);
          try {
            await this.actions?.apply(path, snapshot, result.value);
            this.paths.splice(this.index, 1);
            if (this.index >= this.paths.length) this.index = Math.max(0, this.paths.length - 1);
            new Notice('Resolution staged locally. No push has been made.');
            await this.render();
          } catch (error) {
            console.error('[GitHub Sync] Failed to apply resolution', error);
            new Notice(error instanceof Error && /conflict markers|changed while|Only Markdown/.test(error.message)
              ? error.message : 'Could not apply the resolution. The GitHub push remains paused.', 8000);
            button.setDisabled(false);
          }
        }));
    }
    new Setting(this.contentEl).addButton(button => button
      .setButtonText('Close without syncing')
      .onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
