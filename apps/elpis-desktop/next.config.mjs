import { fileURLToPath } from 'node:url';
// ELPIS_TYPES_CHECKED=1: the caller has just run an incremental `tsc --noEmit` (3 s warm), so Next skips its own 21 s pass.
// Install builds leave it unset and keep the full check.
export default { output: "export", experimental: { cpus: 1 }, poweredByHeader: false, images: { unoptimized: true }, typescript: { ignoreBuildErrors: process.env.ELPIS_TYPES_CHECKED === "1" }, webpack(config) {
  config.module.rules.unshift({ test: /\.tsx$/, include: ['app', 'components'].map(dir => fileURLToPath(new URL(`./${dir}`, import.meta.url))), enforce: 'pre', use: [fileURLToPath(new URL('./bridge/source-map.cjs', import.meta.url))] });
  return config;
} };
