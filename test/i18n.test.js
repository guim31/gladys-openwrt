// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code, the feature names and the four documentation files, with the same
// sections. German says "du", never the polite "Sie".
// (Adapted from guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { NAMES } from '../src/devices.js';
import { ERROR_KINDS } from '../src/openwrt/errors.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  INIT_FAILED,
  NETWORKS_TEXT,
  REPORT_TEXT,
} from '../src/texts.js';
import { DONE_TEXT, TEXT } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)(?!\p{L})/u;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 300,
  message: 200,
  report: 400,
  short: 24,
  status: 40,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  return found;
}

function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

/** Every leaf of a per-language table: strings, rendered functions, nested objects. */
function leaves(value, render) {
  if (typeof value === 'function') {
    return [render(value)];
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((child) => leaves(child, render));
  }
  return [value];
}

const shape = (value) =>
  value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
    : typeof value;

function tableProblems(table, name, max, render) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    if (JSON.stringify(shape(table[lang])) !== JSON.stringify(shape(table.en))) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [index, text] of leaves(table[lang], render).entries()) {
      found.push(...textProblems(text, `${name}.${lang}[${index}]`, lang, max));
    }
  }
  return found;
}

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  assert.deepEqual(Object.keys(NAMES), LANGS);
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 80, `only ${texts.length} texts found in the manifest`);
  assert.deepEqual(
    texts.flatMap(({ path, value, max }) => problems(value, path, max)),
    [],
  );
});

test('the name is the same in every language', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('every message table of the code has the four languages', () => {
  const longWidgetTexts = new Set(['noHost', 'waiting', 'noClient', 'nobody']);
  const statusTexts = new Set(['uptime', 'unreachable', 'missing', 'guest', 'wifiClients']);
  const found = [
    ...problems(INIT_FAILED, 'INIT_FAILED', MAX.message),
    ...Object.entries(CONNECTION_TEXT).flatMap(([key, value]) =>
      problems(value, `CONNECTION_TEXT.${key}`, MAX.message),
    ),
    ...Object.entries(ACTION_TEXT).flatMap(([key, value]) =>
      problems(value, `ACTION_TEXT.${key}`, MAX.message),
    ),
    ...Object.entries(ERROR_TEXT).flatMap(([key, value]) =>
      problems(value, `ERROR_TEXT.${key}`, 100),
    ),
    ...Object.entries(TEXT).flatMap(([key, value]) =>
      problems(
        value,
        `TEXT.${key}`,
        longWidgetTexts.has(key) ? MAX.message : statusTexts.has(key) ? MAX.status : MAX.short,
      ),
    ),
  ];
  assert.deepEqual(found, []);
  assert.deepEqual(sorted(Object.keys(ERROR_TEXT)), sorted(Object.values(ERROR_KINDS)));
});

test('the feature and device names exist in every language', () => {
  const render = (fn) => fn('wan_backup_lte (radio1)');
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName + 20, render), []);
  for (const lang of LANGS) {
    for (const [key, name] of Object.entries(NAMES[lang])) {
      if (typeof name === 'string') {
        assert.ok(name.length <= MAX.featureName, `NAMES.${lang}.${key}`);
      }
    }
  }
});

test('the reports and toasts exist in every language', () => {
  const render = (fn) => fn('ubus (HTTPS)', 'OpenWrt Linksys E8450 (UBI)', '23.05.5');
  const counts = (fn) =>
    fn.length === 1 && fn.toString().includes('wifi')
      ? fn({ wifi: 12, leases: 34, neighbours: 56 })
      : render(fn);
  assert.deepEqual(tableProblems(REPORT_TEXT, 'REPORT_TEXT', MAX.report, counts), []);
  assert.deepEqual(
    tableProblems(NETWORKS_TEXT, 'NETWORKS_TEXT', MAX.message, (fn) => fn(12)),
    [],
  );
  assert.deepEqual(tableProblems(DONE_TEXT, 'DONE_TEXT', MAX.message, render), []);
});

test('the guard catches a missing language, an empty text and the polite German form', () => {
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: 'Licht' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: '', es: 'Luz' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Gerät', 'Ihre IP', 'mit Ihrem', 'Ihnen']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'a' }, 'x', 60),
    [],
  );
  const forgotten = structuredClone(manifest);
  delete forgotten.scene_triggers[0].fields[0].label.de;
  assert.deepEqual(
    manifestTexts(forgotten).flatMap(({ path, value, max }) => problems(value, path, max)),
    ['manifest.scene_triggers[0].fields[0].label has [en,fr,es], expected exactly [en,fr,de,es]'],
  );
});

// --- Documentation ---------------------------------------------------------------

const docs = Object.fromEntries(
  await Promise.all(
    LANGS.map(async (lang) => [
      lang,
      await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8'),
    ]),
  ),
);

const headings = (markdown) =>
  markdown
    .split('\n')
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.match(/^#+/)[0].length);

test('the four documentation files exist, with the same sections', () => {
  for (const lang of LANGS) {
    assert.ok(docs[lang].length >= 300, `docs/${lang}.md is too short for the store`);
    assert.deepEqual(headings(docs[lang]), headings(docs.en), `docs/${lang}.md sections`);
  }
  assert.ok(headings(docs.en).length >= 12);
});

test('the documentation names every trigger, action, widget, button and feature', () => {
  for (const lang of LANGS) {
    const doc = docs[lang].replace(/\s+/g, ' ');
    const items = [
      ...manifest.scene_triggers,
      ...manifest.scene_actions,
      ...manifest.widgets,
      ...manifest.actions,
    ];
    for (const item of items) {
      assert.ok(doc.includes(item.label[lang]), `docs/${lang}.md: "${item.label[lang]}"`);
    }
    for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
      assert.ok(doc.includes(field.label[lang]), `docs/${lang}.md: field "${field.label[lang]}"`);
    }
    assert.ok(doc.includes(TEXT.reboot[lang]), `docs/${lang}.md: "${TEXT.reboot[lang]}"`);
    for (const name of Object.values(NAMES[lang]).filter((n) => typeof n === 'string')) {
      assert.ok(doc.includes(name), `docs/${lang}.md: feature "${name}"`);
    }
  }
});

test('the German documentation says "du"', () => {
  const polite = docs.de
    .split('\n')
    .filter((line) => !line.startsWith('`') && POLITE_GERMAN.test(line));
  assert.deepEqual(polite, []);
});

test('the documentation says it was developed without the hardware, and not affiliated', () => {
  assert.match(docs.en, /Developed without the hardware: feedback welcome/);
  assert.match(docs.en, /not affiliated with the OpenWrt project/);
  for (const lang of LANGS) {
    assert.match(docs[lang], /github\.com\/guim31\/gladys-openwrt\/issues/);
  }
});
