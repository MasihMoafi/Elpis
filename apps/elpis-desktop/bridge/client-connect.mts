import type { DesktopClientOptions } from "./client-options.mts";
import { BridgeError } from "./validate.mts";
import { profileEnvironment } from "./profile-env.mts";
import { MAX_BRIDGE_MESSAGE_BYTES, existingSocket } from "./client-paths.mts";
import type { ClientSocket } from "./client-state.mts";
import type { DesktopClient } from "./client.mts";

export async function runConnect(this: typeof DesktopClient, options: DesktopClientOptions = {}) {
  const { default: WebSocket } = (await import("ws" as string)) as {
    default: new (
      address: string,
      options?: { maxPayload?: number },
    ) => ClientSocket & { once(event: string, listener: (...args: unknown[]) => void): void; terminate(): void };
  };
  const openSocket = async () => {
    await options.beforeConnect?.();
    // An explicitly isolated profile must not inherit another profile's ambient socket override.
    const socketEnv = profileEnvironment(options.home);
    const socketPath = existingSocket(options.socketPath, socketEnv);
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: MAX_BRIDGE_MESSAGE_BYTES });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new BridgeError("Bridge connection timed out", 504));
      }, 10000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new BridgeError("Could not connect to the existing Elpis bridge", 503));
      });
    });
    return socket;
  };
  // In the background the client exists at once and connects, and reconnects, on its own: the window never waits for
  // a runtime that is still starting or missing, and shows it as connecting until it arrives.
  if (options.background) {
    const client = new this({ on() {}, send() {}, terminate() {}, close() {} }, { ...options, openSocket });
    client.reconnectFromOffline();
    return client;
  }
  const client = new this(await openSocket(), { ...options, openSocket });
  try {
    await client.initialize();
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}
