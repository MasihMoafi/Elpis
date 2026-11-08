import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { RoleModelSchema } from "./executor/settings.mts";
import { BridgeError } from "../validate.mts";

const RolesSchema = z
  .object({ dispatch: RoleModelSchema.nullable().default(null), worker: RoleModelSchema.nullable().default(null) })
  .strict();
const ConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    threadId: z.string().nullable().default(null),
    creating: z.boolean().default(false),
    roles: RolesSchema.default({ dispatch: null, worker: null }),
  })
  .strict();
export const MotherChangeSchema = z
  .object({ version: z.string(), enabled: z.boolean().optional(), roles: RolesSchema.optional() })
  .strict();
export type MotherConfig = z.infer<typeof ConfigSchema>;
export type MotherSettings = MotherConfig & {
  version: string;
  error?: string;
  health?: Readonly<Record<string, { state: string; detail: string }>>;
};
export class MotherSettingsFile {
  private readonly directory: string;
  private readonly file: string;
  constructor(home: string) {
    this.directory = join(home, "router");
    this.file = join(this.directory, "mother.json");
  }
  read(): MotherConfig {
    try {
      return ConfigSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ConfigSchema.parse({});
      throw error;
    }
  }
  snapshot(): MotherSettings {
    const value = this.read();
    return { ...value, version: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  }
  change(input: unknown): MotherConfig {
    const data = MotherChangeSchema.parse(input),
      before = this.snapshot();
    if (before.version !== data.version)
      throw new BridgeError("Elpis settings changed elsewhere. Reload before saving.", 409);
    return this.write({ ...before, enabled: data.enabled ?? before.enabled, roles: data.roles ?? before.roles });
  }
  write(value: MotherConfig): MotherConfig {
    const config = ConfigSchema.parse({
      enabled: value.enabled,
      threadId: value.threadId,
      creating: value.creating,
      roles: value.roles,
    });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `mother.${randomUUID()}.pending`);
    try {
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporary, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.file);
      const directory = openSync(this.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return config;
  }
}
