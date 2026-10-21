// Bundle the temporary standalone renderer with the desktop's locked tooling.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack');
const output = path.resolve('dist');

await new Promise((resolve, reject) => webpack({
  mode: 'production',
  target: 'web',
  context: process.cwd(),
  entry: './src/app.jsx',
  output: { path: output, filename: 'app.js' },
  resolve: { extensions: ['.ts', '.tsx', '.jsx', '.js', '.json'], conditionNames: ['production', '...'] },
  plugins: [new webpack.DefinePlugin({ 'process.env.IS_PREACT': JSON.stringify('false') })],
  optimization: { minimize: false },
  module: { rules: [
    // Excalidraw's ESM bundle imports extensionless roughjs subpaths.
    { test: /\.m?js$/, resolve: { fullySpecified: false } },
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: path.resolve('transpile.cjs') },
    { test: /\.css$/, use: require.resolve('next/dist/compiled/ignore-loader') },
    { test: /\.(woff2|png|svg)$/, type: 'asset/resource' },
  ] },
  performance: false,
}, (error, stats) => {
  if (error || stats?.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true, errorDetails: true })));
  else resolve();
}));

const excalidraw = 'node_modules/@excalidraw/excalidraw/dist/prod';
fs.copyFileSync(path.join(excalidraw, 'index.css'), path.join(output, 'app.css'));
fs.cpSync(path.join(excalidraw, 'fonts'), path.join(output, 'fonts'), { recursive: true });
fs.copyFileSync('src/index.html', path.join(output, 'index.html'));
