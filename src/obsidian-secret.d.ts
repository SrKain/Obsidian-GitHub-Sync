/**
 * The npm 'obsidian' declarations may lag behind runtime API 1.11.4.
 * Runtime API: https://docs.obsidian.md/plugins/guides/secret-storage
 * This augmentation describes ONLY the documented SecretStorage surface.
 * Remove when the upstream npm typings include these declarations.
 */
import 'obsidian';
import type { App } from 'obsidian';

declare module 'obsidian' {
  interface App {
    secretStorage: {
      getSecret(id: string): string | null;
    };
  }
  interface Setting {
    addComponent(callback: (containerEl: HTMLElement) => void): this;
  }
  class SecretComponent {
    constructor(app: App, containerEl: HTMLElement);
    setValue(value: string): this;
    onChange(callback: (value: string) => unknown): this;
  }
}
