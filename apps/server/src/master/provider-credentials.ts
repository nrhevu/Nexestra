import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const CredentialFileSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), z.string().min(1)),
});

interface CredentialFile {
  readonly version: 1;
  readonly providers: Record<string, string>;
}

/**
 * A small local secret store for Master provider credentials.
 *
 * Credentials deliberately live outside SQLite and its append-only event log.
 * The file is readable only by the current OS user and is replaced atomically,
 * so an interrupted write cannot leave half of a credential document behind.
 */
export class ProviderCredentialStore {
  readonly file: string;
  private readonly providers: Record<string, string>;

  constructor(file: string) {
    this.file = file;
    this.providers = this.read();
  }

  get(providerId: string): string | undefined {
    return this.providers[providerId];
  }

  has(providerId: string): boolean {
    return this.get(providerId) !== undefined;
  }

  set(providerId: string, credential: string): void {
    const value = credential.trim();
    if (!value) throw new Error("provider credential cannot be empty");
    this.providers[providerId] = value;
    this.write();
  }

  delete(providerId: string): void {
    if (!this.has(providerId)) return;
    delete this.providers[providerId];
    this.write();
  }

  deleteUnknown(providerIds: ReadonlySet<string>): void {
    const removed = Object.keys(this.providers).filter((id) => !providerIds.has(id));
    if (removed.length === 0) return;
    for (const id of removed) delete this.providers[id];
    this.write();
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read provider credentials at ${this.file}`, { cause: error });
    }
    const result = CredentialFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid provider credential file at ${this.file}`);
    }
    chmodSync(this.file, 0o600);
    return { ...result.data.providers };
  }

  private write(): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.credentials-${process.pid}-${Date.now()}.tmp`);
    const document: CredentialFile = { version: 1, providers: this.providers };
    try {
      writeFileSync(temporary, `${JSON.stringify(document)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}

export function providerCredentialPath(databaseFile: string): string {
  return join(dirname(databaseFile), "credentials.json");
}
