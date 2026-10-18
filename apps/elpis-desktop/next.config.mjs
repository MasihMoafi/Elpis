import { fileURLToPath } from 'node:url';
export default { output: "export", poweredByHeader: false, images: { unoptimized: true }, webpack(config) {
  config.module.rules.unshift({ test: /\.tsx$/, include: ['app', 'components'].map(dir => fileURLToPath(new URL(`./${dir}`, import.meta.url))), enforce: 'pre', use: [fileURLToPath(new URL('./bridge/source-map.cjs', import.meta.url))] });
  return config;
} };
