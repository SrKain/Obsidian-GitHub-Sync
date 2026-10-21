/** A bounded, redacted error snapshot suitable for Obsidian plugin settings. */
export interface LastSyncError {
  at: string;
  name: string;
  message: string;
  frames: string[];
}

const safeErrorName = /^[A-Za-z]{3,40}$/;
const secretPattern = /\b(?:Bearer\s+\S+|github_pat_\w+|gh[pousr]_\w+)\b/gi;
const keyPattern = /\b(token|access_token|password|authorization|api[_-]?key|secret)\s*[:=]\s*['"]?[^\s&'",;]+/gi;
const urlPattern = /(?:https?:\/\/|ssh:\/\/|git@)\S+/gi;

function redact(raw: string): string {
  return raw.replace(urlPattern, '[URL]')
    .replace(secretPattern, '[REDACTED]')
    .replace(keyPattern, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ').trim();
}

/** Reject raw file paths entirely; show only safe function / basename:line frames. */
function stackFrames(stack: string): string[] {
  const frames: string[] = [];
  for (const line of stack.split(/\r?\n/).slice(1)) {
    const match = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+)(?::\d+)?\)?\s*$/.exec(line);
    if (!match) continue;
    const rawFunction = (match[1] || 'anonymous').replace(/^(?:async|new)\s+/, '');
    const fn = /^[A-Za-z_$][\w.$-]{0,79}$/.test(rawFunction) ? rawFunction : 'anonymous';
    const file = match[2].split(/[\\/]/).pop() || '';
    const lineNumber = Number(match[3]);
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(file) || !Number.isSafeInteger(lineNumber)) continue;
    frames.push(fn + ' (' + file + ':' + lineNumber + ')');
    if (frames.length === 5) break;
  }
  return frames;
}

export function captureSyncError(error: unknown): LastSyncError {
  const item = error instanceof Error ? error : null;
  return {
    at: new Date().toISOString(),
    name: item && safeErrorName.test(item.name) ? item.name : 'Error',
    message: redact(item ? item.message : String(error)).slice(0, 300),
    frames: item?.stack ? stackFrames(item.stack) : [],
  };
}

/** Re-sanitize persisted data before displaying or copying it. */
export function formatLastSyncError(record: LastSyncError | null | undefined): string {
  if (!record) return '';
  const name = safeErrorName.test(record.name) ? record.name : 'Error';
  const date = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(record.at) ? record.at : 'unknown';
  const message = redact(String(record.message)).slice(0, 300);
  const frames = Array.isArray(record.frames) ? record.frames.slice(0, 5)
    .filter(frame => /^[A-Za-z_$][\w.$-]{0,79} \([A-Za-z0-9._-]{1,80}:\d+\)$/.test(frame)) : [];
  return ['At: ' + date, 'Name: ' + name, 'Message: ' + message,
    'Frames:', ...(frames.length ? frames : ['(unavailable)'])].join('\n');
}
