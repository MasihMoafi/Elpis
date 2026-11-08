import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CATEGORIES, CONTEXT_EXAMPLE, demoCategories, demoSnapshot, categoryBar, ledgerMarkup, sourceProjection } from "../assets/context-ledger.mjs";
import { admissionStateAt } from "../assets/demo-state.mjs";
const luminance = (hex: string) => { const matches = hex.match(/[a-f0-9]{2}/gi); assert.ok(matches); const [r, g, b] = matches.map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); assert.ok(r !== undefined && g !== undefined && b !== undefined); return r*.2126+g*.7152+b*.0722; };
const contrast = (a: string,b: string) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
test("day terminal text stays readable on normal and highlighted ledger surfaces", async () => {
  const css=await readFile(new URL("../source.css",import.meta.url),"utf8");
  const day=css.match(/\[data-theme="elpis-light"\]\s*\{([^}]*--ledger-title[^}]*)\}/)?.[1];
  assert.ok(day);
  const token=(name: string)=>{ const value=day.match(new RegExp(`--ledger-${name}:\\s*(#[a-f0-9]{6})`))?.[1]; assert.ok(value); return value; };
  const surface="#f0ebdf";
  const mix=(foreground: string,background: string,weight: number)=>"#"+[1,3,5].map(i=>Math.round(parseInt(foreground.slice(i,i+2),16)*weight+parseInt(background.slice(i,i+2),16)*(1-weight)).toString(16).padStart(2,"0")).join("");
  for(const name of ["title","context","section","muted"]) {
    for(const background of [surface,mix(token("section"),surface,.09)]) assert.ok(contrast(token(name),background)>=4.5,`${name} on ${background}`);
  }
  const terminal=css.match(/\[data-theme="elpis-light"\] \.ace-terminal\s*\{\s*--tui-muted:\s*(#[a-f0-9]{6})/);
  assert.ok(terminal?.[1],"day terminal has a readable muted text token");
  assert.ok(contrast(terminal[1],surface)>=4.5);
});
test("native nine-category attribution reconciles in every demo phase", () => {
  assert.equal(CATEGORIES.length, 9);
  assert.equal(CONTEXT_EXAMPLE.counts.reduce((a,b)=>a+b,0), CONTEXT_EXAMPLE.total);
  for (const position of [0,.3,.45,.6,.8,1]) {
    const state=admissionStateAt(position);
    assert.equal(demoCategories(state).reduce((a,b)=>a+b,0),state.total);
  }
  assert.equal(demoCategories(admissionStateAt(.8))[4],demoCategories(admissionStateAt(.6))[4]);
  assert.equal(demoCategories(admissionStateAt(1))[4]-demoCategories(admissionStateAt(.8))[4],486);
});
test("native category marks remain distinct and visible on both website surfaces", () => {
  for (const [theme, surfaces] of [["light",["#faf7f0","#f0ebdf"]],["dark",["#0b0e0c","#121713"]]] as const) {
    assert.equal(new Set(CATEGORIES.map(c=>c[theme])).size,9);
    for (const category of CATEGORIES) for (const surface of surfaces) assert.ok(contrast(category[theme],surface)>=3,`${category.label} ${theme} contrast`);
  }
});
test("source selection changes the future estimate, never the measured snapshot", () => {
  const before=sourceProjection(CONTEXT_EXAMPLE.sources);
  const after=sourceProjection(CONTEXT_EXAMPLE.sources.map(s=>({...s,admitted:s.name==="MEMORY.md"?true:s.admitted})));
  assert.equal(after-before,19);
  assert.equal(CONTEXT_EXAMPLE.total,admissionStateAt(1).total);
});
test("native HTML includes the real controls and full-window category shares", () => {
  const html=ledgerMarkup(CONTEXT_EXAMPLE,{interactive:true});
  for (const category of CATEGORIES) assert.ok(html.includes(category.label));
  assert.match(html,/SUBAGENTS/);
  assert.match(html,/MEASURED TOTAL · ESTIMATED CATEGORY SHARES/);
  assert.match(html,/3.8%/); // Full-window user share.
  assert.doesNotMatch(html,/<img|Ask a follow-up|Backtrack|↑↓ select/);
});

test("the illustrated window is filled enough to expose all category colors", () => {
  for (const progress of [0,.45,.6,.8,1]) {
    const state=admissionStateAt(progress);
    assert.ok(state.usedPercent>=60 && state.usedPercent<70);
  }
  const compact=ledgerMarkup(CONTEXT_EXAMPLE,{compact:true});
  assert.ok(compact.includes('native-ledger-compact'));
  assert.equal((compact.match(/class="native-category"/g)||[]).length,9);
  assert.doesNotMatch(compact,/native-hints/);
  assert.equal((compact.match(/class="native-source"/g)||[]).length,8);
});

test("every category bar replacement retains named hover and keyboard targets", () => {
  for (const progress of [0,.45,.6,.8,1]) {
    const html=categoryBar(demoSnapshot(admissionStateAt(progress)));
    for (const label of [...CATEGORIES.map(c=>c.label),"Free"]) {
      assert.ok(html.includes(`data-help="${label}" aria-label="${label}"`),label);
    }
    assert.equal((html.match(/<button type="button"/g)||[]).length,10);
    assert.match(html,/role="group"/);
  }
});
