import fs from "node:fs/promises";
import { BridgeError } from "../validate.mts";

export const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function acquireLock(lock: string) {
  try {
    const handle = await fs.open(lock, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await fs.readFile(lock, "utf8"));
    if (alive(pid)) throw new BridgeError("A workflow is already running in this conversation", 409);
    await fs.unlink(lock);
    return false;
  }
}
