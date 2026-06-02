/**
 * Shared helpers for the file-upload affordances (the inspector
 * `AttachmentPicker`, the gallery / thumbnail tree-row drop zones, and the
 * gallery inspector). Kept framework-light so any of those surfaces can pull a
 * file out of a drop / paste and validate it against the same `accept` rules.
 */

/**
 * Mirror the browser's `accept` matching so dropped / pasted / dialog-overridden
 * files obey the same allow-list as the native picker. An empty `accept`
 * permits anything. Tokens may be extensions (".png"), wildcard mimes
 * ("image/*"), or exact mimes ("image/png").
 */
export function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  const tokens = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

/**
 * Pull the first file out of a clipboard payload. Pasted screenshots arrive as
 * clipboard `items` of kind "file"; copied desktop files populate `files`.
 */
export function fileFromClipboard(data: DataTransfer): File | null {
  return filesFromClipboard(data)[0] ?? null;
}

/** Pull every file out of a clipboard payload (multi-image pastes included). */
export function filesFromClipboard(data: DataTransfer): File[] {
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

/** True when a drag carries OS files (as opposed to in-app text / element drags). */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

/** Human-readable byte size for upload metadata (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
