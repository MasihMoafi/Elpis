import { execFile } from "node:child_process";

/** A real Word container, including Unicode and pagination cases, rather than renamed plain text. */
export function makeDocx(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("pandoc", ["--from=markdown", "--to=docx"],
      { encoding: "buffer", timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
      (error, bytes) => error ? reject(new Error("DOCX fixture generation failed", { cause: error })) : resolve(bytes));
    child.stdin?.end(text);
  });
}
