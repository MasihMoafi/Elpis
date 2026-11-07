import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
// ELPIS_TYPES_CHECKED=1: the caller has just run an incremental `tsc --noEmit` (3 s warm), so Next skips its own 21 s pass.
// Install builds leave it unset and keep the full check.
const config: NextConfig = { output: "export", experimental: { cpus: 1 }, poweredByHeader: false, images: { unoptimized: true }, typescript: { ignoreBuildErrors: process.env.ELPIS_TYPES_CHECKED === "1" }, webpack(config) {
  // Next's webpack rules omit .cts and .mts; Node's type stripping preserves their module syntax.
  config.module.rules.unshift({ test: /\.[cm]ts$/, use: [fileURLToPath(new URL('./bridge/strip-types.cts', import.meta.url))] });
  config.module.rules.unshift({ test: /\.tsx$/, include: ['app', 'components'].map(dir => fileURLToPath(new URL(`./${dir}`, import.meta.url))), enforce: 'pre', use: [fileURLToPath(new URL('./bridge/source-map.cts', import.meta.url))] });
  return config;
} };

export default config;
