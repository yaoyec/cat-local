import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NUXT_DIR = path.resolve(HERE, "../../../pulled-frontend/_nuxt");
const EXPECTED_PHASE_ONE_EVENTS = [
  "style:get",
  "style:setAll",
  "userPersonalization:get",
  "userPersonalization:setFavorites"
].sort();

const compact = (value) => value.replace(/\s+/g, "");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (value, needle) => value.split(needle).length - 1;

// These anchors intentionally avoid generated line numbers and full minified formatting.
// A semantic refactor or minifier alias change can still require updating the static anchors.
function closingBrace(source, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  assert.fail("unterminated function block");
}

function namedFunction(source, name) {
  const matcher = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`, "g");
  const matches = [...source.matchAll(matcher)];
  assert.equal(matches.length, 1, `expected exactly one function ${name}`);
  const start = matches[0].index;
  const open = source.indexOf("{", start + matches[0][0].length);
  assert.notEqual(open, -1, `missing body for ${name}`);
  const close = closingBrace(source, open);
  return {
    full: source.slice(start, close + 1),
    body: source.slice(open + 1, close)
  };
}

function componentRegion(source, name, requiredMarker) {
  const marker = /\b__name\s*:\s*(["'])([^"']+)\1/g;
  const markers = [...source.matchAll(marker)];
  const regions = markers.map((entry, index) => ({
    name: entry[2],
    text: source.slice(entry.index, markers[index + 1]?.index ?? source.length)
  }));
  const candidates = regions.filter((entry) => entry.name === name && entry.text.includes(requiredMarker));
  assert.equal(candidates.length, 1, `expected one ${name} component containing ${requiredMarker}`);
  return candidates[0].text;
}

function eventAlias(source, event) {
  const matcher = new RegExp(
    `\\b([$A-Z_a-z][$\\w]*)\\s*=\\s*([$A-Z_a-z][$\\w]*)\\s*\\(\\s*(["'])${escapeRegExp(event)}\\3\\s*\\)`,
    "g"
  );
  const matches = [...source.matchAll(matcher)];
  assert.equal(matches.length, 1, `expected one listener alias for ${event}`);
  return matches[0][1];
}

function assertLifecycle(source, region, prefix, events, timers) {
  const flat = compact(region);
  assert.match(
    flat,
    new RegExp(`await[$A-Z_a-z][$\\w]*\\(\\);if\\(${prefix}Disposed\\)return;`),
    `${prefix}: disposed guard after await`
  );
  const cleanupAt = flat.indexOf(`${prefix}Disposed=!0`);
  assert.notEqual(cleanupAt, -1, `${prefix}: unmount disposal marker`);
  const cleanup = flat.slice(cleanupAt);
  for (const timer of timers) {
    assert.match(cleanup, new RegExp(`clearTimeout\\(${timer}\\)`), `${prefix}: clear ${timer}`);
  }
  for (const event of events) {
    const alias = eventAlias(source, event);
    const assignment = new RegExp(`\\b([$A-Z_a-z][$\\w]*)=${escapeRegExp(alias)}\\(`, "g");
    const handles = [...flat.matchAll(assignment)].map((match) => match[1]);
    assert.equal(handles.length, 1, `${prefix}: retain one unsubscribe handle for ${event}`);
    assert.match(
      cleanup,
      new RegExp(`\\b${escapeRegExp(handles[0])}(?:\\?\\.)?\\(\\)`),
      `${prefix}: unsubscribe ${event}`
    );
  }
}

function assertStickyEditLifecycle(region, prefix) {
  const flat = compact(region);
  assert.match(
    flat,
    new RegExp(`${prefix}EditGeneration(?:\\+=1|\\+\\+)`),
    `${prefix}: edits advance monotonically`
  );
  assert.match(
    flat,
    new RegExp(`editGeneration:${prefix}EditGeneration`),
    `${prefix}: submit captures edit generation`
  );
  assert.match(
    flat,
    new RegExp(`[$A-Z_a-z][$\\w]*\\.editGeneration===${prefix}EditGeneration`),
    `${prefix}: acknowledgement checks submitted generation`
  );

  // Accept either a generation-at-hydration guard or an explicit sticky dirty flag.
  const generationGuard = new RegExp(`${prefix}EditGeneration===${prefix}BaselineGeneration`);
  const explicitDirtyGuard = new RegExp(`${prefix}(?:Draft)?Dirty(?:\\.value)?`);
  assert.ok(
    generationGuard.test(flat) || explicitDirtyGuard.test(flat),
    `${prefix}: dirty-since-authoritative-hydration remains sticky`
  );
}

async function loadBundles() {
  const entries = (await fs.readdir(NUXT_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const files = [];
  for (const prefix of ["index-", "remote-test-"]) {
    const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".js"));
    assert.equal(matches.length, 1, `expected one current ${prefix}*.js bundle, got ${matches.join(", ")}`);
    files.push(matches[0]);
  }
  return Promise.all(files.map(async (name) => ({
    name,
    source: await fs.readFile(path.join(NUXT_DIR, name), "utf8")
  })));
}

function assertTransportAndEvents(source) {
  const legacy = compact(namedFunction(source, "ip").body);
  const strict = compact(namedFunction(source, "phaseOneEmit").body);
  assert.doesNotMatch(legacy, /JSON\.stringify/);
  const legacyObject = /\.emit\([^,]+,\{([^{}]*)\}\)/.exec(legacy);
  assert.ok(legacyObject, "legacy ip emits an object");
  assert.deepEqual(
    [...legacyObject[1].matchAll(/(?:^|,)([$A-Z_a-z][$\w]*):/g)].map((match) => match[1]).sort(),
    ["data", "user"]
  );
  assert.match(strict, /\.emit\([^,]+,JSON\.stringify\(/);
  const strictObject = /JSON\.stringify\(\{([^{}]*)\}\)/.exec(strict);
  assert.ok(strictObject, "phaseOneEmit stringifies one object");
  assert.deepEqual(
    [...strictObject[1].matchAll(/(?:^|,)([$A-Z_a-z][$\w]*):/g)].map((match) => match[1]).sort(),
    ["data"]
  );

  const calls = [...source.matchAll(/\bphaseOneEmit\s*\(\s*(["'])([^"'\\]+)\1/g)]
    .map((match) => match[2]);
  assert.equal(calls.length, 4, "exactly four strict Phase 1 call sites");
  assert.deepEqual([...calls].sort(), EXPECTED_PHASE_ONE_EVENTS);

  const styleGet = namedFunction(source, "dR").body;
  assert.match(styleGet, /phaseOneEmit\s*\(\s*["']style:get["']/);
  assert.match(styleGet, /\buuid\s*:/);
  assert.match(styleGet, /\brequestId\s*:/);
  const personalizationGet = namedFunction(source, "yD").body;
  assert.match(personalizationGet, /phaseOneEmit\s*\(\s*["']userPersonalization:get["']/);
  assert.match(personalizationGet, /\brequestId\s*:/);
}

function assertStateMachines(source) {
  const style = componentRegion(source, "Style", "styleGetRequestId");
  const full = componentRegion(source, "Full", "personalGetRequestId");
  const resource = componentRegion(source, "Resource", "resourceGetRequestId");
  const styleFlat = compact(style);
  const fullFlat = compact(full);
  const resourceFlat = compact(resource);

  // `A` is the imported createElementVNode helper in these generated bundles. A local
  // Style ref with the same name turns later form items into comment VNodes at runtime.
  assert.doesNotMatch(style, /(?:const|let|var|,)\s*A\s*=\s*B\(!1\)/, "Style must not shadow vnode helper A");
  assert.match(style, /\bstyleLoaded\s*=\s*B\(!1\)/, "Style uses a descriptive loaded ref");

  assert.match(styleFlat, /styleGetRequestId=phaseOneRequestId\(["']style-get["']\)/);
  assert.match(styleFlat, /\.uuid!==[^|;]+\.uuid\|\|[^|;]+\.requestId!==styleGetRequestId/);
  assert.match(
    styleFlat,
    /phaseOneEmit\(["']style:setAll["'],\{[^{}]*expectedVersion:[^{}]*requestId:/
  );
  assert.match(styleFlat, /requestId===[$\w]+\.requestId/);
  for (const marker of ["styleAttemptSequence", "VERSION_CONFLICT"]) {
    assert.ok(style.includes(marker), `Style has ${marker}`);
  }
  assertStickyEditLifecycle(style, "style");
  assertLifecycle(
    source,
    style,
    "style",
    ["style:get:success", "style:get:fail", "style:setAll:success", "style:setAll:fail"],
    ["styleGetTimer", "styleSaveTimer"]
  );

  assert.match(fullFlat, /personalGetRequestId=phaseOneRequestId\(["']personalization-get["']\)/);
  assert.match(fullFlat, /requestId!==personalGetRequestId/);
  assert.match(fullFlat, /requestId===[$\w]+\.requestId/);
  assert.match(
    fullFlat,
    /phaseOneEmit\(["']userPersonalization:setFavorites["'],\{[^{}]*categoryOrder:[^{}]*expectedVersion:[^{}]*requestId:/
  );
  assert.match(fullFlat, /personalSaving\.value\|\|!personalLoaded\.value/);
  const favoriteManagerButton = /onClick:[$A-Z_a-z][$\w]*,disabled:!T\(personalLoaded\)\|\|T\(personalSaving\)[\s\S]{0,300}?\},8,\["disabled"\]\)/;
  assert.match(fullFlat, favoriteManagerButton, "favorite manager forwards dynamic disabled with patchFlag 8");
  assert.doesNotMatch(fullFlat, /\},null,8,\["disabled"\]\)/, "patchFlag and dynamicProps must not be shifted");
  assert.ok(full.includes("VERSION_CONFLICT"), "Full has VERSION_CONFLICT handling");
  assertStickyEditLifecycle(full, "personal");
  assertLifecycle(
    source,
    full,
    "personal",
    ["userPersonalization:get:success", "userPersonalization:setFavorites:success", "userPersonalization:error"],
    ["personalGetTimer", "personalSaveTimer"]
  );

  assert.match(resourceFlat, /resourceGetRequestId=phaseOneRequestId\(["']resource-personalization-get["']\)/);
  assert.match(resourceFlat, /requestId!==resourceGetRequestId/);
  assertLifecycle(
    source,
    resource,
    "resource",
    ["userPersonalization:get:success", "userPersonalization:setFavorites:success", "userPersonalization:error"],
    ["resourceGetTimer"]
  );

  const normalizerSource = namedFunction(source, "personalizationCategoryOrder").full;
  const normalize = Function(
    "Ot",
    "Ft",
    `"use strict"; return (${normalizerSource});`
  )(
    { beta: {}, alpha: {}, custom: {}, gamma: {} },
    { Custom: "custom" }
  );
  assert.deepEqual(normalize(["alpha", "alpha", "missing", "custom"]), ["alpha", "beta", "gamma"]);
  assert.deepEqual(normalize(null), ["beta", "alpha", "gamma"]);
  assert.ok(
    count(full, "personalizationCategoryOrder(") >= 3,
    "Full wires normalized order into authority, draft, grouping, and tabs"
  );
  assert.ok(
    count(resource, "personalizationCategoryOrder(") >= 2,
    "Resource wires normalized order into grouping and tabs"
  );
}

test("built frontend bundles retain Phase 1 contracts", async (t) => {
  for (const bundle of await loadBundles()) {
    await t.test(bundle.name, () => {
      assertTransportAndEvents(bundle.source);
      assertStateMachines(bundle.source);
    });
  }
});
