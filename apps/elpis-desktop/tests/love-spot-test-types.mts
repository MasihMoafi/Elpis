import type { Page } from 'playwright-core';

export type Attachment = { type: string; name?: string; text?: string; dataUrl?: string };
export type Turn = { id: string; text: string; attachments: Attachment[]; model?: string };
export type SceneElement = { id: string; type: string; isDeleted: boolean; text?: string; strokeColor: string; version: number; originalText?: string; versionNonce?: number; x?: number; y?: number; width?: number; height?: number; groupIds?: string[]; fileId?: string; index?: string | null };
export type Scene = { elements: SceneElement[]; page?: { name: string }; files: Record<string, { dataURL: string }> };
export type LoveSpotClient = {
  emit(event: string, ...args: unknown[]): boolean;
  voiceStatus?: () => Promise<{ available: boolean }>;
  startVoice?: (id: string, sdp: string) => Promise<void>;
  stopVoice?: (id: string) => Promise<void>;
  transcriptionDefinition?: () => Promise<{ command: string; args: string[]; env: Record<string, string> } | undefined>;
  transcriptionEnvironment?: () => Promise<Record<string, string>>;
};
export type LoveSpotFixture = {
  page: Page;
  root: string;
  directory: string;
  screenshots: string;
  url: string;
  turns: Turn[];
  chats: { id: string; name?: string; cwd?: string }[];
  errors: string[];
  requests: string[];
  open(page: Page): Promise<void>;
  newPage(): Promise<Page>;
  draw(page: Page, offset?: number): Promise<void>;
  scene(): Promise<Scene>;
  waitFor(check: (scene: Scene) => unknown | Promise<unknown>, message: string, timeout?: number): Promise<Scene>;
  close(): Promise<void>;
};
export type LoveSpotOptions = {
  threadId?: (index: number) => string;
  colorScheme?: 'light' | 'dark';
  replyDelay?: number | ((turns: Turn[]) => number);
  configureClient?: (client: LoveSpotClient) => void;
  prepareDirectory?: (directory: string) => Promise<void>;
};
