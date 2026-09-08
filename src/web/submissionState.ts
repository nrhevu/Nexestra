import { readBrowserValue, writeBrowserValue } from "./conversationState.js";

// One recoverable message submission. The server treats (workspace thread + requestId) as
// idempotent: the first attempt that reaches it wins and later attempts with the same payload
// replay the original result. The UI keeps an identity until a successful send retires it, so
// an explicit Send again after a failure/lost response retries the exact same request. Editing
// content or files produces a different fingerprint and therefore a new request identity.
export interface PendingFileDescriptor {
  name: string;
  type: string;
  size: number;
}

export interface PendingSubmission {
  requestId: string;
  key: string;
  files: PendingFileDescriptor[];
  createdAt: string;
}

export interface RetireResult {
  matched: boolean;
  persisted: boolean;
}

export const PENDING_SUBMISSION_VERSION = 1;
export const PENDING_STORAGE_MAX_BYTES = 64 * 1024;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_NAME_LENGTH = 255;
const MAX_TYPE_LENGTH = 255;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_PATTERN = /^v1:[a-f0-9]{64}$/;

export function newRequestId(): string {
  return globalThis.crypto.randomUUID().toLowerCase();
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function webCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto as Crypto | undefined;
  if (!subtle?.subtle) {
    throw new Error(
      "This browser cannot fingerprint messages. Update to a browser with WebCrypto.",
    );
  }
  return subtle.subtle;
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = webCrypto();
  const raw = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return hex(new Uint8Array(raw));
}

async function fileDigest(file: File): Promise<string> {
  const subtle = webCrypto();
  const raw = await subtle.digest("SHA-256", await file.arrayBuffer());
  return hex(new Uint8Array(raw));
}

// Deterministic summary of the send payload: trimmed content plus each attachment name, type,
// size and SHA-256 digest, in attachment order. The whole serialized JSON structure is hashed
// once, so delimiter characters inside content or file names cannot collide with structure.
// File bytes never enter the extra submission state, only digest hex and descriptors.
// WebCrypto is required: a weakened fallback could make two files with different bytes look
// identical and silently resubmit the wrong message.
export async function fingerprintSubmission(content: string, files: File[]): Promise<string> {
  const structure: {
    content: string;
    files: { name: string; type: string; size: number; digest: string }[];
  } = {
    content: content.trim(),
    files: [],
  };
  for (const file of files) {
    structure.files.push({
      name: file.name,
      type: file.type,
      size: file.size,
      digest: await fileDigest(file),
    });
  }
  return `v1:${await sha256Hex(JSON.stringify(structure))}`;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isValidFileDescriptor(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    record.name.length > MAX_NAME_LENGTH
  ) {
    return false;
  }
  if (typeof record.type !== "string" || record.type.length > MAX_TYPE_LENGTH) return false;
  if (
    typeof record.size !== "number" ||
    !Number.isFinite(record.size) ||
    record.size < 0 ||
    record.size > MAX_FILE_BYTES
  ) {
    return false;
  }
  return true;
}

function isValidEntry(value: unknown): value is PendingSubmission {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.version !== PENDING_SUBMISSION_VERSION) return false;
  if (!isRequestId(entry.requestId)) return false;
  if (typeof entry.key !== "string" || !KEY_PATTERN.test(entry.key)) return false;
  if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt)))
    return false;
  if (!Array.isArray(entry.files) || entry.files.length > MAX_FILES) return false;
  if (entry.files.some((file) => !isValidFileDescriptor(file))) return false;
  return entry.files.reduce((total, file) => total + file.size, 0) <= MAX_TOTAL_BYTES;
}

// Owned by one App instance, so view unmounts and denied storage cannot discard pending
// identities. Reads are read-once: a null memory tombstone wins for the rest of the session
// even when the storage removal failed, so a retired identity can never silently come back.
// Invalid or oversized persisted values are ignored once and lazily cleared.
export class SubmissionState {
  private readonly pending = new Map<string, PendingSubmission | null>();

  pendingKey(workspaceId: string, threadId: string): string {
    return `nexestra.pendingSubmission.${PENDING_SUBMISSION_VERSION}.${workspaceId}:${threadId}`;
  }

  pendingFor(workspaceId: string, threadId: string): PendingSubmission | null {
    const key = this.pendingKey(workspaceId, threadId);
    if (this.pending.has(key)) return this.pending.get(key) ?? null;
    const storedValue = readBrowserValue(key);
    if (storedValue === null || storedValue.length > PENDING_STORAGE_MAX_BYTES) {
      if (storedValue !== null) writeBrowserValue(key, null);
      this.pending.set(key, null);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(storedValue);
    } catch {
      writeBrowserValue(key, null);
      this.pending.set(key, null);
      return null;
    }
    if (!isValidEntry(parsed)) {
      writeBrowserValue(key, null);
      this.pending.set(key, null);
      return null;
    }
    this.pending.set(key, parsed);
    return parsed;
  }

  // Returns whether the identity reached browser storage. The caller shows a notice when it
  // did not: an in-memory identity still protects this tab, but it will not survive a reload.
  remember(workspaceId: string, threadId: string, submission: PendingSubmission): boolean {
    const key = this.pendingKey(workspaceId, threadId);
    this.pending.set(key, submission);
    return writeBrowserValue(
      key,
      JSON.stringify({ ...submission, version: PENDING_SUBMISSION_VERSION }),
    );
  }

  // Retires only the exact request identity that was acknowledged. The memory tombstone is
  // written before the storage delete, so a failed delete cannot resurrect the identity in
  // this session. A late success for an old request cannot delete a newer pending intent.
  retire(workspaceId: string, threadId: string, requestId: string): RetireResult {
    const key = this.pendingKey(workspaceId, threadId);
    const current = this.pendingFor(workspaceId, threadId);
    if (!current || current.requestId !== requestId) return { matched: false, persisted: true };
    this.pending.set(key, null);
    return { matched: true, persisted: writeBrowserValue(key, null) };
  }
}
