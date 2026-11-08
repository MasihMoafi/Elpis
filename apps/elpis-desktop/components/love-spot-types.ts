"use client";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
export type BoardPage = {
  name: string;
  session: string;
};
export type Drawing = {
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  appState: Partial<AppState>;
  page?: BoardPage;
};
export type Saved = {
  scene: Drawing & {
    page: BoardPage;
  };
  revision: string;
};
export type PageList = {
  pages: {
    name: string;
    modified: number;
    kept?: boolean;
    expires?: number;
  }[];
};
export type Screenshot = {
  id: string;
  name: string;
  dataURL: string;
};
export type Update =
  | ({
      type: "scene";
    } & Saved)
  | {
      type: "screenshots";
      screenshots: Screenshot[];
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "matilda";
    };
