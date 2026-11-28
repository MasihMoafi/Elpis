import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync('components/working-mark.tsx', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const require = createRequire(import.meta.url);
const loaded = new Module(`${process.cwd()}/components/working-mark.test.cjs`);
loaded.filename = `${process.cwd()}/components/working-mark.test.cjs`;
loaded.paths = require.resolve.paths("react") ?? [];
(loaded as Module & { _compile: (source: string, filename: string) => void })._compile(js, loaded.filename);
const { WorkingMark } = loaded.exports as { WorkingMark: React.ComponentType<{ threadId?: string }> };
const render = (threadId?: string) => {
  const markup = renderToStaticMarkup(React.createElement(WorkingMark, threadId === undefined ? {} : { threadId }));
  return new JSDOM(markup).window.document.querySelector('svg')!;
};

test('working marks select six stable shapes and keep the shared SVG animations', () => {
  assert.equal(render().getAttribute('data-shape'), 'hexagon');
  const shapes = new Set<string>();
  const samples = new Map<string, SVGSVGElement>();
  for (let index = 0; index < 100; index++) {
    const id = `chat-${index}`, svg = render(id), shape = svg.getAttribute('data-shape');
    assert.ok(shape);
    shapes.add(shape);
    samples.set(shape, svg as unknown as SVGSVGElement);
    assert.equal(render(id).getAttribute('data-shape'), shape);
    assert.equal(svg.getAttribute('viewBox'), '0 0 64 64');
    assert.ok(svg.querySelector('.elpis-working-rotor'));
    assert.ok(svg.querySelector('.elpis-working-dot'));
  }
  assert.deepEqual(shapes, new Set(['hexagon', 'pentagon', 'circle', 'square', 'octagon']));
  assert.match(render().querySelector('.elpis-working-rotor path')?.getAttribute('d') ?? '', /^M32 4 56\.25 18/);
  assert.equal(render().querySelectorAll('.elpis-working-rotor line').length, 6);
  const spokeCounts = { hexagon: 6, pentagon: 5, circle: 4, square: 4, octagon: 8 } as const;
  for (const [name, count] of Object.entries(spokeCounts)) {
    assert.equal(samples.get(name)!.querySelectorAll('.elpis-working-rotor line').length, count, `${name} spokes`);
  }
  assert.equal(samples.get('circle')!.querySelector('.elpis-working-rotor circle')!.getAttribute('stroke-dasharray'), null);
  assert.ok(samples.get('square')!.querySelector('rect[rx]'));
});
