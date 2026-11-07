export async function writeJson(path: string, value: unknown) {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1)); await rename(`${path}.tmp`, path);
}
