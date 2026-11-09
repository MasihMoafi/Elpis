import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ATTACHMENT_LIMITS,
  AttachmentError,
  attachmentBytes,
  attachmentFields,
  attachmentName,
} from "./attachments.mts";
import { elpisHome } from "./client-paths.mts";

const run = promisify(execFile);
const MiB = 1024 * 1024;
const MAX_FILES = 5000;
const MAX_UNPACKED = 500 * MiB;
const LISTED = 200;

type Tools = { unzip?: string; zipinfo?: string; root?: string };

const unavailable = () => new AttachmentError("Zip files need unzip installed on this computer", 503);

/** Refuses what could write outside the folder or fill the disk, before anything is unpacked. */
async function inspect(zipinfo: string, unzip: string, archive: string, label: string) {
  const details = await run(zipinfo, ["-s", archive], { maxBuffer: 16 * MiB }).catch(cause => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw unavailable();
    throw new AttachmentError(`"${label}" is not a readable zip file`, 422);
  });
  if (details.stdout.split("\n").some(line => line.startsWith("l")))
    throw new AttachmentError(`"${label}" contains symbolic links, so it was not unpacked`, 422);
  const names = (await run(unzip, ["-Z1", archive], { maxBuffer: 16 * MiB })).stdout.split("\n").filter(Boolean);
  if (names.length > MAX_FILES) throw new AttachmentError(`"${label}" has more than ${MAX_FILES} files`, 413);
  if (names.some(name => name.startsWith("/") || name.split(/[\\/]/).includes("..")))
    throw new AttachmentError(`"${label}" has paths outside its own folder, so it was not unpacked`, 422);
  const total = Number(
    (await run(unzip, ["-l", archive], { maxBuffer: 16 * MiB })).stdout
      .trim()
      .split("\n")
      .at(-1)
      ?.trim()
      .split(/\s+/)[0],
  );
  if (!Number.isFinite(total) || total > MAX_UNPACKED)
    throw new AttachmentError(`"${label}" unpacks to more than ${MAX_UNPACKED / MiB} MB`, 413);
  return names;
}

/** A zip goes to the agent as a folder it can read: unpacked on this computer, with the path and file list in the message. */
export async function extractZip(
  request: unknown,
  { unzip = "/usr/bin/unzip", zipinfo = "/usr/bin/zipinfo", root }: Tools = {},
) {
  attachmentFields(request, ["name", "mimeType", "dataUrl"]);
  attachmentName(request.name);
  if (request.mimeType !== "application/zip") throw new AttachmentError("Only zip files are unpacked");
  const bytes = attachmentBytes(request.dataUrl, "application/zip", ATTACHMENT_LIMITS.fileBytes, request.name);
  if (bytes.subarray(0, 2).toString("ascii") !== "PK") throw new AttachmentError(`"${request.name}" is not a zip file`);
  const id = randomUUID();
  const base = path.join(root ?? path.join(elpisHome(), "attachments"), id);
  const archive = `${base}.zip`;
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(archive, bytes, { mode: 0o600 });
    const names = await inspect(zipinfo, unzip, archive, request.name);
    await run(unzip, ["-q", "-n", "-P", "", archive, "-d", base], { timeout: 60000, maxBuffer: 16 * MiB }).catch(
      cause => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw unavailable();
        throw new AttachmentError(
          `"${request.name}" could not be unpacked; it may be damaged or password-protected`,
          422,
        );
      },
    );
    const files = names.filter(name => !name.endsWith("/"));
    const shown = files.slice(0, LISTED).join("\n");
    const more = files.length > LISTED ? `\n… and ${files.length - LISTED} more` : "";
    const text = `Zip archive unpacked to: ${base}\n${files.length} files:\n${shown}${more}`;
    return { attachment: { id, name: request.name, type: "text", mimeType: "text/plain", text } };
  } catch (cause) {
    await fs.rm(base, { recursive: true, force: true });
    throw cause;
  } finally {
    await fs.rm(archive, { force: true });
  }
}
