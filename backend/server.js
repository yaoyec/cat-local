import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import express from "express";
import { Server as SocketServer } from "socket.io";
import { b as actionGroupCatalog, c as battleMonsterCatalog, f as farmingCatalog } from "../pulled-frontend/_nuxt/game-jresource-BuAYGK_i.js";
import { a as resourceCatalog } from "../pulled-frontend/_nuxt/game-json-resources-C7HDgHOG.js";
import {
  applyIncomingDamage,
  applyStateTurnStart,
  grantSkillExp,
  isConfused,
  isIncapacitated,
  isUntargetable,
  resolveSkillEffects,
  selectSkill,
  skillExpToNext,
  stateLabel,
  tauntSources,
  tickStates
} from "./battle-skills.js";
import {
  battleSlotState,
  loadSkillTrees,
  nodeCost,
  nodeRequirements,
  skillTreeStatusBonus
} from "./skill-tree.js";

// 上游目录的猫猫剑意外只保留了回收价，导致心意商店把它显示成仅可出售。
// 和同系列猫猫枪/锤一致，基础猫猫剑售价应为 120 心意点。
if (resourceCatalog.cuteSword?.id === "cuteSword" && !resourceCatalog.cuteSword.userBuyCost?.length) {
  resourceCatalog.cuteSword.userBuyCost = [{ cost: "cutePoint", count: 120 }];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..", "pulled-frontend");
// 专精树（战斗/生活）的节点数据只有前端包里有，启动时解析一次
const skillTreeCatalog = loadSkillTrees(frontendRoot);
if (skillTreeCatalog.error) {
  console.error("failed to load skill trees", skillTreeCatalog.error.message);
}
const actionDurationMs = (() => {
  try {
    const actionFile = fs.readdirSync(path.join(frontendRoot, "_nuxt")).find((name) => name.startsWith("game-json-actions-") && name.endsWith(".js"));
    if (!actionFile) return {};
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", actionFile), "utf8");
    const durations = {};
    const pattern = /(?:^|[,{])([A-Za-z0-9_]+):\{id:"([^"]+)"[^{}]*?baseDuration:([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)/g;
    for (const match of source.matchAll(pattern)) {
      const duration = Number(match[3]);
      if (Number.isFinite(duration) && duration > 0) durations[match[2]] = duration;
    }
    return durations;
  } catch {
    return {};
  }
})();
const actionImprovements = (() => {
  try {
    const actionFile = fs.readdirSync(path.join(frontendRoot, "_nuxt")).find((name) => name.startsWith("game-json-actions-") && name.endsWith(".js"));
    if (!actionFile) return {};
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", actionFile), "utf8");
    const actions = [...source.matchAll(/(?:^|[,{])([A-Za-z0-9_]+):\{id:"([^"]+)"/g)];
    const improvements = {};
    actions.forEach((match, index) => {
      const start = match.index + (match[0].startsWith(",") ? 1 : 0);
      const end = actions[index + 1]?.index ?? source.length;
      const actionSource = source.slice(start, end);
      const improveMatch = actionSource.match(/characterImprove:\[([^\]]*)\]/);
      if (!improveMatch) return;
      const values = [...improveMatch[1].matchAll(/\{status:"([^"]+)",increaseExp:([0-9]+(?:\.[0-9]+)?)\}/g)]
        .map((improve) => ({ status: improve[1], increaseExp: Number(improve[2]) }));
      if (values.length) improvements[match[2]] = values;
    });
    return improvements;
  } catch {
    return {};
  }
})();
const actionRewards = (() => {
  try {
    const actionFile = fs.readdirSync(path.join(frontendRoot, "_nuxt")).find((name) => name.startsWith("game-json-actions-") && name.endsWith(".js"));
    if (!actionFile) return {};
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", actionFile), "utf8");
    const rewards = {};
    const actions = [...source.matchAll(/(?:^|[,{])([A-Za-z0-9_]+):\{id:"([^"]+)"/g)];
    actions.forEach((match, index) => {
      const start = match.index + (match[0].startsWith(",") ? 1 : 0);
      const end = actions[index + 1]?.index ?? source.length;
      const actionSource = source.slice(start, end);
      const rewardMatch = actionSource.match(/rewards:\[([\s\S]*?)\],characterImprove:/);
      if (!rewardMatch) return;
      const values = [...rewardMatch[1].matchAll(/\{id:"([^"]+)",percent:([^,}]+)(?:,count:([^,}]+)|,range:\{min:([^,}]+),max:([^,}]+)\})?/g)]
        .map((reward) => ({
          resourceId: reward[1],
          percent: Number(reward[2]),
          count: reward[3] === undefined ? null : Number(reward[3]),
          min: reward[4] === undefined ? null : Number(reward[4]),
          max: reward[5] === undefined ? null : Number(reward[5])
        }))
        .filter((reward) => reward.resourceId && Number.isFinite(reward.percent));
      if (values.length) rewards[match[2]] = values;
    });
    return rewards;
  } catch {
    return {};
  }
})();
const actionRequirements = (() => {
  try {
    const actionFile = fs.readdirSync(path.join(frontendRoot, "_nuxt")).find((name) => name.startsWith("game-json-actions-") && name.endsWith(".js"));
    if (!actionFile) return {};
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", actionFile), "utf8");
    const requirements = {};
    const actions = [...source.matchAll(/(?:^|[,{])([A-Za-z0-9_]+):\{id:"([^"]+)"/g)];
    actions.forEach((match, index) => {
      const start = match.index + (match[0].startsWith(",") ? 1 : 0);
      const end = actions[index + 1]?.index ?? source.length;
      const actionSource = source.slice(start, end);
      const resourceMatch = actionSource.match(/requirement:\{[\s\S]*?resource:\[([^\]]*)\]/);
      if (!resourceMatch) return;
      const values = [...resourceMatch[1].matchAll(/\{id:"([^"]+)",count:([^,}]+)\}/g)]
        .map((requirement) => ({ resourceId: requirement[1], count: Number(requirement[2]) }))
        .filter((requirement) => requirement.resourceId && Number.isFinite(requirement.count) && requirement.count > 0);
      if (values.length) requirements[match[2]] = values;
    });
    return requirements;
  } catch {
    return {};
  }
})();
const actionNames = (() => {
  try {
    const actionFile = fs.readdirSync(path.join(frontendRoot, "_nuxt")).find((name) => name.startsWith("game-json-actions-") && name.endsWith(".js"));
    if (!actionFile) return {};
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", actionFile), "utf8");
    const names = {};
    for (const match of source.matchAll(/(?:^|,|\{)([A-Za-z0-9_]+):\{id:"([^"]+)",name:"([^"]*)"/g)) names[match[2]] = match[3];
    return names;
  } catch {
    return {};
  }
})();
// ---- 建造（building）----
// 建造不是数据表里的普通动作：前端在 game-action 包里运行时合成
//   j = { henhouse:{ id:"henhouse", name:"鸡舍", icon:"🐔", description:"…", buildDuration:6e5,
//                    maxLevel:10, buildRequirement:{ resource:[{id:"wood",count:1900}, …] } }, … }
//   S = Object.keys(j) → { "build_"+type: { id, name:"建造"+name, baseDuration:buildDuration,
//                                          requirement:buildRequirement, rewards:[{buildingId:type}] } }
// 后端不跟着合成的话，addTaskToQueue("build_xxx") 会被判 unknown action，
// 即便跑完了也没有任何地方把建筑状态写成 BUILT。
const buildingCatalog = (() => {
  try {
    const dir = path.join(frontendRoot, "_nuxt");
    const actionFile = fs.readdirSync(dir).find((name) => name.startsWith("game-action-") && name.endsWith(".js"));
    if (!actionFile) return {};
    const source = fs.readFileSync(path.join(dir, actionFile), "utf8");
    const marker = "const j={henhouse:";
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return {};
    const start = source.indexOf("{", markerIndex);
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'" || character === "`") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) return {};
    return Function(`"use strict"; return (${source.slice(start, end)})`)();
  } catch {
    return {};
  }
})();
const buildingActions = (() => {
  const actions = {};
  for (const [type, building] of Object.entries(buildingCatalog)) {
    if (!building || typeof building !== "object") continue;
    const duration = Number(building.buildDuration);
    const requirements = (building.buildRequirement?.resource || [])
      .map((requirement) => ({ resourceId: String(requirement?.id || ""), count: Number(requirement?.count) }))
      .filter((requirement) => requirement.resourceId && Number.isFinite(requirement.count) && requirement.count > 0);
    actions[`build_${type}`] = {
      id: `build_${type}`,
      type,
      name: `建造${building.name || type}`,
      // 兜底 24s 与后面 DEFAULT_TASK_DURATION_MS 保持一致（那个常量定义在函数区，这里用不到）
      baseDuration: Number.isFinite(duration) && duration > 0 ? duration : 24e3,
      requirements
    };
  }
  return actions;
})();
// 灌进动作表，让 taskActionExists / taskDurationFor / taskRequirementsFor /
// actionDurationDetailFor / actionResourceRequirementDetailFor 全都自然生效
for (const [actionId, action] of Object.entries(buildingActions)) {
  actionDurationMs[actionId] = action.baseDuration;
  actionRequirements[actionId] = action.requirements;
}
const battleAreaCatalog = (() => {
  try {
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", "game-battle-skill-I4Ckwbp2.js"), "utf8");
    const marker = "ce={";
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return {};
    const start = markerIndex + marker.length - 1;
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'" || character === "`") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) return {};
    return Function(`"use strict"; return (${source.slice(start, end)})`)();
  } catch {
    return {};
  }
})();
const itemUseEffects = (() => {
  try {
    const resourceFile = fs.readdirSync(path.join(frontendRoot, "_nuxt")).find((name) => name.startsWith("game-json-resources-") && name.endsWith(".js"));
    if (!resourceFile) return {};
    const source = fs.readFileSync(path.join(frontendRoot, "_nuxt", resourceFile), "utf8");
    const resources = [...source.matchAll(/(?:^|[,{])([A-Za-z0-9_]+):\{id:"([^"]+)"/g)];
    const effects = {};
    resources.forEach((match, index) => {
      const start = match.index + (match[0].startsWith(",") ? 1 : 0);
      const end = resources[index + 1]?.index ?? source.length;
      const resourceSource = source.slice(start, end);
      const effectValues = [];
      for (const effectMatch of resourceSource.matchAll(/resourceEffect:\[([^\]]*)\]/g)) {
        for (const value of effectMatch[1].matchAll(/\{resource:"([^"]+)",increase:([^,}]+)(?:,percent:([^,}]+))?/g)) {
          const increase = Number(value[2]);
          const percent = value[3] === undefined ? 1 : Number(value[3]);
          if (Number.isFinite(increase) && Number.isFinite(percent)) {
            effectValues.push({ resource: value[1], increase, percent });
          }
        }
      }
      if (effectValues.length) effects[match[2]] = effectValues;
    });
    return effects;
  } catch {
    return {};
  }
})();
const STYLE_CATALOGS = Object.freeze({
  battle: new Set(["warrior", "magical", "cleric", "ninja"]),
  chatContent: new Set(),
  chatName: new Set(),
  profile: new Set(["wangzong", "yixiao", "fishing_1", "night_ninja_1", "cute_kitty_1"]),
  chatBubble: new Set(["cute_cat_1", "cute_cat_2", "dark_mag_1", "kitty_1", "moon_1", "ninja_cat_1", "star_1"]),
  avatarBorder: new Set([
    "kitty_head_1", "bunny_1", "ghostBladeNebula", "mageKitty1", "holyPawsGospel", "emberClaw",
    "axeEnhanceMaster1", "cuteParty", "kittyRing2", "20260203potato", "meowQuest", "privateDetective",
    "catVillageOverseer_1", "catVillageOverseer_2", "SpringFestivalLuckyCat2026", "SpringFestival2026_1",
    "SpringFestival2026_12", "SpringFestival2026_LuckyHorseCat", "SpringFestival2026_LuckyHorseCat2",
    "slumberCat", "catMercante"
  ])
});
const STYLE_FIELDS = Object.freeze([
  ["battle", "availableBattleCardStyles", "currentBattleCardStyle"],
  ["chatContent", "availableChatContentStyles", "currentChatContentStyle"],
  ["chatName", "availableChatNameStyles", "currentChatNameStyle"],
  ["profile", "availableProfileStyles", "currentProfileStyle"],
  ["chatBubble", "availableChatBubbleStyles", "currentChatBubbleStyle"],
  ["avatarBorder", "availableAvatarBorders", "currentAvatarBorder"]
]);
const SAFE_CSS_HEX = /^#[0-9a-fA-F]{6}$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RESOURCE_ID_CATALOG = new Set(Object.values(resourceCatalog)
  .filter((resource) => resource && typeof resource === "object" && typeof resource.id === "string" && resourceCatalog[resource.id] === resource)
  .map((resource) => resource.id));
const PERSONALIZATION_FAVORITES_LIMIT = 500;
const PERSONALIZATION_CATEGORY_LIMIT = 100;
const PERSONALIZATION_CATEGORY_LENGTH_LIMIT = 100;
const STYLE_OWNED_LIMIT = 500;
const UNIQUE_FLAG_LIMIT = 500;
const DIY_COLOR_LIMIT = 7;
const DIY_TEXT_SHADOW_LIMIT = 2;
const DIY_FLAG = Object.freeze({ type: "chatBubble", key: "diy" });
const LUCKY_HORSE_CAT_2_RESOURCE_ID = "t_avatarBorder_SpringFestival2026_LuckyHorseCat2";
const LUCKY_HORSE_CAT_2_STYLE = "SpringFestival2026_LuckyHorseCat2";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freshPersonalization() {
  return { favoriteItems: [], categoryOrder: [], version: 0, updatedAt: null };
}

function freshStyleState() {
  return {
    owned: { battle: [], chatContent: [], chatName: [], profile: [], chatBubble: [], avatarBorder: [] },
    selected: { battle: "", chatContent: "", chatName: "", profile: "", chatBubble: "", avatarBorder: "" },
    diyChatBubbleStyle: { bgColor: [], textColor: [], textShadow: [] },
    version: 0,
    updatedAt: null
  };
}

function nonNegativeVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function nextUpdatedAt(previous) {
  const now = Date.now();
  const prior = validTimestamp(previous) ? Date.parse(previous) : 0;
  return new Date(Math.max(now, prior)).toISOString();
}

function uniqueCatalogStrings(list, catalog, limit = STYLE_OWNED_LIMIT) {
  if (!Array.isArray(list)) return [];
  const result = [];
  const seen = new Set();
  for (let index = 0; index < Math.min(list.length, limit); index += 1) {
    const value = list[index];
    if (typeof value !== "string" || FORBIDDEN_OBJECT_KEYS.has(value) || !catalog.has(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizePersonalizationState(value) {
  const source = isPlainObject(value) ? value : {};
  const favoriteItems = uniqueCatalogStrings(source.favoriteItems ?? source.favorites, RESOURCE_ID_CATALOG, PERSONALIZATION_FAVORITES_LIMIT);
  const categoryOrder = [];
  const seenCategories = new Set();
  if (Array.isArray(source.categoryOrder)) {
    for (let index = 0; index < Math.min(source.categoryOrder.length, PERSONALIZATION_CATEGORY_LIMIT); index += 1) {
      const entry = source.categoryOrder[index];
      if (typeof entry !== "string" || entry.length === 0 || entry.length > PERSONALIZATION_CATEGORY_LENGTH_LIMIT
        || FORBIDDEN_OBJECT_KEYS.has(entry) || seenCategories.has(entry)) continue;
      seenCategories.add(entry);
      categoryOrder.push(entry);
    }
  }
  return { favoriteItems, categoryOrder, version: nonNegativeVersion(source.version), updatedAt: validTimestamp(source.updatedAt) };
}

function stableUnique(list, keyOf, limit) {
  const result = [];
  const seen = new Set();
  for (let index = 0; Array.isArray(list) && index < Math.min(list.length, limit); index += 1) {
    const value = list[index];
    const key = keyOf(value);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeDiyStyle(value) {
  const source = isPlainObject(value) ? value : {};
  const colors = (raw) => stableUnique(raw, (color) => typeof color === "string" && SAFE_CSS_HEX.test(color) ? color.toLowerCase() : null, DIY_COLOR_LIMIT);
  const textShadow = stableUnique(source.textShadow, (shadow) => isPlainObject(shadow)
    && Object.keys(shadow).every((key) => ["color", "blur"].includes(key))
    && typeof shadow.color === "string" && SAFE_CSS_HEX.test(shadow.color)
    && Number.isInteger(shadow.blur) && shadow.blur >= 1 && shadow.blur <= 10
    ? `${shadow.color.toLowerCase()}\u0000${shadow.blur}` : null, DIY_TEXT_SHADOW_LIMIT)
    .map((shadow) => ({ color: shadow.color, blur: shadow.blur }));
  return { bgColor: colors(source.bgColor), textColor: colors(source.textColor), textShadow };
}

function normalizeUniqueFlags(flags) {
  const result = [];
  const seen = new Set();
  const source = Array.isArray(flags) ? flags : [];
  for (let index = 0; index < source.length; index += 1) {
    const flag = source[index];
    if (!isPlainObject(flag) || typeof flag.type !== "string" || typeof flag.key !== "string"
      || FORBIDDEN_OBJECT_KEYS.has(flag.type) || FORBIDDEN_OBJECT_KEYS.has(flag.key)) continue;
    const key = `${flag.type}\u0000${flag.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type: flag.type, key: flag.key });
  }
  return result;
}

function ownedStyleFromUniqueFlags(flags) {
  const owned = freshStyleState().owned;
  const typeMap = { battleStyle: "battle", profileStyle: "profile", chatBubble: "chatBubble", avatarBorder: "avatarBorder" };
  for (const flag of normalizeUniqueFlags(flags)) {
    const category = typeMap[flag.type];
    const mappedKey = category === "battle" ? ({
      battleStyleWarrior: "warrior", battleStyleMagical: "magical",
      battleStyleCleric: "cleric", battleStyleNinja: "ninja"
    }[flag.key] ?? flag.key) : flag.key;
    if (!category || mappedKey === "diy" || !STYLE_CATALOGS[category].has(mappedKey)) continue;
    if (owned[category].length < STYLE_OWNED_LIMIT && !owned[category].includes(mappedKey)) owned[category].push(mappedKey);
  }
  return owned;
}

function normalizeStyleState(value, uniqueFlags = []) {
  const source = isPlainObject(value) ? value : {};
  const legacy = isPlainObject(source.selected) && isPlainObject(source.owned) ? null : source;
  const flagOwned = ownedStyleFromUniqueFlags(uniqueFlags);
  const owned = {};
  const selected = {};
  for (const [category, availableField, currentField] of STYLE_FIELDS) {
    const rawOwned = source.owned?.[category] ?? legacy?.[availableField] ?? [];
    owned[category] = uniqueCatalogStrings(rawOwned, STYLE_CATALOGS[category], STYLE_OWNED_LIMIT);
    for (const style of flagOwned[category]) {
      if (owned[category].length >= STYLE_OWNED_LIMIT) break;
      if (!owned[category].includes(style)) owned[category].push(style);
    }
    let rawSelected = source.selected?.[category] ?? legacy?.[currentField] ?? "";
    if (category === "battle") rawSelected = ({
      battleStyleWarrior: "warrior", battleStyleMagical: "magical",
      battleStyleCleric: "cleric", battleStyleNinja: "ninja"
    }[rawSelected] ?? rawSelected);
    selected[category] = typeof rawSelected === "string" && (rawSelected === "" || owned[category].includes(rawSelected)) ? rawSelected : "";
  }
  let diyChatBubbleStyle = normalizeDiyStyle(source.diyChatBubbleStyle ?? legacy?.diyChatBubbleStyle);
  if (!normalizeUniqueFlags(uniqueFlags).some((flag) => flag.type === DIY_FLAG.type && flag.key === DIY_FLAG.key)) {
    diyChatBubbleStyle = freshStyleState().diyChatBubbleStyle;
  }
  return {
    owned,
    selected,
    diyChatBubbleStyle,
    version: nonNegativeVersion(source.version ?? legacy?.version),
    updatedAt: validTimestamp(source.updatedAt ?? legacy?.updatedAt)
  };
}

function styleWireView(player) {
  const state = normalizeStyleState(player.style, player.uniqueFlag);
  const view = {};
  for (const [category, availableField, currentField] of STYLE_FIELDS) {
    view[availableField] = [...state.owned[category]];
    view[currentField] = state.selected[category];
  }
  view.diyChatBubbleStyle = structuredClone(state.diyChatBubbleStyle);
  view.version = state.version;
  view.updatedAt = state.updatedAt;
  return view;
}

function publicStyleView(player) {
  const state = normalizeStyleState(player.style, player.uniqueFlag);
  return Object.fromEntries(STYLE_FIELDS.map(([category, , currentField]) => [currentField, state.selected[category]]));
}

function publicProfileStyleView(player) {
  return publicStyleView(player);
}

function hasUniqueFlag(player, candidate) {
  return (Array.isArray(player.uniqueFlag) ? player.uniqueFlag : []).some((flag) => flag?.type === candidate?.type && flag?.key === candidate?.key);
}

function addUniqueFlagSet(player, candidate) {
  if (!candidate || typeof candidate.type !== "string" || typeof candidate.key !== "string" || hasUniqueFlag(player, candidate)) return false;
  const normalized = normalizeUniqueFlags(player.uniqueFlag);
  if (normalized.length >= UNIQUE_FLAG_LIMIT) return false;
  normalized.push({ type: candidate.type, key: candidate.key });
  player.uniqueFlag = normalized;
  return true;
}

function hasDiyStyleEntitlement(player) {
  return hasUniqueFlag(player, DIY_FLAG);
}

function cosmeticUsePlan(item) {
  const grants = [];
  const flags = [];
  const seenGrants = new Set();
  const seenFlags = new Set();
  for (const effect of Array.isArray(item?.onUse) ? item.onUse : []) {
    for (const [property, category] of [
      ["addBattleCustomStyle", "battle"], ["addProfileStyle", "profile"],
      ["addChatBubbleStyle", "chatBubble"], ["addAvatarBorder", "avatarBorder"]
    ]) {
      for (const key of Array.isArray(effect?.[property]) ? effect[property] : []) {
        if (typeof key !== "string" || !STYLE_CATALOGS[category].has(key)) continue;
        const grantKey = `${category}\u0000${key}`;
        if (!seenGrants.has(grantKey)) {
          seenGrants.add(grantKey);
          grants.push({ category, key });
        }
      }
    }
    for (const flag of Array.isArray(effect?.addUniqueFlag) ? effect.addUniqueFlag : []) {
      if (typeof flag?.type !== "string" || typeof flag?.key !== "string") continue;
      const flagKey = `${flag.type}\u0000${flag.key}`;
      if (!seenFlags.has(flagKey)) {
        seenFlags.add(flagKey);
        flags.push({ type: flag.type, key: flag.key });
      }
    }
  }
  // The bundled LuckyHorseCat2 resource has stale addAvatarBorder metadata that names Cat1.
  // Keep metadata authoritative everywhere else, but grant Cat2 for this exact resource ID.
  if (item?.id === LUCKY_HORSE_CAT_2_RESOURCE_ID && STYLE_CATALOGS.avatarBorder.has(LUCKY_HORSE_CAT_2_STYLE)) {
    for (let index = grants.length - 1; index >= 0; index -= 1) {
      if (grants[index].category === "avatarBorder") grants.splice(index, 1);
    }
    grants.push({ category: "avatarBorder", key: LUCKY_HORSE_CAT_2_STYLE });
  }
  return { grants, flags };
}
const statusExperienceThresholds = [
  0, 20, 45, 80, 125, 180, 245, 320, 405, 500, 605, 720, 845, 980, 1125, 1280, 1445, 1620, 1805, 2000,
  2205, 2420, 2645, 2880, 3125, 3380, 3645, 3920, 4205, 4500, 4805, 5760, 6825, 8000, 9285, 10680, 12185, 13800,
  15525, 17360, 19305, 21360, 23525, 25800, 28185, 30680, 33285, 36000, 38825, 41760, 44805,
  ...Array.from({ length: 50 }, (_, index) => Math.floor(44805 * Math.pow(1.18, index + 1))),
  ...Array.from({ length: 30 }, (_, index) => Math.floor(44805 * Math.pow(1.18, 50) * Math.pow(1.15, index + 1))),
  ...Array.from({ length: 20 }, (_, index) => Math.floor(44805 * Math.pow(1.18, 50) * Math.pow(1.15, 30) * Math.pow(1.12, index + 1)))
];
const statusKeys = ["attacking", "battle", "collecting", "cooking", "defencing", "dexterity", "enhance", "exploring", "farmingAnimal", "farmingPlant", "fishing", "forging", "intelligence", "knowledge", "luck", "manufacturing", "mining", "mysterious", "sewing", "stamina", "strength", "trading"];
// 生活属性中文名（技能给「生活经验」时弹提示用，名字取自参考站的属性表 Pa）
const LIFE_STATUS_LABELS = {
  collecting: "采集", cooking: "烹饪", enhance: "强化", exploring: "探索", farmingAnimal: "畜牧",
  farmingPlant: "种植", fishing: "钓鱼", forging: "锻造", knowledge: "学识",
  manufacturing: "制造", mining: "挖掘", mysterious: "神秘", sewing: "缝纫", trading: "交易"
};

// 参考站的等级经验是「当前等级内进度」：升到下一级需要 statusExperienceThresholds[level] 点，
// 升级时扣除该门槛并清零重算（实测：Lv.22 2536/2645 → 升到 Lv.23 后 currentExp 变为 0 起的进度）。
function normalizeStatus(status = {}) {
  const maxLevel = statusExperienceThresholds.length - 1;
  let level = Math.max(1, Math.min(maxLevel, Number(status.level) || 1));
  let exp = Math.max(0, Number(status.currentExp ?? status.exp) || 0);
  if (status.expMode !== "level") {
    // 早期版本把 currentExp 当作累计经验保存，这里一次性迁移为「等级内进度」
    level = 1;
    while (level < maxLevel && statusExperienceThresholds[level] <= exp) level += 1;
    if (level > 1) exp -= statusExperienceThresholds[level - 1];
  }
  while (level < maxLevel && exp >= statusExperienceThresholds[level]) {
    exp -= statusExperienceThresholds[level];
    level += 1;
  }
  // 战斗属性经验是小数（力量 0.28 / 耐力 0.09 等），累加会产生浮点尾巴，落盘前保留两位小数
  exp = Math.round(exp * 100) / 100;
  return { ...status, level, exp, currentExp: exp, final: level, expMode: "level" };
}

function getPlayerStatus(player) {
  return Object.fromEntries(statusKeys.map((key) => [key, normalizeStatus(player.status[key] || {})]));
}

function rankingLocalDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return rankingLocalDateKey(Date.now());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function weeklyRankingBucket(player, dateKey = rankingLocalDateKey()) {
  player.weeklyRanking ||= {};
  const bucket = player.weeklyRanking[dateKey];
  if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) return bucket;
  return (player.weeklyRanking[dateKey] = {});
}

function recordWeeklyRankingGain(player, category, amount) {
  const gain = Number(amount) || 0;
  if (!(gain > 0)) return;
  const bucket = weeklyRankingBucket(player);
  bucket[category] = Math.round(((Number(bucket[category]) || 0) + gain) * 100) / 100;
  if (category !== "goldEarned") bucket.total = Math.round(((Number(bucket.total) || 0) + gain) * 100) / 100;
  const keys = Object.keys(player.weeklyRanking).sort();
  while (keys.length > 42) delete player.weeklyRanking[keys.shift()];
}

function addStatusExp(player, key, amount) {
  const gain = Number(amount) || 0;
  if (!(gain > 0)) return normalizeStatus(player.status[key] || {});
  const base = normalizeStatus(player.status[key] || {});
  const next = normalizeStatus({ ...base, currentExp: base.currentExp + gain, exp: base.currentExp + gain });
  player.status[key] = next;
  recordWeeklyRankingGain(player, key, gain);
  return next;
}
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
const configuredEmail = process.env.MAOMAO_EMAIL || "demo@example.com";
const configuredPassword = process.env.MAOMAO_PASSWORD || "change-me";
const gmPassword = process.env.MAOMAO_GM_PASSWORD || "";
const accountFile = path.resolve(process.env.MAOMAO_ACCOUNT_FILE || path.join(__dirname, "data", "accounts.json"));
const playerDataFile = path.resolve(process.env.MAOMAO_PLAYER_FILE || path.join(__dirname, "data", "players.json"));
const marketDataFile = path.resolve(process.env.MAOMAO_MARKET_FILE || path.join(__dirname, "data", "market.json"));
const socialDataFile = path.resolve(process.env.MAOMAO_SOCIAL_FILE || path.join(path.dirname(playerDataFile), "social.json"));
// 全镇公共状态（公共建筑、家政维护费、捐助幂等记录）。镇级状态不能复制到每个角色存档。
const villageDataFile = path.resolve(process.env.MAOMAO_VILLAGE_FILE || path.join(path.dirname(playerDataFile), "village.json"));
const homeServiceWalFile = path.resolve(process.env.MAOMAO_HOME_SERVICE_WAL_FILE || path.join(path.dirname(playerDataFile), "home-service-transaction.json"));
const auctionDataFile = path.resolve(process.env.MAOMAO_AUCTION_FILE || path.join(path.dirname(playerDataFile), "auctions.json"));
const shopDataFile = path.resolve(process.env.MAOMAO_SHOP_FILE || path.join(path.dirname(playerDataFile), "shops.json"));
const HOME_SERVICE_CYCLE_DAYS = Math.max(1, Math.min(365, Math.floor(Number(process.env.MAOMAO_HOME_SERVICE_CYCLE_DAYS) || 7)));
const HOME_SERVICE_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const villageState = {
  version: 2,
  buildings: [],
  homeService: { paidUntil: null, cycleDays: HOME_SERVICE_CYCLE_DAYS, fundsGold: 0, fundingFeeGold: 0, fundingLevel: 0 },
  donations: {},
  buildingDonations: [],
  buildingRequests: {},
  phaseSequence: 0
};
// 战斗房间落盘：房间和当前这一场的战斗数据都只在内存里跑，不落盘的话每次重启（发布）都会
// 把玩家挂着机的房间全部清空，回来就成了「战斗没了」。
const battleRoomFile = path.resolve(process.env.MAOMAO_ROOM_FILE || path.join(path.dirname(playerDataFile), "rooms.json"));
// 自定义头像落地目录：跟 players.json 放一起，部署时随 data 目录一起迁移
const avatarDir = path.join(path.dirname(playerDataFile), "avatars");
const localRecoveryEnabled = process.env.MAOMAO_LOCAL_RECOVERY !== "false";
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const gmSessions = new Map();
const gmLoginAttempts = new Map();
const players = new Map();
const taskRunners = new Map();
const accounts = new Map();
const battleRooms = new Map();
const battleTimers = new Map();
const marketTrades = new Map();
const socialState = {
  version: 1,
  friendRequests: [],
  friendships: [],
  chatMessages: [],
  blocks: {},
  guilds: [],
  guildJoinRequests: []
};
// 拍卖行：每条记录含委托物品、起价、结束时间与出价历史。物品在创建时从背包扣走（托管），
// 流拍/取消时退回，成交时转给买家；金币出价时先扣款，被超越时退回上一名出价者。
const auctionState = {
  version: 1,
  auctions: []
};
// 玩家商店：挂单引用卖家实时库存，并按保留数量动态计算可售量；成交时从卖家库存扣货，
// 买家以猫爪古钱币付款。店铺置顶和货架扩展许可证在使用时消耗。
const shopState = {
  version: 2,
  shops: [],
  purchases: [],
  pins: {},
  pinCooldowns: {}
};
const PLAYER_SHOP_MAX_SHOPS = 1;
const PLAYER_SHOP_CURRENCY_ID = "catPawCoin";
const PLAYER_SHOP_BASE_ITEMS = 3;
const PLAYER_SHOP_MAX_EXTRA_ITEMS = 20;
const PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES = 5;
const PLAYER_SHOP_SCHEME_IDS = ["default", "fast"];
const PLAYER_SHOP_MAX_GLOBAL_PINS = 6;
const PLAYER_SHOP_PIN_MS = 24 * 60 * 60 * 1000;
const PLAYER_SHOP_PIN_COOLDOWN_MS = 48 * 60 * 60 * 1000;
const PLAYER_SHOP_DAYS = 7;
const marketConfig = {
  maxSellerTransactions: 5,
  maxBuyerTransactions: 5,
  sellerSchemes: ["schemeA"],
  buyerSchemes: ["schemeA"]
};
let persistTimer = null;
let persistInProgress = false;
let persistRequested = false;
const phaseOneMutationTails = new Map();
const phaseOneTestHooksEnabled = process.env.NODE_ENV === "test" && process.env.MAOMAO_TEST_HOOKS === "1";
let injectedPlayerPersistenceFailures = 0;
let testFullFlushFrozen = false;
let testPhaseOneRetriesPending = 0;
let testPhaseOneRetryReady = false;
const testPersistenceCounters = {
  fullFlushStarted: 0,
  fullFlushCompleted: 0,
  phaseOnePersistCalls: 0,
  phaseOnePendingBranchStarted: 0,
  phaseOnePendingBranchCompleted: 0,
  phaseOnePendingBranchFailed: 0,
  phaseOneRetryScheduled: 0,
  phaseOneRetryStarted: 0,
  phaseOneRetryCompleted: 0
};

function pendingFullFlushForTest() {
  return Boolean(persistTimer) || persistRequested;
}

function persistenceTestState() {
  return {
    frozen: testFullFlushFrozen,
    pendingFullFlush: pendingFullFlushForTest(),
    persistTimer: Boolean(persistTimer),
    persistInProgress,
    persistRequested,
    retriesPending: testPhaseOneRetriesPending,
    counters: { ...testPersistenceCounters }
  };
}

function sendTestIpc(type, requestId, extra = {}) {
  if (typeof process.send === "function") process.send({ type, requestId, ...extra });
}

function fullFlushIdleForTest() {
  return !pendingFullFlushForTest() && !persistInProgress && testPhaseOneRetriesPending === 0;
}

function waitForFullFlushIdleForTest(requestId) {
  if (fullFlushIdleForTest()) {
    sendTestIpc("maomao:test:full-flush-idle:result", requestId, persistenceTestState());
    return;
  }
  setImmediate(() => waitForFullFlushIdleForTest(requestId));
}

function waitForPhaseOneIdleForTest(uuid, requestId) {
  const tail = phaseOneMutationTails.get(uuid);
  if (!tail) {
    sendTestIpc("maomao:test:phase-one-idle:result", requestId, { uuid });
    return;
  }
  tail.catch(() => {}).then(() => {
    if (phaseOneMutationTails.has(uuid)) waitForPhaseOneIdleForTest(uuid, requestId);
    else sendTestIpc("maomao:test:phase-one-idle:result", requestId, { uuid });
  });
}

if (phaseOneTestHooksEnabled) {
  process.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "maomao:test:fail-player-persistence") {
      const count = Math.max(1, Math.min(100, Math.floor(Number(message.count) || 1)));
      injectedPlayerPersistenceFailures += count;
      sendTestIpc("maomao:test:fail-player-persistence:armed", message.requestId, { remaining: injectedPlayerPersistenceFailures });
      return;
    }
    if (message.type === "maomao:test:persistence-control") {
      if (typeof message.frozen === "boolean") testFullFlushFrozen = message.frozen;
      if (message.resetCounters) {
        if (testPhaseOneRetriesPending !== 0) throw new Error("cannot reset persistence counters with retry pending");
        testPhaseOneRetryReady = false;
        for (const key of Object.keys(testPersistenceCounters)) testPersistenceCounters[key] = 0;
      }
      if (!testFullFlushFrozen && pendingFullFlushForTest() && !persistInProgress) {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        if (testPhaseOneRetriesPending > 0 && !testPhaseOneRetryReady) {
          testPersistenceCounters.phaseOneRetryStarted += 1;
          testPhaseOneRetryReady = true;
        }
        persistRequested = false;
        schedulePersist();
      }
      sendTestIpc("maomao:test:persistence-control:result", message.requestId, persistenceTestState());
      return;
    }
    if (message.type === "maomao:test:persistence-state") {
      sendTestIpc("maomao:test:persistence-state:result", message.requestId, persistenceTestState());
      return;
    }
    if (message.type === "maomao:test:await-full-flush-idle") {
      waitForFullFlushIdleForTest(message.requestId);
      return;
    }
    if (message.type === "maomao:test:await-phase-one-idle") {
      waitForPhaseOneIdleForTest(String(message.uuid || ""), message.requestId);
      return;
    }
    if (message.type !== "maomao:test:player-snapshot") return;
    const player = players.get(message.uuid);
    if (player && isPlainObject(message.patch)) {
      for (const key of ["inventory", "personalization", "style", "uniqueFlag", "ironcat", "isIronCat"]) {
        if (Object.hasOwn(message.patch, key)) player[key] = structuredClone(message.patch[key]);
      }
    }
    sendTestIpc("maomao:test:player-snapshot:result", message.requestId, { player: player ? playerPersistenceView(player) : null });
  });
}

function injectPlayerPersistenceFailureForTest() {
  if (!phaseOneTestHooksEnabled || injectedPlayerPersistenceFailures <= 0) return;
  injectedPlayerPersistenceFailures -= 1;
  const error = new Error("injected players.json persistence failure");
  error.code = "MAOMAO_TEST_INJECTED_PLAYER_PERSISTENCE_FAILURE";
  throw error;
}

function writePlayersJsonNow({ injectFailure = false } = {}) {
  fs.mkdirSync(path.dirname(playerDataFile), { recursive: true });
  if (injectFailure) injectPlayerPersistenceFailureForTest();
  writeJsonAtomic(playerDataFile, [...players.values()].map(playerPersistenceView));
}

function serializePhaseOneMutation(uuid, operation) {
  const previous = phaseOneMutationTails.get(uuid) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  phaseOneMutationTails.set(uuid, current);
  current.finally(() => {
    if (phaseOneMutationTails.get(uuid) === current) phaseOneMutationTails.delete(uuid);
  }).catch(() => {});
  return current;
}

fs.mkdirSync(path.dirname(accountFile), { recursive: true });
if (fs.existsSync(accountFile)) {
  const savedAccounts = JSON.parse(fs.readFileSync(accountFile, "utf8"));
  for (const account of savedAccounts) {
    accounts.set(account.email, account);
    players.set(account.uuid, makePlayer(account.email, account.name, account.uuid, account.createdAt));
  }
}

const app = express();
const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"]
});

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function publicSocialProfile(player) {
  return {
    uuid: player.uuid,
    name: player.name,
    avatar: player.avatar,
    title: player.title ?? null,
    ironcat: player.ironcat === true || player.isIronCat === true,
    isIronCat: player.ironcat === true || player.isIronCat === true,
    style: publicProfileStyleView(player)
  };
}

function publicUser(player) {
  return {
    uuid: player.uuid,
    email: player.email,
    name: player.name,
    avatar: player.avatar,
    isIronCat: false,
    isVisitor: false
  };
}

// 玩家公开资料（组队/好友/战利品面板里的头像+名字都靠这个视图）。
// 前端 AvatarAndName 会校验 `data.uuid === 传入的 uuid` 才写缓存，所以这里必须返回「被查询的人」，不能返回自己。
function publicProfileView(player, viewerUuid) {
  const isSelf = player.uuid === viewerUuid;
  return {
    uuid: player.uuid,
    name: player.name,
    avatar: player.avatar,
    title: player.title ?? null,
    // 前端读的是小写 ironcat（`a.value.ironcat`），isIronCat 只给旧字段兼容
    ironcat: false,
    isIronCat: false,
    isVisitor: false,
    style: publicProfileStyleView(player),
    // 邮箱只给本人看，别人的资料里不出现
    ...(isSelf ? { email: player.email } : {})
  };
}

function profileMapPayload(uuidList, viewerUuid) {
  const result = {};
  for (const raw of uuidList) {
    const uuid = typeof raw === "string" ? raw.trim() : "";
    const target = uuid && players.get(uuid);
    if (target) result[target.uuid] = publicProfileView(target, viewerUuid);
  }
  return result;
}

function getPlayer(req) {
  const token = parseCookies(req.headers.cookie).maomao_session;
  const session = token && sessions.get(token);
  return session ? players.get(session.uuid) || null : getLocalRecoveryPlayer();
}

function getLocalRecoveryPlayer() {
  if (!localRecoveryEnabled || accounts.size === 0) return null;
  const configuredAccount = accounts.get(configuredEmail.trim().toLowerCase());
  const account = configuredAccount || [...accounts.values()][0];
  return players.get(account.uuid) || null;
}

function requirePlayer(req, res, next) {
  const player = getPlayer(req);
  if (!player) return res.status(401).json({ code: 401, msg: "未登录" });
  req.player = player;
  next();
}

function requireGM(req, res, next) {
  const token = parseCookies(req.headers.cookie).maomao_gm_session;
  const session = token && gmSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) gmSessions.delete(token);
    return res.status(401).json({ code: 401, message: "需要管理员登录" });
  }
  session.lastSeenAt = Date.now();
  req.gmSession = session;
  next();
}

function safePlayerSummary(player) {
  return {
    uuid: player.uuid,
    email: player.email,
    name: player.name,
    createdAt: player.createdAt,
    resources: player.resources,
    // 金币单独计入 resources，这里只统计背包里的实物，避免列表里「物品 1,400」这种误导
    inventoryCount: Object.entries(player.inventory || {}).reduce((sum, [resourceId, item]) => (resourceId === "gold" ? sum : sum + (Number(item?.count) || 0)), 0),
    taskCount: player.taskQueue?.length || 0,
    currentBattleRoomId: player.currentBattleRoomId || null
  };
}

function makePlayer(email, name, existingUuid, createdAt) {
  const uuid = existingUuid || crypto.randomUUID();
  const player = {
    uuid,
    email,
    name: name || email.split("@")[0] || "猫猫",
    avatar: "avatar_1.png",
    title: null,
    // 角色设置里的开关（隐藏公会头衔、关闭登录邮箱验证等），由 character:updateProfile 写入
    option: {},
    resources: { gold: 1000, food: 100 },
    // 赞助积分不是背包道具：current 为可用余额，max 为历史累计余额。
    sponsorPoint: { current: 0, max: 0 },
    inventory: { __satiety: { count: 0 }, catPawCoin: { count: 100 } },
    status: {},
    workEquipment: {},
    battleEquipment: {},
    // 自建建筑状态：{ [buildingId]: { status:"BUILT", level, builtAt } }，前端只认 status === "BUILT"
    building: {},
    uniqueFlag: [],
    personalization: freshPersonalization(),
    style: freshStyleState(),
    taskQueue: [],
    kitty: [],
    marketProfile: { extraSeller: 0, extraBuyer: 0 },
    currentBattleRoomId: null,
    battleInfo: null,
    quests: [],
    questSeq: 0,
    questWindow: 0,
    farmPlots: [],
    // 自动收获、战利品等待领取物品：[{ id,title,createdAt,claimed,items:[{id,resourceId,amount,claimed}] }]
    harvestBoxes: [],
    // 技能配置（技能页 characterBattleSkill）：数组形态，见 playerSkills 的注释。
    // baseAttack 是出生自带的普通攻击，恒存在且不可禁用。
    skillList: [{ skillId: "baseAttack", level: 1, exp: 0, enabled: true, order: 0, logic: [] }],
    // 技能配置方案：{ uuid, name, data:[技能…], createdAt, updatedAt }
    skillOutfits: [],
    // 装备配装方案（工作/战斗套装）
    outfits: [],
    // 厨师技能风味/目标配置：{ flavors:[{key,count}], targets:[{key,count}] }
    chefSkill: { flavors: [], targets: [] },
    // 战斗播报偏好：{ battle: boolean }
    msgPref: { battle: false },
    // 战斗物品袋：{ [resourceId]: { remainingCount, prepareCount, ai, order, useWhen } }
    battleInventory: {},
    // 周榜只累计接入后的真实增量；键为本地自然日 YYYY-MM-DD，旧存档缺失时保持空。
    weeklyRanking: {},
    createdAt: createdAt || new Date().toISOString()
  };
  setGoldCount(player, 1000);
  players.set(uuid, player);
  return player;
}

function writeJsonAtomic(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

function playerPersistenceView(player) {
  return {
    uuid: player.uuid,
    email: player.email,
    name: player.name,
    avatar: player.avatar,
    title: player.title,
    option: player.option || {},
    resources: player.resources,
    sponsorPoint: player.sponsorPoint && typeof player.sponsorPoint === "object"
      ? player.sponsorPoint
      : { current: 0, max: 0 },
    inventory: player.inventory,
    status: player.status,
    workEquipment: player.workEquipment,
    battleEquipment: player.battleEquipment,
    building: player.building || {},
    uniqueFlag: normalizeUniqueFlags(player.uniqueFlag),
    personalization: normalizePersonalizationState(player.personalization),
    style: normalizeStyleState(player.style, player.uniqueFlag),
    taskQueue: player.taskQueue,
    kitty: player.kitty,
    marketProfile: player.marketProfile,
    quests: Array.isArray(player.quests) ? player.quests : [],
    questSeq: Number(player.questSeq) || 0,
    questWindow: Number(player.questWindow) || 0,
    farmPlots: Array.isArray(player.farmPlots) ? player.farmPlots : [],
    harvestBoxes: Array.isArray(player.harvestBoxes) ? player.harvestBoxes : [],
    // 技能配置（数组）。老存档里没有这两个字段，读档时由 playerSkills 兜底成只有 baseAttack
    skillList: Array.isArray(player.skillList) ? player.skillList : [],
    skillOutfits: Array.isArray(player.skillOutfits) ? player.skillOutfits : [],
    // 装备配装方案：[{ uuid, name, type:"work"|"battle", equipment, actionIdList, createdAt, updatedAt }]
    outfits: Array.isArray(player.outfits) ? player.outfits : [],
    chefSkill: player.chefSkill && typeof player.chefSkill === "object" && !Array.isArray(player.chefSkill) ? player.chefSkill : { flavors: [], targets: [] },
    msgPref: player.msgPref && typeof player.msgPref === "object" && !Array.isArray(player.msgPref) ? player.msgPref : { battle: false },
    battleInventory: player.battleInventory && typeof player.battleInventory === "object" && !Array.isArray(player.battleInventory) ? player.battleInventory : {},
    // 专精（技能树）点数分配：{ battle: { nodeId: level }, life: {...} }
    skillTree: player.skillTree && typeof player.skillTree === "object" && !Array.isArray(player.skillTree) ? player.skillTree : {},
    skillTreeBonus: player.skillTreeBonus && typeof player.skillTreeBonus === "object" ? player.skillTreeBonus : {},
    weeklyRanking: player.weeklyRanking && typeof player.weeklyRanking === "object" && !Array.isArray(player.weeklyRanking) ? player.weeklyRanking : {},
    createdAt: player.createdAt
  };
}

function marketPersistenceView(trade) {
  return { ...trade };
}

function socialPersistenceView() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    friendRequests: socialState.friendRequests,
    friendships: socialState.friendships,
    chatMessages: socialState.chatMessages,
    blocks: socialState.blocks,
    guilds: socialState.guilds,
    guildJoinRequests: socialState.guildJoinRequests
  };
}

function auctionPersistenceView() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    auctions: auctionState.auctions
  };
}

function shopPersistenceView() {
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    shops: shopState.shops,
    purchases: shopState.purchases,
    pins: shopState.pins,
    pinCooldowns: shopState.pinCooldowns
  };
}

function villagePersistenceView() {
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    buildings: villageState.buildings,
    homeService: villageState.homeService,
    donations: villageState.donations,
    buildingDonations: villageState.buildingDonations,
    buildingRequests: villageState.buildingRequests,
    phaseSequence: villageState.phaseSequence
  };
}

function replayPreparedVillageTransaction(wal) {
  if (wal?.status !== "prepared" || !Array.isArray(wal.players) || !wal.village || typeof wal.village !== "object") {
    throw new Error("invalid prepared village transaction");
  }
  for (const saved of wal.players) {
    const player = players.get(saved?.uuid);
    if (player) Object.assign(player, structuredClone(saved));
  }
  villageState.buildings = Array.isArray(wal.village.buildings) ? structuredClone(wal.village.buildings) : villageState.buildings;
  villageState.homeService = wal.village.homeService && typeof wal.village.homeService === "object"
    ? structuredClone(wal.village.homeService)
    : villageState.homeService;
  villageState.donations = wal.village.donations && typeof wal.village.donations === "object"
    ? structuredClone(wal.village.donations)
    : villageState.donations;
  villageState.buildingDonations = Array.isArray(wal.village.buildingDonations)
    ? structuredClone(wal.village.buildingDonations)
    : villageState.buildingDonations;
  villageState.buildingRequests = wal.village.buildingRequests && typeof wal.village.buildingRequests === "object"
    ? structuredClone(wal.village.buildingRequests)
    : villageState.buildingRequests;
  villageState.phaseSequence = Math.max(0, Math.floor(Number(wal.village.phaseSequence) || 0));
  fs.mkdirSync(path.dirname(playerDataFile), { recursive: true });
  writeJsonAtomic(playerDataFile, wal.players);
  writeJsonAtomic(villageDataFile, wal.village);
  fs.rmSync(homeServiceWalFile, { force: true });
}

// Guild constants must be initialized before loadPersistentState() runs, which normalizes
// persisted guilds and reads GUILD_ROLES/GUILD_TYPES during startup.
const GUILD_ROLES = new Set(["MEMBER", "OFFICER", "LEADER"]);
const GUILD_TYPES = new Set(["life", "idle", "battle"]);
const GUILD_CREATE_COST = Object.freeze([
  { id: "gold", count: 1_000_000 },
  { id: "wood", count: 10_000 },
  { id: "stone", count: 8_000 },
  { id: "iron", count: 2_000 },
  { id: "steel", count: 1_000 },
  { id: "sand", count: 1_000 }
]);

// 单个存档文件损坏（截断、被编辑器写入 BOM、手工改错）不应让其它模块的数据一起丢失：
// 这里逐文件容错读取，解析失败只跳过该文件并告警，其余状态继续加载。
function readJsonFileSafe(file, label) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch (error) {
    console.error(`[persist] 跳过无法解析的 ${label || path.basename(file)}:`, error.message);
    return undefined;
  }
}

function loadPersistentState() {
  let phaseOneMigrationNeeded = false;
  try {
    if (fs.existsSync(playerDataFile)) {
      const savedPlayers = readJsonFileSafe(playerDataFile, "players.json");
      for (const saved of Array.isArray(savedPlayers) ? savedPlayers : []) {
        const player = players.get(saved.uuid);
        if (!player) continue;
        if (!isPlainObject(saved.personalization) || !isPlainObject(saved.style)
          || ["favoriteItems", "categoryOrder", "personalizationVersion", "personalizationUpdatedAt", "userStyle", "customStyle", "userPersonalization"].some((key) => Object.hasOwn(saved, key))) {
          phaseOneMigrationNeeded = true;
        }
        const legacyStyle = saved.style ?? saved.userStyle ?? saved.customStyle;
        const legacyPersonalization = saved.personalization ?? saved.userPersonalization ?? {
          favoriteItems: saved.favoriteItems,
          categoryOrder: saved.categoryOrder,
          version: saved.personalizationVersion,
          updatedAt: saved.personalizationUpdatedAt
        };
        Object.assign(player, {
          name: typeof saved.name === "string" && saved.name.trim() ? saved.name.trim().slice(0, 24) : player.name,
          avatar: saved.avatar || player.avatar,
          title: saved.title ?? player.title,
          option: saved.option && typeof saved.option === "object" && !Array.isArray(saved.option) ? saved.option : player.option,
          resources: saved.resources && typeof saved.resources === "object" ? saved.resources : player.resources,
          sponsorPoint: saved.sponsorPoint && typeof saved.sponsorPoint === "object" && !Array.isArray(saved.sponsorPoint)
            ? {
                current: Math.max(0, Number(saved.sponsorPoint.current) || 0),
                max: Math.max(0, Number(saved.sponsorPoint.max) || 0)
              }
            : player.sponsorPoint,
          inventory: saved.inventory && typeof saved.inventory === "object" ? saved.inventory : player.inventory,
          status: saved.status && typeof saved.status === "object" ? saved.status : player.status,
          workEquipment: saved.workEquipment && typeof saved.workEquipment === "object" ? saved.workEquipment : player.workEquipment,
          battleEquipment: saved.battleEquipment && typeof saved.battleEquipment === "object" ? saved.battleEquipment : player.battleEquipment,
          building: saved.building && typeof saved.building === "object" && !Array.isArray(saved.building) ? saved.building : player.building,
          uniqueFlag: normalizeUniqueFlags(Array.isArray(saved.uniqueFlag) ? saved.uniqueFlag : player.uniqueFlag),
          personalization: normalizePersonalizationState(legacyPersonalization),
          style: normalizeStyleState(legacyStyle, Array.isArray(saved.uniqueFlag) ? saved.uniqueFlag : player.uniqueFlag),
          taskQueue: Array.isArray(saved.taskQueue) ? saved.taskQueue : player.taskQueue,
          kitty: Array.isArray(saved.kitty) ? saved.kitty : player.kitty,
          marketProfile: saved.marketProfile && typeof saved.marketProfile === "object" ? saved.marketProfile : player.marketProfile,
          quests: Array.isArray(saved.quests) ? saved.quests : player.quests,
          questSeq: Number.isFinite(Number(saved.questSeq)) ? Number(saved.questSeq) : player.questSeq,
          questWindow: Number.isFinite(Number(saved.questWindow)) ? Number(saved.questWindow) : player.questWindow,
          farmPlots: Array.isArray(saved.farmPlots) ? saved.farmPlots : player.farmPlots,
          harvestBoxes: Array.isArray(saved.harvestBoxes) ? saved.harvestBoxes : player.harvestBoxes,
          skillList: Array.isArray(saved.skillList) && saved.skillList.length ? saved.skillList : player.skillList,
          skillOutfits: Array.isArray(saved.skillOutfits) ? saved.skillOutfits : player.skillOutfits,
          outfits: Array.isArray(saved.outfits) ? saved.outfits : player.outfits,
          chefSkill: saved.chefSkill && typeof saved.chefSkill === "object" && !Array.isArray(saved.chefSkill) ? saved.chefSkill : player.chefSkill,
          msgPref: saved.msgPref && typeof saved.msgPref === "object" && !Array.isArray(saved.msgPref) ? saved.msgPref : player.msgPref,
          battleInventory: saved.battleInventory && typeof saved.battleInventory === "object" && !Array.isArray(saved.battleInventory) ? saved.battleInventory : player.battleInventory,
          skillTree: saved.skillTree && typeof saved.skillTree === "object" && !Array.isArray(saved.skillTree) ? saved.skillTree : player.skillTree,
          skillTreeBonus: saved.skillTreeBonus && typeof saved.skillTreeBonus === "object" && !Array.isArray(saved.skillTreeBonus) ? saved.skillTreeBonus : player.skillTreeBonus,
          weeklyRanking: saved.weeklyRanking && typeof saved.weeklyRanking === "object" && !Array.isArray(saved.weeklyRanking) ? saved.weeklyRanking : player.weeklyRanking
        });
        if (player.inventory?.gold?.count === undefined) setGoldCount(player, player.resources?.gold || 0);
        // 老存档可能残留「资源不足自动暂停」的任务：饱食度这条已改成直接结束，
        // 先把自动暂停解开，交给 runTaskQueue 按新规则处理（材料不足的会再暂停一次，无副作用）
        for (const task of player.taskQueue) {
          if (task?.pauseReason !== "insufficient_resource") continue;
          task.paused = false;
          task.pauseReason = null;
        }
      }
    }
    if (fs.existsSync(marketDataFile)) {
      const savedTrades = readJsonFileSafe(marketDataFile, "market.json");
      for (const saved of Array.isArray(savedTrades) ? savedTrades : []) {
        if (!saved?.tradeUuid || !players.has(saved.ownerUuid)) continue;
        marketTrades.set(saved.tradeUuid, saved);
      }
    }
    if (fs.existsSync(socialDataFile)) {
      const savedSocial = readJsonFileSafe(socialDataFile, "social.json");
      socialState.friendRequests = Array.isArray(savedSocial?.friendRequests) ? savedSocial.friendRequests.filter((entry) => entry && players.has(entry.fromUserUuid) && players.has(entry.toUserUuid)) : [];
      socialState.friendships = Array.isArray(savedSocial?.friendships) ? savedSocial.friendships.filter((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((uuid) => players.has(uuid))) : [];
      socialState.chatMessages = Array.isArray(savedSocial?.chatMessages) ? savedSocial.chatMessages.filter((entry) => entry && players.has(entry.sender) && typeof entry.created_At === "string").slice(-5000) : [];
      socialState.blocks = {};
      for (const [uuid, blocked] of Object.entries(savedSocial?.blocks || {})) {
        if (players.has(uuid)) socialState.blocks[uuid] = [...new Set((Array.isArray(blocked) ? blocked : []).filter((target) => players.has(target) && target !== uuid))];
      }
      socialState.guilds = (Array.isArray(savedSocial?.guilds) ? savedSocial.guilds : []).filter((entry) => entry?.uuid && typeof entry.name === "string").map((entry) => {
        const owner = players.has(entry.owner) ? entry.owner : null;
        const seen = new Set();
        const members = (Array.isArray(entry.members) ? entry.members : []).filter((member) => member && players.has(member.uuid) && !seen.has(member.uuid) && seen.add(member.uuid)).map((member) => ({
          uuid: member.uuid,
          role: GUILD_ROLES.has(member.role) ? member.role : "MEMBER",
          titleUuid: typeof member.titleUuid === "string" ? member.titleUuid : null,
          joinedAt: typeof member.joinedAt === "string" ? member.joinedAt : new Date().toISOString()
        }));
        if (owner && !members.some((member) => member.uuid === owner)) members.push({ uuid: owner, role: "LEADER", titleUuid: null, joinedAt: entry.createdAt || new Date().toISOString() });
        const leader = members.find((member) => member.uuid === owner) || members.find((member) => member.role === "LEADER") || members[0];
        if (!leader) return null;
        members.forEach((member) => { member.role = member.uuid === leader.uuid ? "LEADER" : member.role === "LEADER" ? "MEMBER" : member.role; });
        const titles = (Array.isArray(entry.titles) ? entry.titles : []).filter((title) => title?.uuid && typeof title.title === "string" && GUILD_ROLES.has(title.role)).map((title) => ({ uuid: title.uuid, title: title.title, role: title.role, description: typeof title.description === "string" ? title.description : "" }));
        const titleIds = new Set(titles.map((title) => title.uuid));
        members.forEach((member) => { if (!titleIds.has(member.titleUuid)) member.titleUuid = null; });
        return { ...entry, owner: leader.uuid, members, titles, type: normalizeGuildTypes(entry.type) || [], description: typeof entry.description === "string" ? entry.description : "" };
      }).filter(Boolean);
      // One player may belong to only one guild; retain the oldest record deterministically.
      const claimedGuildMembers = new Set();
      socialState.guilds.sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.uuid.localeCompare(right.uuid));
      for (const guild of socialState.guilds) guild.members = guild.members.filter((member) => !claimedGuildMembers.has(member.uuid) && claimedGuildMembers.add(member.uuid));
      socialState.guilds = socialState.guilds.filter((guild) => guild.members.length && guild.members.some((member) => member.uuid === guild.owner));
      socialState.guildJoinRequests = (Array.isArray(savedSocial?.guildJoinRequests) ? savedSocial.guildJoinRequests : []).filter((entry) => entry?.id && players.has(entry.userUuid) && socialState.guilds.some((guild) => guild.uuid === entry.guildUuid));
    }
    if (fs.existsSync(auctionDataFile)) {
      const savedAuction = readJsonFileSafe(auctionDataFile, "auctions.json");
      auctionState.auctions = (Array.isArray(savedAuction?.auctions) ? savedAuction.auctions : [])
        .filter((entry) => entry?.uuid && players.has(entry.creator))
        .map((entry) => {
          const targetType = String(entry.targetType || "").toUpperCase();
          const stateMap = { SOLD: "SETTLED", EXPIRED: "ENDED" };
          return {
            ...entry,
            targetType: ["ITEM", "TITLE", "TEXT"].includes(targetType) ? targetType : "ITEM",
            state: stateMap[entry.state] || entry.state || "OPEN",
            bids: (Array.isArray(entry.bids) ? entry.bids : []).filter((bid) => bid?.bidder && players.has(bid.bidder))
          };
        });
    }
    if (fs.existsSync(shopDataFile)) {
      const savedShop = readJsonFileSafe(shopDataFile, "shops.json");
      shopState.shops = (Array.isArray(savedShop?.shops) ? savedShop.shops : [])
        .filter((entry) => entry?.uuid && players.has(entry.owner))
        .map((entry) => {
          const extraItemSlots = Math.max(0, Math.min(PLAYER_SHOP_MAX_EXTRA_ITEMS, Math.floor(Number(entry.extraItemSlots) || 0)));
          const savedUsage = entry.schemeUsage && typeof entry.schemeUsage === "object" && !Array.isArray(entry.schemeUsage)
            ? entry.schemeUsage
            : null;
          // Legacy saves only recorded a total expansion count. Attribute the first five uses to
          // the resource scheme and the remainder to the permit scheme so no free uses reappear.
          const defaultUsage = Math.max(0, Math.min(PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES,
            Math.floor(Number(savedUsage?.default) || (savedUsage ? 0 : Math.min(extraItemSlots, PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES)))));
          const fastUsage = Math.max(0, Math.floor(Number(savedUsage?.fast) || (savedUsage ? 0 : Math.max(0, extraItemSlots - defaultUsage))));
          return {
            ...entry,
            extraItemSlots,
            schemeUsage: { default: defaultUsage, fast: fastUsage },
            items: (Array.isArray(entry.items) ? entry.items : [])
              .filter((item) => item?.uuid && item.resourceId)
              .map((item) => {
                const inventoryRemainingCount = Math.max(0, Math.floor(Number(item.inventoryRemainingCount) || 0));
                // Old escrow-era rows stored a frozen remaining count. Do not recreate escrow or
                // infer historical sales from it; future availability is always seller live stock.
                return { ...item, inventoryRemainingCount, soldCount: Math.max(0, Math.floor(Number(item.soldCount) || 0)) };
              })
          };
        });
      shopState.purchases = (Array.isArray(savedShop?.purchases) ? savedShop.purchases : [])
        .filter((entry) => entry?.uuid && players.has(entry.buyerUuid))
        .slice(-2000);
      const now = Date.now();
      shopState.pins = {};
      for (const [shopUuid, expiresAt] of Object.entries(savedShop?.pins || {})) {
        if (shopState.shops.some((shop) => shop.uuid === shopUuid) && Number(expiresAt) > now) shopState.pins[shopUuid] = Number(expiresAt);
      }
      shopState.pinCooldowns = {};
      for (const [playerUuid, expiresAt] of Object.entries(savedShop?.pinCooldowns || {})) {
        if (players.has(playerUuid) && Number(expiresAt) > now) shopState.pinCooldowns[playerUuid] = Number(expiresAt);
      }
    }
    if (fs.existsSync(villageDataFile)) {
      const savedVillage = readJsonFileSafe(villageDataFile, "village.json");
      villageState.buildings = Array.isArray(savedVillage?.buildings) ? savedVillage.buildings.filter((entry) => entry && typeof entry === "object") : [];
      const savedService = savedVillage?.homeService && typeof savedVillage.homeService === "object" ? savedVillage.homeService : {};
      villageState.homeService = {
        paidUntil: typeof savedService.paidUntil === "string" ? savedService.paidUntil : null,
        cycleDays: Math.max(1, Math.min(365, Math.floor(Number(savedService.cycleDays) || HOME_SERVICE_CYCLE_DAYS))),
        fundsGold: Math.max(0, Math.floor(Number(savedService.fundsGold) || 0)),
        fundingFeeGold: Math.max(0, Math.floor(Number(savedService.fundingFeeGold) || 0)),
        fundingLevel: Math.max(0, Math.floor(Number(savedService.fundingLevel) || 0))
      };
      villageState.donations = {};
      for (const [key, record] of Object.entries(savedVillage?.donations || {})) {
        if (!record || record.status !== "committed" || !Number.isSafeInteger(Number(record.count)) || Number(record.count) < 1) continue;
        villageState.donations[key] = record;
      }
      villageState.buildingDonations = Array.isArray(savedVillage?.buildingDonations)
        ? savedVillage.buildingDonations.filter((entry) => entry && typeof entry === "object")
        : [];
      villageState.buildingRequests = {};
      for (const [key, record] of Object.entries(savedVillage?.buildingRequests || {})) {
        if (!record || record.status !== "committed" || typeof record.signature !== "string") continue;
        try {
          const semantics = JSON.parse(record.signature);
          record.buildingType ||= semantics?.buildingType;
          record.phaseId ||= semantics?.phaseId;
        } catch {}
        villageState.buildingRequests[key] = record;
      }
      villageState.phaseSequence = Math.max(0, Math.floor(Number(savedVillage?.phaseSequence) || 0));
    }
    // PREPARED 日志包含事务后的完整玩家/村庄快照。若进程在两个 JSON rename 之间退出，启动时
    // 无条件重放这个终态；同一 requestId 随后会命中 donations，保证不会重复扣款。
    if (fs.existsSync(homeServiceWalFile)) {
      const wal = readJsonFileSafe(homeServiceWalFile, "home-service-transaction.json");
      if (!wal) {
        // 无法解析的 WAL 不能重放，但也不能让它阻断其它存档加载；保留原文件便于人工排查。
        console.error("[persist] 家政 WAL 无法解析，已跳过重放并保留原文件");
      } else if (wal.status === "prepared") {
        try {
          replayPreparedVillageTransaction(wal);
        } catch (replayError) {
          // 结构非法同样无法重放；记录后继续启动，避免整站存档读取被中断。
          console.error("[persist] 家政 WAL 重放失败，已跳过并保留原文件:", replayError.message);
        }
      } else {
        fs.rmSync(homeServiceWalFile, { force: true });
      }
    }
    if (phaseOneMigrationNeeded) writeJsonAtomic(playerDataFile, [...players.values()].map(playerPersistenceView));
  } catch (error) {
    console.error("failed to load persisted game state", error);
  }
}

function flushPersistedState() {
  if (persistInProgress) {
    persistRequested = true;
    return;
  }
  persistInProgress = true;
  if (phaseOneTestHooksEnabled) testPersistenceCounters.fullFlushStarted += 1;
  try {
    writeJsonAtomic(marketDataFile, [...marketTrades.values()].map(marketPersistenceView));
    writeJsonAtomic(socialDataFile, socialPersistenceView());
    writeJsonAtomic(auctionDataFile, auctionPersistenceView());
    writeJsonAtomic(shopDataFile, shopPersistenceView());
    writeJsonAtomic(villageDataFile, villagePersistenceView());
    writeJsonAtomic(battleRoomFile, {
      version: 1,
      savedAt: new Date().toISOString(),
      rooms: [...battleRooms.values()].map(battleRoomPersistenceView)
    });
    writePlayersJsonNow();
    if (phaseOneTestHooksEnabled) {
      testPersistenceCounters.fullFlushCompleted += 1;
      if (testPhaseOneRetryReady && testPhaseOneRetriesPending > 0) {
        testPhaseOneRetryReady = false;
        testPhaseOneRetriesPending -= 1;
        testPersistenceCounters.phaseOneRetryCompleted += 1;
      }
    }
  } catch (error) {
    console.error("failed to persist game state", error);
    throw error;
  } finally {
    persistInProgress = false;
    if (persistRequested) {
      persistRequested = false;
      schedulePersist();
    }
  }
}

// 房间里的 battleInfo 在房间内是同一份对象（pushBattleInfo 会把第一名成员的传给所有人），
// 所以按房间存一份；把 room 和它一起写，恢复时才能接着打而不是从头开始。
function battleRoomPersistenceView(room) {
  return { room: { ...room }, battleInfo: roomBattleInfo(room) };
}

function restoreBattleRooms() {
  if (!fs.existsSync(battleRoomFile)) return;
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(battleRoomFile, "utf8"));
  } catch (error) {
    console.error("failed to read battle rooms, ignore", error);
    return;
  }
  const list = Array.isArray(saved?.rooms) ? saved.rooms : [];
  let restored = 0;
  for (const entry of list) {
    const room = entry?.room;
    if (!room?.uuid || battleRooms.has(room.uuid)) continue;
    // 成员可能已被删号：先剔掉，房间空了就丢弃
    room.memberIds = (Array.isArray(room.memberIds) ? room.memberIds : []).filter((uuid) => players.has(uuid));
    if (!room.memberIds.length) continue;
    if (!room.memberIds.includes(room.ownerId)) room.ownerId = room.memberIds[0];
    room.readyMap = Object.fromEntries(room.memberIds.map((uuid) => [uuid, Boolean(room.readyMap?.[uuid])]));
    if (!["waiting", "battling", "waiting_for_restart", "ended"].includes(room.status)) room.status = "waiting";
    room.offerings = Array.isArray(room.offerings) ? room.offerings : [];
    room.battleRewardInfo = room.battleRewardInfo && typeof room.battleRewardInfo === "object" ? room.battleRewardInfo : {};
    battleRooms.set(room.uuid, room);
    for (const uuid of room.memberIds) {
      const player = players.get(uuid);
      player.currentBattleRoomId = room.uuid;
      player.battleInfo = room.status === "battling" ? entry.battleInfo || null : null;
    }
    restored += 1;
  }
  if (!restored) return;
  console.log(`[battle] 从 ${path.basename(battleRoomFile)} 恢复 ${restored} 个房间`);
  // 交给巡检恢复回合/重启倒计时（战斗数据丢了会直接重开一场）
  for (const room of battleRooms.values()) {
    try {
      reviveBattleLoop(room);
    } catch (error) {
      console.error("[battle] 恢复房间失败", room.uuid, error);
    }
  }
}

function schedulePersist() {
  if (phaseOneTestHooksEnabled && testFullFlushFrozen) {
    persistRequested = true;
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      flushPersistedState();
    } catch {}
  }, 50);
}

loadPersistentState();
function setSession(res, player) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { uuid: player.uuid, createdAt: Date.now() });
  res.setHeader("Set-Cookie", `maomao_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
  return token;
}

function sessionPayload(player) {
  return player ? { user: publicUser(player), loggedIn: true } : { user: null, loggedIn: false };
}

function ok(res, data = null, extra = {}) {
  return res.json({ code: 200, data, ...extra });
}
function marketNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function marketInteger(value, fallback = 0) {
  return Math.floor(marketNumber(value, fallback));
}

function marketData(payload) {
  let data = payload;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  return data?.data ?? data ?? {};
}

function getMarketProfile(player) {
  player.marketProfile ||= { extraSeller: 0, extraBuyer: 0 };
  return player.marketProfile;
}

// 金币在资源表里是一等资源（category:["Currency"]），前端背包/任务面板都从 inventory.gold.count 取数，
// 因此这里让 inventory.gold 与 resources.gold 保持同步，任一时刻两边一致。
function getAssetCount(player, resourceId) {
  if (resourceId === "gold") {
    const inventoryGold = player.inventory?.gold?.count;
    if (inventoryGold !== undefined) return Math.max(0, marketNumber(inventoryGold));
    return Math.max(0, marketNumber(player.resources?.gold));
  }
  return Math.max(0, marketNumber(player.inventory?.[resourceId]?.count));
}

function setGoldCount(player, count) {
  const amount = Math.max(0, marketNumber(count));
  player.inventory ||= {};
  player.inventory.gold = { count: amount };
  player.resources ||= {};
  player.resources.gold = amount;
}

function addAsset(player, resourceId, count) {
  const amount = marketNumber(count);
  if (amount <= 0) return;
  if (resourceId === "gold") {
    setGoldCount(player, getAssetCount(player, "gold") + amount);
    return;
  }
  player.inventory[resourceId] ||= { count: 0 };
  player.inventory[resourceId].count = marketNumber(player.inventory[resourceId].count) + amount;
}

function removeAsset(player, resourceId, count) {
  const amount = marketNumber(count);
  if (amount <= 0 || getAssetCount(player, resourceId) < amount) return false;
  if (resourceId === "gold") {
    setGoldCount(player, getAssetCount(player, "gold") - amount);
    return true;
  }
  player.inventory[resourceId].count -= amount;
  if (player.inventory[resourceId].count <= 0) delete player.inventory[resourceId];
  return true;
}

function isTradeableResource(resourceId) {
  const resource = resourceCatalog[resourceId];
  return Boolean(resource && resource.id === resourceId && !resource.isInternal && !resource.hideInMarket && resourceId !== "gold" && resourceId !== "catnip");
}

function tradeableResourceIds() {
  return Object.keys(resourceCatalog).filter(isTradeableResource);
}

function marketOrderCount(player, type) {
  return [...marketTrades.values()].filter((trade) => trade.status === "open" && trade.type === type && trade.ownerUuid === player.uuid).length;
}

function marketListingLimits(player) {
  const profile = getMarketProfile(player);
  return {
    maxSellerTransactions: marketConfig.maxSellerTransactions + profile.extraSeller,
    maxBuyerTransactions: marketConfig.maxBuyerTransactions + profile.extraBuyer,
    extraSeller: profile.extraSeller,
    extraBuyer: profile.extraBuyer,
    schemeUsageSeller: { schemeA: profile.extraSeller },
    schemeUsageBuyer: { schemeA: profile.extraBuyer },
    schemeRemainingSeller: { schemeA: "infinity" },
    schemeRemainingBuyer: { schemeA: "infinity" },
    allowedSellerSchemes: marketConfig.sellerSchemes,
    allowedBuyerSchemes: marketConfig.buyerSchemes,
    schemeRemaining: { schemeA: "infinity" },
    schemeLimitMessage: {}
  };
}

function marketTradeView(trade, viewerUuid) {
  const remaining = trade.type === "sell"
    ? Math.max(0, trade.sellResourceCount - trade.selledResourceCount)
    : Math.max(0, trade.requireResourceCount - trade.doneResourceCount);
  return {
    tradeUuid: trade.tradeUuid,
    type: trade.type,
    sellResourceId: trade.sellResourceId,
    sellResourceCount: trade.sellResourceCount,
    selledResourceCount: trade.selledResourceCount,
    requireResourceId: trade.requireResourceId,
    requireResourceCount: trade.requireResourceCount,
    doneResourceCount: trade.doneResourceCount,
    costResourceId: trade.costResourceId,
    costPerUnit: trade.costPerUnit,
    payResourceId: trade.payResourceId,
    payPerUnit: trade.payPerUnit,
    isClosed: trade.status !== "open",
    isSelf: trade.ownerUuid === viewerUuid,
    createTime: trade.createTime,
    closeTime: trade.closeTime || null,
    remainingCount: remaining
  };
}

function marketPlayerSockets(uuid) {
  return [...io.sockets.sockets.values()].filter((socket) => socket.player?.uuid === uuid);
}

function emitMarketPlayerState(uuid) {
  const player = players.get(uuid);
  if (!player) return;
  for (const socket of marketPlayerSockets(uuid)) {
    emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
    emitGameEvent(socket, "inventoryUpdated", player.inventory);
    emitGameEvent(socket, "character:getGameState:success", { resources: player.resources, inventory: player.inventory, taskQueue: player.taskQueue });
    emitGameEvent(socket, "characterInitData", { data: characterInitData(player) });
  }
}

function marketTradePriceData(resourceId) {
  const sellPrices = [...marketTrades.values()]
    .filter((trade) => trade.status === "open" && trade.type === "sell" && trade.sellResourceId === resourceId)
    .map((trade) => trade.costPerUnit)
    .filter((price) => Number.isFinite(price));
  const buyPrices = [...marketTrades.values()]
    .filter((trade) => trade.status === "open" && trade.type === "buy" && trade.requireResourceId === resourceId)
    .map((trade) => trade.payPerUnit)
    .filter((price) => Number.isFinite(price));
  const result = {};
  if (sellPrices.length) result.sellOrders = { minPrice: Math.min(...sellPrices) };
  if (buyPrices.length) result.buyOrders = { maxPrice: Math.max(...buyPrices) };
  return result;
}

function marketPricePayload(resourceId) {
  const ids = resourceId ? [resourceId] : tradeableResourceIds();
  return { items: Object.fromEntries(ids.map((id) => [id, marketTradePriceData(id)])) };
}

function marketTradeList(data, viewerUuid) {
  const type = data.type === "buy" ? "buy" : data.type === "sell" ? "sell" : null;
  const status = data.status === "open" || data.status === "closed" ? data.status : null;
  const resourceIds = new Set([
    ...(Array.isArray(data.resourceIds) ? data.resourceIds : []),
    ...(data.resourceId ? [data.resourceId] : [])
  ].filter(Boolean));
  let trades = [...marketTrades.values()].filter((trade) => {
    if (type && trade.type !== type) return false;
    if (status && (trade.status === "open" ? "open" : "closed") !== status) return false;
    if (resourceIds.size) {
      const resourceId = trade.type === "sell" ? trade.sellResourceId : trade.requireResourceId;
      if (!resourceIds.has(resourceId)) return false;
    }
    return true;
  });
  const sortBy = data.sortBy || "createTime";
  const sortOrder = data.sortOrder === "asc" ? 1 : -1;
  const sortValue = (trade) => {
    if (sortBy === "costPerUnit") return trade.type === "sell" ? trade.costPerUnit : trade.payPerUnit;
    if (sortBy === "sellResourceCount") return trade.sellResourceCount;
    if (sortBy === "requireResourceCount") return trade.requireResourceCount;
    return new Date(trade.createTime).getTime();
  };
  trades.sort((left, right) => (sortValue(left) - sortValue(right)) * sortOrder);
  const pageSize = Math.min(100, Math.max(1, marketInteger(data.pageSize, 50)));
  const page = Math.max(1, marketInteger(data.page, 1));
  const start = (page - 1) * pageSize;
  const allSell = [...marketTrades.values()].filter((trade) => trade.type === "sell").length;
  const allBuy = [...marketTrades.values()].filter((trade) => trade.type === "buy").length;
  return {
    items: trades.slice(start, start + pageSize).map((trade) => marketTradeView(trade, viewerUuid)),
    total: trades.length,
    totalSell: allSell,
    totalBuy: allBuy,
    openSellCount: [...marketTrades.values()].filter((trade) => trade.type === "sell" && trade.status === "open").length,
    openBuyCount: [...marketTrades.values()].filter((trade) => trade.type === "buy" && trade.status === "open").length,
    type,
    page,
    pageSize
  };
}

function closeMarketTrade(trade) {
  trade.status = "closed";
  trade.closeTime = new Date().toISOString();
}

function emitMarketError(socket, event, message) {
  emitGameEvent(socket, `${event}:error`, { message });
}

function handleMarketEvent(socket, event, payload) {
  const player = socket.player;
  if (!player) return true;
  const data = marketData(payload);
  schedulePersist();
  if (event === "market:getListingLimits" || event === "market:listingLimits") {
    emitGameEvent(socket, "market:listingLimits:success", marketListingLimits(player));
    return true;
  }
  if (event === "newMarket:getAllTradeableResourceList") {
    emitGameEvent(socket, `${event}:success`, tradeableResourceIds());
    return true;
  }
  if (event === "newMarket:priceData") {
    emitGameEvent(socket, `${event}:success`, { resourceId: data.resourceId, data: marketTradePriceData(data.resourceId) });
    return true;
  }
  if (event === "newMarket:getUnifiedTransactionHistory" || event === "market:getTransactionList") {
    emitGameEvent(socket, `${event}:success`, marketTradeList(data, player.uuid));
    return true;
  }
  if (event === "market:expandSellerListingSlots" || event === "market:expandBuyerListingSlots") {
    if (data.schemeId && data.schemeId !== "schemeA") return emitMarketError(socket, event, "listing scheme unavailable"), true;
    const profile = getMarketProfile(player);
    if (event.includes("Seller")) profile.extraSeller += 1;
    else profile.extraBuyer += 1;
    emitGameEvent(socket, `${event}:success`, marketListingLimits(player));
    return true;
  }
  if (event === "newMarket:getRecentTradedResources") {
    // 最近成交/挂单涉及的商品：按创建时间倒序取最近的去重资源，供市场页「最近交易」快捷筛选。
    const limit = Math.max(1, Math.min(50, Math.floor(Number(data?.limit) || 20)));
    const seen = new Set();
    const resourceIds = [];
    for (const trade of [...marketTrades.values()].sort((left, right) => String(right.createTime || "").localeCompare(String(left.createTime || "")))) {
      const id = trade.sellResourceId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      resourceIds.push(id);
      if (resourceIds.length >= limit) break;
    }
    emitGameEvent(socket, `${event}:success`, { resourceIds });
    return true;
  }
  if (event === "market:listToMarket") {
    const sellResourceId = data.sellResourceId;
    const sellResourceCount = marketInteger(data.sellResourceCount, 0);
    const costResourceId = data.costResourceId || "gold";
    const costPerUnit = marketNumber(data.costPerUnit, 0);
    if (!isTradeableResource(sellResourceId) || sellResourceCount < 1 || costPerUnit <= 0) return emitMarketError(socket, event, "invalid sell order"), true;
    if (marketOrderCount(player, "sell") >= marketListingLimits(player).maxSellerTransactions) return emitMarketError(socket, event, "seller listing limit reached"), true;
    if (getAssetCount(player, sellResourceId) < sellResourceCount) return emitMarketError(socket, event, "insufficient inventory"), true;
    if (!removeAsset(player, sellResourceId, sellResourceCount)) return emitMarketError(socket, event, "insufficient inventory"), true;
    const trade = {
      tradeUuid: crypto.randomUUID(), type: "sell", status: "open", ownerUuid: player.uuid, sellerUuid: player.uuid,
      sellResourceId, sellResourceCount, selledResourceCount: 0, requireResourceId: sellResourceId, requireResourceCount: sellResourceCount, doneResourceCount: 0,
      costResourceId, costPerUnit, payResourceId: costResourceId, payPerUnit: costPerUnit, createTime: new Date().toISOString()
    };
    marketTrades.set(trade.tradeUuid, trade);
    emitMarketPlayerState(player.uuid);
    emitGameEvent(socket, `${event}:success`, marketTradeView(trade, player.uuid));
    return true;
  }
  if (event === "market:buyFromMarket") {
    const trade = marketTrades.get(data.tradeUuid);
    const buyCount = marketInteger(data.buyCount, 0);
    if (!trade || trade.type !== "sell" || trade.status !== "open") return emitMarketError(socket, event, "sell order unavailable"), true;
    if (trade.ownerUuid === player.uuid) return emitMarketError(socket, event, "cannot buy your own order"), true;
    const remaining = trade.sellResourceCount - trade.selledResourceCount;
    if (buyCount < 1 || buyCount > remaining) return emitMarketError(socket, event, "invalid purchase count"), true;
    const total = buyCount * trade.costPerUnit;
    if (getAssetCount(player, trade.costResourceId) < total) return emitMarketError(socket, event, "insufficient payment"), true;
    if (!removeAsset(player, trade.costResourceId, total)) return emitMarketError(socket, event, "insufficient payment"), true;
    addAsset(player, trade.sellResourceId, buyCount);
    const seller = players.get(trade.ownerUuid);
    if (seller) addAsset(seller, trade.costResourceId, total);
    trade.selledResourceCount += buyCount;
    trade.doneResourceCount = trade.selledResourceCount;
    if (trade.selledResourceCount >= trade.sellResourceCount) closeMarketTrade(trade);
    emitMarketPlayerState(player.uuid);
    emitMarketPlayerState(trade.ownerUuid);
    emitGameEvent(socket, `${event}:success`, marketTradeView(trade, player.uuid));
    return true;
  }
  if (event === "market:removeFromMarket") {
    const trade = marketTrades.get(data.tradeUuid);
    if (!trade || trade.type !== "sell" || trade.status !== "open") return emitMarketError(socket, event, "sell order unavailable"), true;
    if (trade.ownerUuid !== player.uuid) return emitMarketError(socket, event, "not your sell order"), true;
    addAsset(player, trade.sellResourceId, trade.sellResourceCount - trade.selledResourceCount);
    closeMarketTrade(trade);
    emitMarketPlayerState(player.uuid);
    emitGameEvent(socket, `${event}:success`, marketTradeView(trade, player.uuid));
    return true;
  }
  if (event === "buyerMarket:listToBuyerMarket") {
    const requireResourceId = data.requireResourceId;
    const requireResourceCount = marketInteger(data.requireResourceCount, 0);
    const payResourceId = data.payResourceId || "gold";
    const payPerUnit = marketNumber(data.payPerUnit, 0);
    const escrow = requireResourceCount * payPerUnit;
    if (!isTradeableResource(requireResourceId) || requireResourceCount < 1 || payPerUnit <= 0) return emitMarketError(socket, event, "invalid buy order"), true;
    if (marketOrderCount(player, "buy") >= marketListingLimits(player).maxBuyerTransactions) return emitMarketError(socket, event, "buyer listing limit reached"), true;
    if (getAssetCount(player, payResourceId) < escrow) return emitMarketError(socket, event, "insufficient payment reserve"), true;
    if (!removeAsset(player, payResourceId, escrow)) return emitMarketError(socket, event, "insufficient payment reserve"), true;
    const trade = {
      tradeUuid: crypto.randomUUID(), type: "buy", status: "open", ownerUuid: player.uuid, buyerUuid: player.uuid,
      sellResourceId: requireResourceId, sellResourceCount: requireResourceCount, selledResourceCount: 0, requireResourceId, requireResourceCount, doneResourceCount: 0,
      costResourceId: payResourceId, costPerUnit: payPerUnit, payResourceId, payPerUnit, escrowRemaining: escrow, createTime: new Date().toISOString()
    };
    marketTrades.set(trade.tradeUuid, trade);
    emitMarketPlayerState(player.uuid);
    emitGameEvent(socket, `${event}:success`, marketTradeView(trade, player.uuid));
    return true;
  }
  if (event === "buyerMarket:sellToBuyerMarket") {
    const trade = marketTrades.get(data.tradeUuid);
    const sellCount = marketInteger(data.sellCount, 0);
    if (!trade || trade.type !== "buy" || trade.status !== "open") return emitMarketError(socket, event, "buy order unavailable"), true;
    if (trade.ownerUuid === player.uuid) return emitMarketError(socket, event, "cannot sell to your own order"), true;
    const remaining = trade.requireResourceCount - trade.doneResourceCount;
    if (sellCount < 1 || sellCount > remaining) return emitMarketError(socket, event, "invalid sale count"), true;
    if (getAssetCount(player, trade.requireResourceId) < sellCount) return emitMarketError(socket, event, "insufficient inventory"), true;
    const total = sellCount * trade.payPerUnit;
    if (!removeAsset(player, trade.requireResourceId, sellCount)) return emitMarketError(socket, event, "insufficient inventory"), true;
    addAsset(player, trade.payResourceId, total);
    const buyer = players.get(trade.ownerUuid);
    if (buyer) addAsset(buyer, trade.requireResourceId, sellCount);
    trade.doneResourceCount += sellCount;
    trade.selledResourceCount = trade.doneResourceCount;
    trade.escrowRemaining = Math.max(0, marketNumber(trade.escrowRemaining) - total);
    if (trade.doneResourceCount >= trade.requireResourceCount) closeMarketTrade(trade);
    emitMarketPlayerState(player.uuid);
    emitMarketPlayerState(trade.ownerUuid);
    emitGameEvent(socket, `${event}:success`, marketTradeView(trade, player.uuid));
    return true;
  }
  if (event === "buyerMarket:removeFromBuyerMarket") {
    const trade = marketTrades.get(data.tradeUuid);
    if (!trade || trade.type !== "buy" || trade.status !== "open") return emitMarketError(socket, event, "buy order unavailable"), true;
    if (trade.ownerUuid !== player.uuid) return emitMarketError(socket, event, "not your buy order"), true;
    if (trade.escrowRemaining > 0) addAsset(player, trade.payResourceId, trade.escrowRemaining);
    closeMarketTrade(trade);
    emitMarketPlayerState(player.uuid);
    emitGameEvent(socket, `${event}:success`, marketTradeView(trade, player.uuid));
    return true;
  }
  return false;
}

// ---- 系统商店 ----
// 商品清单、售价、回收价全部来自前端资源表（resourceCatalog 的 userBuyCost / userSellCost /
// shopType），前端只负责挑商品和数量；结算必须在这里做，否则价格和库存都能被客户端改写。
// 前端一个入口对应所有商店页签：金币 / 农产品 / 猫爪印章 / 心意点数 / 水产回收。
const SHOP_MAX_TRADE_COUNT = 1000000;

function shopTradeCount(raw) {
  const count = marketInteger(raw, 0);
  return count > 0 && count <= SHOP_MAX_TRADE_COUNT ? count : 0;
}

// 成本/收益统一按「资源 + 数量」摊平：条目里的 cost 缺省就是金币，同一货币多条目合并
function shopTradeAmounts(list, multiplier) {
  const totals = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    const resourceId = entry?.cost ? String(entry.cost) : "gold";
    const amount = marketNumber(entry?.count) * multiplier;
    if (Number.isFinite(amount) && amount > 0) totals.set(resourceId, (totals.get(resourceId) || 0) + amount);
  }
  return [...totals].map(([resourceId, amount]) => ({ resourceId, amount }));
}

function shopResourceName(resourceId) {
  return resourceCatalog?.[resourceId]?.name || resourceId;
}

function shopTradeInfo(deltas) {
  const info = {};
  for (const { resourceId, amount } of deltas) {
    info[resourceId] = { count: (info[resourceId]?.count || 0) + amount };
  }
  return info;
}

function shopBuy(player, data) {
  const resourceId = String(data?.id ?? data?.resourceId ?? "");
  const count = shopTradeCount(data?.count);
  const item = resourceCatalog[resourceId];
  if (!item || item.id !== resourceId) return { error: "商品不存在" };
  if (!count) return { error: "购买数量不合法" };
  const costs = shopTradeAmounts(item.userBuyCost, count);
  if (!costs.length) return { error: "该商品暂不出售" };
  // 限量商品（目前只有赞助商店用）按 maxBuyCount 限制单次数量
  const limit = marketInteger(item.maxBuyCount, 0);
  if (limit > 0 && count > limit) return { error: `每次最多购买 ${limit} 个` };
  for (const cost of costs) {
    const owned = getAssetCount(player, cost.resourceId);
    if (owned < cost.amount) {
      return { error: `${shopResourceName(cost.resourceId)}不足（需要 ${Math.ceil(cost.amount)}，现有 ${Math.floor(owned)}）` };
    }
  }
  // 先全量校验再扣款，避免扣到一半失败
  for (const cost of costs) removeAsset(player, cost.resourceId, cost.amount);
  addAsset(player, resourceId, count);
  const deltas = [{ resourceId, amount: count }, ...costs.map((cost) => ({ resourceId: cost.resourceId, amount: -cost.amount }))];
  return { tradeInfo: shopTradeInfo(deltas) };
}

function shopSell(player, data) {
  const resourceId = String(data?.id ?? data?.resourceId ?? "");
  const count = shopTradeCount(data?.count);
  const item = resourceCatalog[resourceId];
  if (!item || item.id !== resourceId) return { error: "物品不存在" };
  if (!count) return { error: "出售数量不合法" };
  const gains = shopTradeAmounts(item.userSellCost, count);
  if (!gains.length) return { error: "商店不回收该物品" };
  if (getAssetCount(player, resourceId) < count) return { error: "背包中的数量不足" };
  if (!removeAsset(player, resourceId, count)) return { error: "背包中的数量不足" };
  for (const gain of gains) addAsset(player, gain.resourceId, gain.amount);
  const deltas = [{ resourceId, amount: -count }, ...gains.map((gain) => ({ resourceId: gain.resourceId, amount: gain.amount }))];
  return { tradeInfo: shopTradeInfo(deltas) };
}

function getOrCreatePlayer(email) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = [...players.values()].find((item) => item.email === normalizedEmail);
  return existing || makePlayer(normalizedEmail);
}

function saveAccounts() {
  const temporaryFile = `${accountFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify([...accounts.values()], null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, accountFile);
}

async function authenticate(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const account = accounts.get(normalizedEmail);
  if (account) {
    const candidate = await scrypt(String(password || ""), account.salt, 64);
    if (!crypto.timingSafeEqual(candidate, Buffer.from(account.passwordHash, "hex"))) return null;
    const player = players.get(account.uuid);
    schedulePersist();
    return player;
  }
  if (normalizedEmail !== configuredEmail.trim().toLowerCase() || password !== configuredPassword) return null;
  const player = getOrCreatePlayer(normalizedEmail);
  if (!accounts.has(normalizedEmail)) {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(String(password || ""), salt, 64)).toString("hex");
    accounts.set(normalizedEmail, { uuid: player.uuid, email: normalizedEmail, name: player.name, salt, passwordHash, createdAt: player.createdAt });
    saveAccounts();
  }
  schedulePersist();
  return player;
}
app.get("/api/_auth/session", (req, res) => {
  const token = parseCookies(req.headers.cookie).maomao_session;
  const session = token && sessions.get(token);
  const player = getPlayer(req);
  if (player && (!session || !players.has(session.uuid))) setSession(res, player);
  return res.json(sessionPayload(player));
});
app.post("/api/_auth/session", async (req, res) => {
  const { email, username, password } = req.body || {};
  const player = await authenticate(email || username, password);
  if (!player) return res.status(401).json({ code: 401, msg: "邮箱或密码错误" });
  setSession(res, player);
  schedulePersist();
  return res.json(sessionPayload(player));
});
app.delete("/api/_auth/session", (req, res) => {
  const token = parseCookies(req.headers.cookie).maomao_session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "maomao_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  return res.json({ user: null, loggedIn: false });
});
app.post(["/api/auth/login", "/api/login"], async (req, res) => {
  const { email, username, password } = req.body || {};
  const player = await authenticate(email || username, password);
  if (!player) return res.status(401).json({ code: 401, msg: "邮箱或密码错误" });
  setSession(res, player);
  schedulePersist();
  return res.json(sessionPayload(player));
});
app.post("/api/auth/register", async (req, res) => {
  const { nickname, email, password } = req.body || {};
  const name = typeof nickname === "string" ? nickname.trim() : "";
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!name || [...name].length > 24) {
    return res.status(400).json({ code: 400, msg: "昵称不能为空且不能超过24个字符" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return res.status(400).json({ code: 400, msg: "请输入有效的邮箱地址" });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ code: 400, msg: "密码长度需为8至128个字符" });
  }
  if (accounts.has(normalizedEmail) || normalizedEmail === configuredEmail.trim().toLowerCase()) {
    return res.status(409).json({ code: 409, msg: "该邮箱已注册" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
  if (accounts.has(normalizedEmail)) return res.status(409).json({ code: 409, msg: "该邮箱已注册" });

  const player = makePlayer(normalizedEmail, name);
  accounts.set(normalizedEmail, { uuid: player.uuid, email: normalizedEmail, name, salt, passwordHash, createdAt: player.createdAt });
  try {
    saveAccounts();
  } catch (error) {
    accounts.delete(normalizedEmail);
    players.delete(player.uuid);
    throw error;
  }
  setSession(res, player);
  schedulePersist();
  return res.status(201).json(sessionPayload(player));
});
app.post("/api/gm/login", (req, res) => {
  if (!gmPassword) return res.status(503).json({ code: 503, message: "GM 后台尚未配置管理员密码" });
  const address = req.ip || req.socket.remoteAddress || "unknown";
  const attempts = gmLoginAttempts.get(address) || { count: 0, lockedUntil: 0 };
  if (attempts.lockedUntil > Date.now()) return res.status(429).json({ code: 429, message: "登录尝试过多，请稍后再试" });
  const supplied = Buffer.from(String(req.body?.password || ""));
  const expected = Buffer.from(gmPassword);
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!valid) {
    attempts.count += 1;
    if (attempts.count >= 5) {
      attempts.count = 0;
      attempts.lockedUntil = Date.now() + 10 * 60 * 1000;
    }
    gmLoginAttempts.set(address, attempts);
    return res.status(401).json({ code: 401, message: "管理员密码错误" });
  }
  gmLoginAttempts.delete(address);
  const token = crypto.randomBytes(32).toString("hex");
  gmSessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + 8 * 60 * 60 * 1000, lastSeenAt: Date.now() });
  res.setHeader("Set-Cookie", `maomao_gm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
  return res.json({ code: 200, data: { authenticated: true, expiresIn: 28800 } });
});
app.get("/api/gm/session", requireGM, (req, res) => ok(res, { authenticated: true, expiresAt: new Date(req.gmSession.expiresAt).toISOString() }));
app.delete("/api/gm/session", requireGM, (req, res) => {
  const token = parseCookies(req.headers.cookie).maomao_gm_session;
  if (token) gmSessions.delete(token);
  res.setHeader("Set-Cookie", "maomao_gm_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
  return res.json({ code: 200, data: { authenticated: false } });
});
function gmOnlineUuids() {
  return new Set([...io.sockets.sockets.values()].map((socket) => socket.player?.uuid).filter(Boolean));
}

app.get("/api/gm/overview", requireGM, (_req, res) => {
  const openTrades = [...marketTrades.values()].filter((trade) => trade.status === "open");
  return ok(res, {
    playerCount: players.size,
    onlineCount: gmOnlineUuids().size,
    openSellCount: openTrades.filter((trade) => trade.type === "sell").length,
    openBuyCount: openTrades.filter((trade) => trade.type === "buy").length,
    roomCount: battleRooms.size
  });
});
app.get("/api/gm/players", requireGM, (req, res) => {
  const query = String(req.query.q || "").trim().toLowerCase();
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize) || 25)));
  const online = gmOnlineUuids();
  const matches = [...players.values()]
    .filter((player) => !query || [player.uuid, player.email, player.name].some((value) => String(value || "").toLowerCase().includes(query)))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  return ok(res, {
    items: matches.slice((page - 1) * pageSize, page * pageSize).map((player) => ({ ...safePlayerSummary(player), online: online.has(player.uuid) })),
    total: matches.length,
    page,
    pageSize
  });
});
app.get("/api/gm/players/:uuid", requireGM, (req, res) => {
  const player = players.get(req.params.uuid);
  if (!player) return res.status(404).json({ code: 404, message: "玩家不存在" });
  return ok(res, {
    ...safePlayerSummary(player),
    online: gmOnlineUuids().has(player.uuid),
    avatar: player.avatar,
    title: player.title,
    option: player.option || {},
    resources: player.resources,
    sponsorPoint: player.sponsorPoint || { current: 0, max: 0 },
    inventory: player.inventory,
    status: getPlayerStatus(player),
    taskQueue: player.taskQueue,
    kitty: player.kitty,
    workEquipment: player.workEquipment || {},
    battleEquipment: player.battleEquipment || {},
    marketProfile: player.marketProfile,
    battleRoom: publicBattleRoom(getBattleRoom(player.currentBattleRoomId))
  });
});
app.patch("/api/gm/players/:uuid", requireGM, (req, res) => {
  const player = players.get(req.params.uuid);
  if (!player) return res.status(404).json({ code: 404, message: "玩家不存在" });
  const body = req.body || {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || [...name].length > 24) return res.status(400).json({ code: 400, message: "昵称长度须为 1–24 个字符" });
    player.name = name;
    const account = accounts.get(player.email);
    if (account) account.name = name;
  }
  if (body.resources !== undefined) {
    if (!body.resources || typeof body.resources !== "object" || Array.isArray(body.resources)) return res.status(400).json({ code: 400, message: "resources 格式无效" });
    for (const [resourceId, rawCount] of Object.entries(body.resources)) {
      const count = Number(rawCount);
      if (!resourceCatalog[resourceId] && !["gold", "food"].includes(resourceId)) return res.status(400).json({ code: 400, message: `未知资源：${resourceId}` });
      if (!Number.isSafeInteger(count) || count < 0) return res.status(400).json({ code: 400, message: `${resourceId} 数量必须是非负整数` });
      // 前端读的是 inventory.gold.count，只改 resources.gold 会出现「后台显示改了、游戏里没变」
      if (resourceId === "gold") setGoldCount(player, count);
      else player.resources[resourceId] = count;
    }
  }
  if (body.inventory !== undefined) {
    if (!body.inventory || typeof body.inventory !== "object" || Array.isArray(body.inventory)) return res.status(400).json({ code: 400, message: "inventory 格式无效" });
    for (const [resourceId, rawCount] of Object.entries(body.inventory)) {
      const count = Number(rawCount);
      if (!resourceCatalog[resourceId]) return res.status(400).json({ code: 400, message: `未知物品：${resourceId}` });
      if (!Number.isSafeInteger(count) || count < 0) return res.status(400).json({ code: 400, message: `${resourceId} 数量必须是非负整数` });
      if (count === 0) delete player.inventory[resourceId];
      else player.inventory[resourceId] = { ...(player.inventory[resourceId] || {}), count };
    }
  }
  if (body.experience !== undefined) {
    if (!body.experience || typeof body.experience !== "object" || Array.isArray(body.experience)) return res.status(400).json({ code: 400, message: "experience 格式无效" });
    for (const [statusId, rawExp] of Object.entries(body.experience)) {
      if (!statusKeys.includes(statusId)) return res.status(400).json({ code: 400, message: `未知属性：${statusId}` });
      const exp = Number(rawExp);
      if (!Number.isSafeInteger(exp) || exp < 0) return res.status(400).json({ code: 400, message: `${statusId} 经验必须是非负整数` });
      player.status[statusId] = normalizeStatus({ ...player.status[statusId], currentExp: exp, exp });
    }
  }
  // 装备栏整体覆盖：传 { head: "hatX", decorate1: null } 这种槽位→物品 id 的对象。
  // 被换下来的旧装备退回背包，避免 GM 改配置时把物品改没（等价于手工卸下再穿上）。
  for (const [key, rawEquipment] of [["workEquipment", body.workEquipment], ["battleEquipment", body.battleEquipment]]) {
    if (rawEquipment === undefined) continue;
    if (!rawEquipment || typeof rawEquipment !== "object" || Array.isArray(rawEquipment)) {
      return res.status(400).json({ code: 400, message: `${key} 格式无效` });
    }
    const nextEquipment = {};
    for (const [slot, rawValue] of Object.entries(rawEquipment)) {
      if (!EQUIPMENT_SLOT_IDS.includes(slot)) return res.status(400).json({ code: 400, message: `未知装备槽：${slot}` });
      if (rawValue === null || rawValue === "" || rawValue === undefined) continue;
      const resourceId = String(rawValue);
      if (resourceCatalog[resourceId]?.id !== resourceId) return res.status(400).json({ code: 400, message: `未知装备：${resourceId}` });
      nextEquipment[slot] = resourceId;
    }
    const previous = player[key] && typeof player[key] === "object" && !Array.isArray(player[key]) ? player[key] : {};
    for (const [slot, resourceId] of Object.entries(previous)) {
      if (nextEquipment[slot] !== resourceId) addAsset(player, resourceId, 1);
    }
    player[key] = nextEquipment;
  }
  if (accounts.has(player.email)) saveAccounts();
  schedulePersist();
  emitMarketPlayerState(player.uuid);
  for (const socket of marketPlayerSockets(player.uuid)) {
    emitGameEvent(socket, "dispatchCharacterStatusInfo", getPlayerStatus(player));
    dispatchTaskQueue(socket);
  }
  return ok(res, { ...safePlayerSummary(player), inventory: player.inventory, status: getPlayerStatus(player) });
});
app.get("/api/gm/market", requireGM, (req, res) => {
  const status = ["open", "closed"].includes(req.query.status) ? req.query.status : null;
  const type = ["sell", "buy"].includes(req.query.type) ? req.query.type : null;
  const items = [...marketTrades.values()].filter((trade) => {
    if (status && (trade.status === "open" ? "open" : "closed") !== status) return false;
    if (type && trade.type !== type) return false;
    return true;
  }).sort((left, right) => new Date(right.createTime) - new Date(left.createTime));
  return ok(res, { items: items.slice(0, 200).map((trade) => ({ ...marketTradeView(trade, ""), ownerUuid: trade.ownerUuid, ownerName: players.get(trade.ownerUuid)?.name || "未知玩家" })) });
});
app.post("/api/gm/market/:tradeUuid/cancel", requireGM, (req, res) => {
  const trade = marketTrades.get(req.params.tradeUuid);
  if (!trade || trade.status !== "open") return res.status(404).json({ code: 404, message: "开放中的订单不存在" });
  const owner = players.get(trade.ownerUuid);
  if (owner) {
    if (trade.type === "sell") addAsset(owner, trade.sellResourceId, trade.sellResourceCount - trade.selledResourceCount);
    else if (trade.escrowRemaining > 0) addAsset(owner, trade.payResourceId, trade.escrowRemaining);
  }
  closeMarketTrade(trade);
  schedulePersist();
  if (owner) emitMarketPlayerState(owner.uuid);
  gmLog("market-cancel", { tradeUuid: trade.tradeUuid, type: trade.type, owner: owner?.name || trade.ownerUuid });
  return ok(res, marketTradeView(trade, ""));
});

// ---- GM 物品发放 / 角色操作 ----
// 物品清单直接来自前端资源表，前端只负责挑条目和数量，数量校验与入账都在这里做；
// 发正数走 addAsset，发负数走 removeAsset，金币两边字段（inventory.gold / resources.gold）由 setGoldCount 同步。
const GM_GRANT_MAX_COUNT = 1000000000;
const GM_GRANT_MAX_ENTRIES = 50;
const GM_LOG_LIMIT = 300;
const gmLogs = [];

function gmLog(action, detail) {
  gmLogs.unshift({ at: new Date().toISOString(), action, detail });
  if (gmLogs.length > GM_LOG_LIMIT) gmLogs.length = GM_LOG_LIMIT;
}

function gmGrantEntries(body) {
  if (Array.isArray(body?.items)) return body.items;
  if (body?.resourceId !== undefined || body?.id !== undefined) return [{ resourceId: body.resourceId ?? body.id, count: body.count }];
  return [];
}

function gmKnownItem(resourceId) {
  if (resourceId === "gold" || resourceId === "food") return true;
  if (resourceCatalog[resourceId]?.id === resourceId) return true;
  // 69 本战斗技能书只出现在 game-jresource 的怪物掉落表里，lv1~lv4 通用技能书只出现在
  // game-battle-skill 的 items 表里，两者都不在 resourceCatalog —— 不放行的话 GM 既发不了
  // 也补不了（玩家从战斗掉落拿到却学不会时没法补偿）
  return /SkillBook$/.test(resourceId);
}

app.get("/api/gm/catalog", requireGM, (_req, res) => {
  return ok(res, {
    items: Object.entries(resourceCatalog)
      .filter(([id, item]) => item && item.id === id)
      .map(([id, item]) => ({
        id,
        name: item.name || id,
        icon: item.icon || "",
        category: Array.isArray(item.category) ? item.category : [],
        equipPart: item.equipPart || null,
        equipmentType: Array.isArray(item.equipmentType) ? item.equipmentType : [],
        isInternal: Boolean(item.isInternal)
      }))
    // 内部资源（饱食度、赞助积分这类）排到最后，GM 平时要发的是正常物品
      .sort((left, right) => Number(left.isInternal) - Number(right.isInternal))
    // 粮食是老存档里的 resources.food，不在资源表中，单独补一条方便发放
    .concat([{ id: "food", name: "粮食", icon: "🍚", category: ["Currency"], equipPart: null, equipmentType: [], isInternal: false }]),
    statusKeys
  });
});

app.post("/api/gm/players/:uuid/grant", requireGM, (req, res) => {
  const player = players.get(req.params.uuid);
  if (!player) return res.status(404).json({ code: 404, message: "玩家不存在" });
  const entries = gmGrantEntries(req.body);
  if (!entries.length) return res.status(400).json({ code: 400, message: "请提供要发放的物品" });
  if (entries.length > GM_GRANT_MAX_ENTRIES) return res.status(400).json({ code: 400, message: `单次最多 ${GM_GRANT_MAX_ENTRIES} 条` });

  // 先整体校验再动手：避免第一条加成功、第三条才发现数量不足，留下一半的脏数据
  const plan = [];
  for (const entry of entries) {
    const resourceId = String(entry?.resourceId ?? entry?.id ?? "");
    const count = Math.trunc(Number(entry?.count));
    if (!gmKnownItem(resourceId)) return res.status(400).json({ code: 400, message: `未知物品：${resourceId}` });
    if (!Number.isFinite(count) || count === 0) return res.status(400).json({ code: 400, message: `${resourceId} 的数量必须是非零整数` });
    if (Math.abs(count) > GM_GRANT_MAX_COUNT) return res.status(400).json({ code: 400, message: `${resourceId} 单次数量过大` });
    plan.push({ resourceId, count });
  }
  const needs = new Map();
  for (const { resourceId, count } of plan) {
    if (count < 0) needs.set(resourceId, (needs.get(resourceId) || 0) - count);
  }
  for (const [resourceId, amount] of needs) {
    const owned = getAssetCount(player, resourceId);
    if (owned < amount) {
      return res.status(400).json({ code: 400, message: `${resourceCatalog[resourceId]?.name || resourceId} 数量不足（需要 ${amount}，现有 ${Math.floor(owned)}）` });
    }
  }
  for (const { resourceId, count } of plan) {
    if (resourceId === "food") {
      player.resources ||= {};
      player.resources.food = Math.max(0, marketNumber(player.resources.food) + count);
      continue;
    }
    if (count > 0) addAsset(player, resourceId, count);
    else removeAsset(player, resourceId, -count);
  }
  schedulePersist();
  emitMarketPlayerState(player.uuid);
  gmLog("grant", { player: player.name, uuid: player.uuid, items: plan });
  return ok(res, { applied: plan, inventory: player.inventory, resources: player.resources });
});

// 后台直接给角色发技能 / 改技能等级（技能书只覆盖 12 个生活技能，战斗技能没有获取途径，靠这里补）
app.post("/api/gm/players/:uuid/skills", requireGM, (req, res) => {
  const player = players.get(req.params.uuid);
  if (!player) return res.status(404).json({ code: 404, message: "玩家不存在" });
  const raw = Array.isArray(req.body?.skills) ? req.body.skills : [req.body].filter(Boolean);
  if (!raw.length) return res.status(400).json({ code: 400, message: "请提供要发放的技能" });
  if (raw.length > 200) return res.status(400).json({ code: 400, message: "单次最多 200 条" });
  const plan = [];
  for (const entry of raw) {
    const skillId = String(entry?.skillId ?? "").trim();
    if (!skillId) return res.status(400).json({ code: 400, message: "技能 id 不能为空" });
    const level = Math.floor(Number(entry?.level ?? 1));
    if (!Number.isFinite(level) || level < 1 || level > 150) {
      return res.status(400).json({ code: 400, message: `${skillId} 的等级必须在 1~150` });
    }
    plan.push({ skillId, level, enabled: entry?.enabled !== false });
  }
  const list = normalizePlayerSkills(player);
  for (const { skillId, level, enabled } of plan) {
    const existing = list.find((item) => item.skillId === skillId);
    if (existing) {
      existing.level = level;
      existing.enabled = enabled;
      if (existing.exp >= skillExpToNext(level)) existing.exp = 0;
    } else {
      list.push({
        skillId,
        level,
        exp: 0,
        enabled,
        order: list.length,
        logic: []
      });
    }
  }
  player.skillList = list;
  schedulePersist();
  gmLog("grantSkill", { player: player.name, uuid: player.uuid, skills: plan });
  for (const socket of marketPlayerSockets(player.uuid)) {
    emitGameEvent(socket, "character:getSkills:success", normalizePlayerSkills(player));
  }
  return ok(res, { applied: plan, skills: normalizePlayerSkills(player) });
});

// 强制下线：只断 socket，不清存档（重登立刻回来）
app.post("/api/gm/players/:uuid/kick", requireGM, (req, res) => {
  const player = players.get(req.params.uuid);
  if (!player) return res.status(404).json({ code: 404, message: "玩家不存在" });
  const sockets = marketPlayerSockets(player.uuid);
  for (const socket of sockets) {
    emitGameEvent(socket, "character:logout", { message: "账号已在后台被强制下线" });
    socket.disconnect(true);
  }
  gmLog("kick", { player: player.name, uuid: player.uuid, sockets: sockets.length });
  return ok(res, { kicked: sockets.length });
});

app.get("/api/gm/logs", requireGM, (_req, res) => ok(res, { items: gmLogs.slice(0, 100) }));

app.get("/api/app/version.check", (_req, res) => ok(res, { showUpdateLog: false, version: "local" }));

// ---- 自定义头像 ----
// 前端 AvatarSelect 用 canvas.toBlob 生成 256x256 PNG，塞进 FormData 的 `file` 字段上传，
// 期望 `{ code: 200, data: { avatar: "user_xxx.png" } }`；返回的 avatar 再由 character:updateProfile 存到玩家身上。
// 后端只有 express + socket.io，不引 multer，这里手解 multipart（只取一个 file part）。
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_FILE_PATTERN = /^user_[A-Za-z0-9_-]{1,80}\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extractMultipartFile(buffer, boundary) {
  if (!buffer?.length || !boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(marker);
  while (cursor >= 0) {
    const partStart = cursor + marker.length;
    const next = buffer.indexOf(marker, partStart);
    if (next < 0) break;
    // 去掉 part 起始的 \r\n 和结尾的 \r\n
    const slice = buffer.subarray(partStart + 2, next - 2);
    const headerEnd = slice.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headers = slice.subarray(0, headerEnd).toString("utf8");
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      if (name === "file") return { headers, data: slice.subarray(headerEnd + 4) };
    }
    cursor = next;
  }
  return null;
}

function multipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  return (match?.[1] || match?.[2] || "").trim();
}

app.post("/api/game/user/upload-avatar", requirePlayer, express.raw({ type: "multipart/form-data", limit: AVATAR_MAX_BYTES + 64 * 1024 }), (req, res) => {
  const boundary = multipartBoundary(req.headers["content-type"]);
  const part = extractMultipartFile(req.body, boundary);
  if (!part) return res.status(400).json({ code: 400, msg: "未收到头像文件" });
  if (part.data.length < PNG_MAGIC.length || !part.data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return res.status(400).json({ code: 400, msg: "头像必须是 PNG 图片" });
  }
  if (part.data.length > AVATAR_MAX_BYTES) return res.status(400).json({ code: 400, msg: "头像文件过大" });
  // 文件名由服务端生成：前端用 `/^user_/` 判断是否需要回源，加时间戳避免浏览器缓存旧图
  const filename = `user_${req.player.uuid.slice(0, 8)}_${Date.now().toString(36)}.png`;
  try {
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.writeFileSync(path.join(avatarDir, filename), part.data, { mode: 0o644 });
  } catch {
    return res.status(500).json({ code: 500, msg: "头像保存失败" });
  }
  return ok(res, { avatar: filename });
});
app.get("/api/game/user/avatar/:avatar", (req, res) => {
  const name = String(req.params.avatar || "");
  // 只放行服务端生成的文件名，避免路径穿越
  if (!AVATAR_FILE_PATTERN.test(name)) return res.status(404).send("not found");
  const file = path.join(avatarDir, name);
  if (!fs.existsSync(file)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  return res.sendFile(file);
});

app.get("/api/game/user/profile", requirePlayer, (req, res) => {
  const uuid = typeof req.query.uuid === "string" ? req.query.uuid.trim() : "";
  // 不带 uuid 时返回自己；带了就必须返回被查询的人，否则组队列表里队友名字会一直显示「加载中」
  const target = uuid ? players.get(uuid) : req.player;
  if (!target) return res.status(404).json({ code: 404, msg: "玩家不存在" });
  return ok(res, publicProfileView(target, req.player.uuid));
});
// 前端 BatchAvatarAndName 用的是 POST { uuidList: [...] }，返回 { uuid: profile }
app.post("/api/game/user/batch_profile", requirePlayer, (req, res) => {
  const uuidList = Array.isArray(req.body?.uuidList) ? req.body.uuidList : [];
  return ok(res, profileMapPayload(uuidList.slice(0, 200), req.player.uuid));
});
app.get("/api/game/user/batch_profile", requirePlayer, (req, res) => {
  const raw = req.query.uuidList;
  const uuidList = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? raw.split(",") : [];
  return ok(res, profileMapPayload(uuidList.slice(0, 200), req.player.uuid));
});
app.get("/api/game/user/online", requirePlayer, (req, res) => ok(res, { online: true, uuid: req.player.uuid }));
app.post("/api/game/user/online", requirePlayer, (req, res) => ok(res, { online: true, uuid: req.player.uuid, fp: req.body?.fp || null }));
app.post("/api/game/user/switch_account", requirePlayer, (_req, res) => sendUnsupportedFeature(res, "subAccount", "子账号切换功能尚未实现"));
app.get("/api/game/kitty/profile", requirePlayer, (req, res) => {
  const uuid = typeof req.query.uuid === "string" ? req.query.uuid.trim() : "";
  if (!uuid) return res.status(400).json({ code: "INVALID_UUID", msg: "缺少小猫 UUID", message: "缺少小猫 UUID" });
  for (const owner of players.values()) {
    const kitty = (Array.isArray(owner.kitty) ? owner.kitty : []).find((entry) => entry?.uuid === uuid);
    if (!kitty) continue;
    return ok(res, {
      uuid: kitty.uuid,
      name: typeof kitty.name === "string" && kitty.name ? kitty.name : "猫咪",
      owner: owner.uuid,
      isWorking: Boolean(kitty.isWorking || kitty.currentActionId),
      actionId: typeof kitty.currentActionId === "string" ? kitty.currentActionId : null
    });
  }
  return res.status(404).json({ code: "KITTY_NOT_FOUND", msg: "小猫不存在", message: "小猫不存在" });
});
app.get("/api/game/guild/profile", requirePlayer, (req, res) => {
  const uuid = typeof req.query.uuid === "string" ? req.query.uuid.trim() : "";
  if (!uuid) return res.status(400).json({ code: "INVALID_UUID", msg: "缺少公会 UUID", message: "缺少公会 UUID" });
  const guild = guildByUuid(uuid);
  if (!guild) return res.status(404).json({ code: "GUILD_NOT_FOUND", msg: "公会不存在", message: "公会不存在" });
  return ok(res, publicGuild(guild));
});
app.get("/api/game/market/price", requirePlayer, (req, res) => ok(res, marketPricePayload(req.query.resourceId || null)));
app.get("/api/game/onboarding/status", requirePlayer, (_req, res) => ok(res, { seen: true }));
app.post("/api/game/onboarding/mark-seen", requirePlayer, (_req, res) => ok(res, { seen: true }));
app.get("/api/game/sponsor/service-usage", requirePlayer, (_req, res) => sendUnsupportedFeature(res, "sponsorServiceUsage", "赞助服务用量尚未实现"));
app.post("/api/game/tmp_notification/get_notification_info", requirePlayer, (_req, res) => ok(res, { is_unread: false }));

const PROFILE_NAME_MAX = 24;
// 头像允许：内置头像表里的文件名（avatar_N.png / 活动头像 key）、上传生成的文件名、外链
const AVATAR_VALUE_PATTERN = /^(?:[A-Za-z0-9_.-]{1,64}\.(?:png|webp|webm)|https?:\/\/\S{1,300})$/;
const PROFILE_OPTION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

function sanitizeProfileOption(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= 30) break;
    if (!PROFILE_OPTION_KEY_PATTERN.test(key)) continue;
    if (typeof item === "boolean" || typeof item === "number") {
      result[key] = item;
      count += 1;
    } else if (typeof item === "string" && item.length <= 200) {
      result[key] = item;
      count += 1;
    }
  }
  return result;
}

// 角色设置里的「保存」：昵称 / 头像 / 选项开关。title 不在这里改（称号不该由玩家自封）。
function applyCharacterProfileUpdate(player, data) {
  const payload = data?.data ?? data ?? {};
  if (payload.name !== undefined) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > PROFILE_NAME_MAX) return { error: `昵称不能为空且不能超过${PROFILE_NAME_MAX}个字符` };
    player.name = name;
  }
  if (payload.avatar !== undefined) {
    const avatar = typeof payload.avatar === "string" ? payload.avatar.trim() : "";
    if (!AVATAR_VALUE_PATTERN.test(avatar)) return { error: "头像不合法" };
    player.avatar = avatar;
  }
  if (payload.option !== undefined) {
    const option = sanitizeProfileOption(payload.option);
    // 逐键合并而不是整体替换：表单没回显到某个开关时不能把它顺手清掉
    if (option && Object.keys(option).length > 0) player.option = { ...(player.option || {}), ...option };
  }
  return { profile: publicProfileView(player, player.uuid) };
}

// ── 好友 / 聊天 ────────────────────────────────────────────────────────────────
const CHAT_CONTENT_MAX = 500;
const CHAT_HISTORY_LIMIT = 200;

function friendshipKey(left, right) {
  return [String(left), String(right)].sort().join(":");
}

function areFriends(left, right) {
  const key = friendshipKey(left, right);
  return socialState.friendships.some((pair) => friendshipKey(pair[0], pair[1]) === key);
}

function blockedBy(viewerUuid, senderUuid) {
  return (socialState.blocks[viewerUuid] || []).includes(senderUuid);
}

function socialSockets(uuid) {
  return [...io.sockets.sockets.values()].filter((connected) => connected.player?.uuid === uuid);
}

function emitSocialTo(uuid, event, payload) {
  for (const connected of socialSockets(uuid)) emitGameEvent(connected, event, payload);
}

function safeChatContent(raw) {
  const content = typeof raw === "string" ? raw.trim() : "";
  if (!content) return { error: "消息不能为空" };
  if ([...content].length > CHAT_CONTENT_MAX) return { error: `消息不能超过${CHAT_CONTENT_MAX}个字符` };
  // 前端把普通文本片段送入 innerHTML；编码尖括号/引号可阻止标签、事件属性与实体绕过。
  return {
    content: content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
  };
}

function makeChatMessage(player, content, receiverId = null, receiverName = null) {
  const publicStyle = publicStyleView(player);
  const diy = publicStyle.currentChatBubbleStyle === "" && hasDiyStyleEntitlement(player)
    ? structuredClone(normalizeStyleState(player.style, player.uniqueFlag).diyChatBubbleStyle)
    : undefined;
  return {
    id: crypto.randomUUID(),
    sender: player.uuid,
    sender_name: player.name,
    receiver_id: receiverId,
    receiver_name: receiverName,
    content,
    extra2: {
      ...publicStyle,
      bubble: publicStyle.currentChatBubbleStyle,
      ...(diy ? { bubbleDiyStyle: diy } : {})
    },
    created_At: new Date().toISOString()
  };
}

function visibleChatList(player, predicate) {
  return socialState.chatMessages.filter((message) => predicate(message)
    && (message.channel !== "iron" || isIronPlayer(player))
    && !blockedBy(player.uuid, message.sender)).slice(-CHAT_HISTORY_LIMIT);
}

function handleFriendEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  const fail = (suffix, message) => {
    emitGameEvent(socket, `friend:${suffix}:fail`, { message });
    return true;
  };
  if (event === "friend:getList") {
    const uuids = socialState.friendships.flatMap((pair) => pair.includes(player.uuid) ? pair.filter((uuid) => uuid !== player.uuid) : []);
    emitGameEvent(socket, "friend:list", { list: [...new Set(uuids)].map((uuid) => players.get(uuid)).filter(Boolean).map(publicSocialProfile) });
    return true;
  }
  if (event === "friend:getRequests") {
    emitGameEvent(socket, "friend:requests", { requests: socialState.friendRequests.filter((request) => request.toUserUuid === player.uuid && request.status === "PENDING") });
    return true;
  }
  if (event === "friend:sendRequest") {
    const name = typeof data?.toUserName === "string" ? data.toUserName.trim() : "";
    const matches = [...players.values()].filter((candidate) => candidate.name === name);
    if (!matches.length) return fail("request:send", "找不到该玩家");
    if (matches.length > 1) return fail("request:send", "有多个同名玩家，请使用更精确的昵称");
    const target = matches[0];
    if (target.uuid === player.uuid) return fail("request:send", "不能添加自己为好友");
    if (areFriends(player.uuid, target.uuid)) return fail("request:send", "你们已经是好友");
    const duplicate = socialState.friendRequests.find((request) => request.status === "PENDING" && friendshipKey(request.fromUserUuid, request.toUserUuid) === friendshipKey(player.uuid, target.uuid));
    if (duplicate) return fail("request:send", "已有待处理的好友请求");
    const request = { id: crypto.randomUUID(), fromUserUuid: player.uuid, toUserUuid: target.uuid, status: "PENDING", createdAt: new Date().toISOString() };
    socialState.friendRequests.push(request);
    schedulePersist();
    emitGameEvent(socket, "friend:request:send:success", { request, toUserUuid: target.uuid });
    emitSocialTo(target.uuid, "friend:request:received", { fromUserUuid: player.uuid, request });
    return true;
  }
  if (event === "friend:acceptRequest" || event === "friend:rejectRequest") {
    const request = socialState.friendRequests.find((candidate) => candidate.id === data?.requestId);
    const action = event === "friend:acceptRequest" ? "accept" : "reject";
    if (!request || request.toUserUuid !== player.uuid || request.status !== "PENDING") return fail(`request:${action}`, "好友请求不存在或已处理");
    request.status = action === "accept" ? "ACCEPTED" : "REJECTED";
    request.updatedAt = new Date().toISOString();
    if (action === "accept" && !areFriends(request.fromUserUuid, request.toUserUuid)) socialState.friendships.push([request.fromUserUuid, request.toUserUuid]);
    schedulePersist();
    emitGameEvent(socket, `friend:request:${action}:success`, { request });
    emitSocialTo(request.fromUserUuid, action === "accept" ? "friend:request:accepted" : "friend:request:rejected", action === "accept"
      ? { fromUserUuid: player.uuid, toUserUuid: request.fromUserUuid, requestId: request.id }
      : { toUserUuid: request.fromUserUuid, requestId: request.id });
    return true;
  }
  if (event === "friend:remove") {
    const targetUuid = String(data?.friendUuid || "");
    if (!areFriends(player.uuid, targetUuid)) return fail("remove", "该玩家不在好友列表中");
    const key = friendshipKey(player.uuid, targetUuid);
    socialState.friendships = socialState.friendships.filter((pair) => friendshipKey(pair[0], pair[1]) !== key);
    schedulePersist();
    emitGameEvent(socket, "friend:remove:success", { friendUuid: targetUuid });
    emitSocialTo(targetUuid, "friend:removed", { userUuid: player.uuid });
    return true;
  }
  return false;
}

function guildByUuid(uuid) {
  return socialState.guilds.find((guild) => guild.uuid === uuid) || null;
}

function guildForPlayer(uuid) {
  return socialState.guilds.find((guild) => Array.isArray(guild.members) && guild.members.some((member) => member.uuid === uuid)) || null;
}

function guildMember(guild, uuid) {
  return guild?.members?.find((member) => member.uuid === uuid) || null;
}

function publicGuild(guild) {
  return {
    uuid: guild.uuid,
    name: guild.name,
    description: guild.description || "",
    type: [...(guild.type || [])],
    owner: guild.owner,
    ironcat: Boolean(guild.ironcat),
    level: Math.max(1, Math.floor(Number(guild.level) || 1)),
    memberCount: guild.members?.length || 0,
    createdAt: guild.createdAt
  };
}

function publicGuildTitle(title) {
  return {
    uuid: title.uuid,
    title: title.title,
    role: title.role,
    description: title.description || ""
  };
}

function publicGuildMember(guild, member) {
  const profile = players.get(member.uuid);
  return {
    ...(profile ? publicSocialProfile(profile) : { uuid: member.uuid, name: "已注销猫猫", avatar: "avatar_1.png" }),
    guildUuid: guild.uuid,
    role: member.role,
    titleUuid: member.titleUuid || null,
    title: guild.titles?.find((title) => title.uuid === member.titleUuid)?.title || null,
    joinedAt: member.joinedAt
  };
}

function normalizeGuildText(value, maxCodePoints) {
  const text = typeof value === "string" ? value.trim() : "";
  return [...text].length <= maxCodePoints ? text : null;
}

function normalizeGuildTypes(value) {
  if (!Array.isArray(value)) return null;
  const types = [...new Set(value.filter((type) => GUILD_TYPES.has(type)))];
  return types.length === value.length ? types : null;
}

function emitGuildMembers(guild) {
  broadcastGuildEvent(guild, "guild:members", { guildUuid: guild.uuid, members: guild.members.map((member) => publicGuildMember(guild, member)) });
}

function broadcastGuildEvent(guild, event, payload) {
  for (const member of guild.members || []) emitSocialTo(member.uuid, event, payload);
}

function handleGuildEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  const fail = (name, message) => {
    emitGameEvent(socket, name, { message });
    return true;
  };
  const requestedGuild = guildByUuid(String(data?.guildUuid || ""));
  const myGuild = guildForPlayer(player.uuid);
  const myMember = guildMember(myGuild, player.uuid);

  if (event === "guild:getList") {
    emitGameEvent(socket, "guild:list", { list: socialState.guilds.map(publicGuild) });
    return true;
  }
  if (event === "guild:getMyGuild") {
    emitGameEvent(socket, "guild:getMyGuild:success", { guild: myGuild ? publicGuild(myGuild) : null });
    return true;
  }
  if (event === "guild:getOtherGuild") {
    if (!requestedGuild) return fail("guild:getOtherGuild:fail", "公会不存在");
    emitGameEvent(socket, "guild:getOtherGuild:success", { guild: publicGuild(requestedGuild) });
    return true;
  }
  if (event === "guild:create") {
    if (myGuild) return fail("guild:create:fail", "你已经加入了一个公会");
    const name = normalizeGuildText(data?.name, 16);
    const description = normalizeGuildText(data?.description, 100);
    const type = normalizeGuildTypes(data?.type);
    if (!name) return fail("guild:create:fail", "公会名称不能为空且不能超过16个字符");
    if (description === null || !type) return fail("guild:create:fail", "公会资料不合法");
    if (socialState.guilds.some((guild) => guild.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return fail("guild:create:fail", "公会名称已被使用");
    const missing = GUILD_CREATE_COST.find((cost) => getAssetCount(player, cost.id) < cost.count);
    if (missing) return fail("guild:create:fail", `${resourceCatalog[missing.id]?.name || missing.id}不足，需要${missing.count}`);
    for (const cost of GUILD_CREATE_COST) removeAsset(player, cost.id, cost.count);
    const now = new Date().toISOString();
    const guild = {
      uuid: crypto.randomUUID(), name, description, type, owner: player.uuid, ironcat: Boolean(player.ironcat || player.isIronCat),
      level: 1, createdAt: now, updatedAt: now,
      members: [{ uuid: player.uuid, role: "LEADER", titleUuid: null, joinedAt: now }], titles: []
    };
    socialState.guilds.push(guild);
    socialState.guildJoinRequests = socialState.guildJoinRequests.filter((request) => request.userUuid !== player.uuid || request.status !== "PENDING");
    schedulePersist();
    emitGameEvent(socket, "guild:create:success", { guild: publicGuild(guild) });
    return true;
  }
  if (event === "guild:requestJoin") {
    if (myGuild) return fail("guild:join:request:fail", "你已经加入了一个公会");
    if (!requestedGuild) return fail("guild:join:request:fail", "公会不存在");
    const message = normalizeGuildText(data?.message, 200);
    if (message === null) return fail("guild:join:request:fail", "申请留言不能超过200个字符");
    if (socialState.guildJoinRequests.some((request) => request.guildUuid === requestedGuild.uuid && request.userUuid === player.uuid && request.status === "PENDING")) return fail("guild:join:request:fail", "已有待处理的入会申请");
    const request = { id: crypto.randomUUID(), guildUuid: requestedGuild.uuid, userUuid: player.uuid, message: message || "", status: "PENDING", createdAt: new Date().toISOString() };
    socialState.guildJoinRequests.push(request);
    schedulePersist();
    emitGameEvent(socket, "guild:join:request:success", { requestId: request.id });
    broadcastGuildEvent(requestedGuild, "guild:join:request:received", { request });
    return true;
  }
  if (event === "guild:getJoinRequests") {
    if (!requestedGuild || !["LEADER", "OFFICER"].includes(guildMember(requestedGuild, player.uuid)?.role)) return fail("guild:join:requests:fail", "无权查看入会申请");
    emitGameEvent(socket, "guild:join:requests", { guildUuid: requestedGuild.uuid, requests: socialState.guildJoinRequests.filter((request) => request.guildUuid === requestedGuild.uuid) });
    return true;
  }
  if (event === "guild:handleJoinRequest") {
    if (!requestedGuild || !["LEADER", "OFFICER"].includes(guildMember(requestedGuild, player.uuid)?.role)) return fail("guild:join:handle:fail", "无权处理入会申请");
    const request = socialState.guildJoinRequests.find((candidate) => candidate.guildUuid === requestedGuild.uuid && candidate.userUuid === data?.userUuid && candidate.status === "PENDING");
    if (!request) return fail("guild:join:handle:fail", "入会申请不存在或已处理");
    const approve = data?.approve === true;
    if (approve && guildForPlayer(request.userUuid)) return fail("guild:join:handle:fail", "该玩家已加入其他公会");
    request.status = approve ? "APPROVED" : "REJECTED";
    request.updatedAt = new Date().toISOString();
    if (approve) requestedGuild.members.push({ uuid: request.userUuid, role: "MEMBER", titleUuid: null, joinedAt: request.updatedAt });
    socialState.guildJoinRequests.forEach((candidate) => {
      if (approve && candidate.userUuid === request.userUuid && candidate.status === "PENDING") {
        candidate.status = candidate.id === request.id ? "APPROVED" : "CANCELLED";
        candidate.updatedAt = request.updatedAt;
      }
    });
    schedulePersist();
    emitGameEvent(socket, "guild:join:handle:success", { approve, userUuid: request.userUuid });
    emitSocialTo(request.userUuid, "guild:join:result", { approve, guild: approve ? publicGuild(requestedGuild) : null });
    if (approve) emitGuildMembers(requestedGuild);
    return true;
  }
  if (event === "guild:getMembers") {
    if (!requestedGuild) return fail("guild:members:fail", "公会不存在");
    emitGameEvent(socket, "guild:members", { guildUuid: requestedGuild.uuid, members: requestedGuild.members.map((member) => publicGuildMember(requestedGuild, member)) });
    return true;
  }
  if (event === "guild:getMyGuildMemberInfo") {
    if (!requestedGuild) return fail("guild:getMyGuildMemberInfo:fail", "公会不存在");
    const member = guildMember(requestedGuild, player.uuid);
    if (!member) return fail("guild:getMyGuildMemberInfo:fail", "你不是该公会成员");
    emitGameEvent(socket, "guild:getMyGuildMemberInfo:success", { guildUuid: requestedGuild.uuid, member: publicGuildMember(requestedGuild, member) });
    return true;
  }
  if (event === "guild:updateInfo") {
    if (!requestedGuild || guildMember(requestedGuild, player.uuid)?.role !== "LEADER") return fail("guild:update:fail", "只有会长可以修改公会资料");
    const name = normalizeGuildText(data?.name, 16);
    const description = normalizeGuildText(data?.description, 100);
    const type = normalizeGuildTypes(data?.type);
    if (!name || description === null || !type) return fail("guild:update:fail", "公会资料不合法");
    if (socialState.guilds.some((guild) => guild.uuid !== requestedGuild.uuid && guild.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return fail("guild:update:fail", "公会名称已被使用");
    requestedGuild.name = name; requestedGuild.description = description; requestedGuild.type = type; requestedGuild.updatedAt = new Date().toISOString();
    schedulePersist();
    emitGameEvent(socket, "guild:update:success", { guild: publicGuild(requestedGuild) });
    return true;
  }
  if (event === "guild:kickMember") {
    if (!requestedGuild) return fail("guild:kick:fail", "公会不存在");
    const actor = guildMember(requestedGuild, player.uuid);
    const target = guildMember(requestedGuild, String(data?.userUuid || ""));
    if (!actor || !["LEADER", "OFFICER"].includes(actor.role)) return fail("guild:kick:fail", "无权踢出成员");
    if (!target || target.role === "LEADER" || target.uuid === player.uuid || (actor.role === "OFFICER" && target.role !== "MEMBER")) return fail("guild:kick:fail", "无法踢出该成员");
    requestedGuild.members = requestedGuild.members.filter((member) => member.uuid !== target.uuid);
    schedulePersist();
    emitGameEvent(socket, "guild:kick:success", { userUuid: target.uuid });
    emitSocialTo(target.uuid, "guild:kicked", { guildUuid: requestedGuild.uuid });
    emitGuildMembers(requestedGuild);
    return true;
  }
  if (event === "guild:leave") {
    if (!myGuild || myGuild.uuid !== String(data?.guildUuid || "")) return fail("guild:leave:fail", "你不是该公会成员");
    if (myMember.role === "LEADER") return fail("guild:leave:fail", "会长必须先解散公会，不能直接离开");
    myGuild.members = myGuild.members.filter((member) => member.uuid !== player.uuid);
    schedulePersist();
    emitGameEvent(socket, "guild:leave:success", { guildUuid: myGuild.uuid });
    emitGuildMembers(myGuild);
    return true;
  }
  if (event === "guild:disband") {
    if (!requestedGuild || requestedGuild.owner !== player.uuid || guildMember(requestedGuild, player.uuid)?.role !== "LEADER") return fail("guild:disband:fail", "只有会长可以解散公会");
    const memberUuids = requestedGuild.members.map((member) => member.uuid);
    socialState.guilds = socialState.guilds.filter((guild) => guild.uuid !== requestedGuild.uuid);
    socialState.guildJoinRequests = socialState.guildJoinRequests.filter((request) => request.guildUuid !== requestedGuild.uuid);
    socialState.chatMessages = socialState.chatMessages.filter((message) => message.guildUuid !== requestedGuild.uuid);
    schedulePersist();
    emitGameEvent(socket, "guild:disband:success", { guildUuid: requestedGuild.uuid });
    for (const uuid of memberUuids) if (uuid !== player.uuid) emitSocialTo(uuid, "guild:kicked", { guildUuid: requestedGuild.uuid, disbanded: true });
    return true;
  }
  if (event === "guild:title:list") {
    if (!requestedGuild) return fail("guild:title:list:fail", "公会不存在");
    emitGameEvent(socket, "guild:title:list:success", { titles: (requestedGuild.titles || []).map(publicGuildTitle) });
    return true;
  }
  if (["guild:title:add", "guild:title:update", "guild:title:delete", "guild:title:set"].includes(event)) {
    if (!requestedGuild || guildMember(requestedGuild, player.uuid)?.role !== "LEADER") return fail(`${event}:fail`, "只有会长可以管理公会头衔");
    requestedGuild.titles ||= [];
    if (event === "guild:title:delete") {
      const titleIndex = requestedGuild.titles.findIndex((title) => title.uuid === data?.titleUuid);
      if (titleIndex < 0) return fail("guild:title:delete:fail", "头衔不存在");
      requestedGuild.titles.splice(titleIndex, 1);
      requestedGuild.members.forEach((member) => { if (member.titleUuid === data?.titleUuid) member.titleUuid = null; });
    } else if (event === "guild:title:set") {
      const member = guildMember(requestedGuild, String(data?.userUuid || ""));
      const title = requestedGuild.titles.find((entry) => entry.uuid === data?.titleUuid);
      if (!member || (data?.titleUuid && !title)) return fail("guild:title:set:fail", "成员或头衔不存在");
      if (title && title.role !== member.role) return fail("guild:title:set:fail", "该头衔不适用于成员当前职务");
      member.titleUuid = title?.uuid || null;
    } else {
      const title = normalizeGuildText(data?.title, 24);
      const description = normalizeGuildText(data?.description, 40);
      const role = String(data?.role || "");
      if (!title || description === null || !GUILD_ROLES.has(role)) return fail(`${event}:fail`, "头衔资料不合法");
      if (event === "guild:title:add") requestedGuild.titles.push({ uuid: crypto.randomUUID(), title, description, role });
      else {
        const current = requestedGuild.titles.find((entry) => entry.uuid === data?.titleUuid);
        if (!current) return fail("guild:title:update:fail", "头衔不存在");
        current.title = title; current.description = description; current.role = role;
        requestedGuild.members.forEach((member) => { if (member.titleUuid === current.uuid && member.role !== role) member.titleUuid = null; });
      }
    }
    schedulePersist();
    emitGameEvent(socket, `${event}:success`, { guildUuid: requestedGuild.uuid });
    return true;
  }
  return false;
}

function roomMemberIds(roomId) {
  return battleRooms.get(roomId)?.memberIds || [];
}

function handleChatEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  const error = (name, message) => {
    emitGameEvent(socket, name, { message });
    return true;
  };
  if (event === "chat:getPublicChatList") {
    emitGameEvent(socket, "chat:getChatList:success", { list: visibleChatList(player, (message) => message.channel === "public") });
    return true;
  }
  if (event === "chat:getIronPublicChatList") {
    if (!isIronPlayer(player)) return error("chat:createComment:error", "仅铁猫角色可以使用铁猫频道");
    emitGameEvent(socket, "chat:getIronPublicChatList:success", { list: visibleChatList(player, (message) => message.channel === "iron") });
    return true;
  }
  if (event === "chat:getAllPrivateChatList") {
    emitGameEvent(socket, "chat:getAllPrivateChatList:success", { list: visibleChatList(player, (message) => message.channel === "private" && [message.sender, message.receiver_id].includes(player.uuid)) });
    return true;
  }
  if (event === "chat:getPrivateChatList") {
    const targetUuid = String(data?.receiverUuid || "");
    emitGameEvent(socket, "chat:getPrivateChatList:success", { list: visibleChatList(player, (message) => message.channel === "private" && friendshipKey(message.sender, message.receiver_id) === friendshipKey(player.uuid, targetUuid)) });
    return true;
  }
  if (event === "chat:getRoomChatList") {
    const roomId = String(data?.roomId || "");
    if (!roomMemberIds(roomId).includes(player.uuid)) return error("chat:createComment:error", "你不在该房间中");
    emitGameEvent(socket, "chat:getRoomChatList:success", { list: visibleChatList(player, (message) => message.channel === "room" && message.roomId === roomId) });
    return true;
  }
  if (event === "chat:getGuildChatList") {
    const guild = guildByUuid(String(data?.guildUuid || ""));
    if (!guild || !guildMember(guild, player.uuid)) return error("chat:createComment:error", "你不是该公会成员");
    emitGameEvent(socket, "chat:getGuildChatList:success", { list: visibleChatList(player, (message) => message.channel === "guild" && message.guildUuid === guild.uuid) });
    return true;
  }
  if (event === "chat:getBlockList") {
    const all = socialState.blocks[player.uuid] || [];
    emitGameEvent(socket, "chat:blockList:success", { list: { all, public: all } });
    return true;
  }
  if (event === "chat:blockUser" || event === "chat:unblockUser") {
    const targetUuid = String(data?.targetUuid || "").toLowerCase();
    const verb = event === "chat:blockUser" ? "block" : "unblock";
    if (!players.has(targetUuid) || targetUuid === player.uuid) return error(`chat:${verb}:error`, "玩家不存在或无法操作");
    const blocked = new Set(socialState.blocks[player.uuid] || []);
    if (verb === "block") blocked.add(targetUuid); else blocked.delete(targetUuid);
    socialState.blocks[player.uuid] = [...blocked];
    schedulePersist();
    emitGameEvent(socket, `chat:${verb}:success`, { targetUuid });
    return true;
  }
  const checked = safeChatContent(data?.content);
  if (checked.error) {
    if (event === "chat:createPublicChatMsg") {
      return error("chat:createPublicMessage:error", checked.error);
    }
    const name = event === "chat:createPrivateChatMsg" ? "chat:createPrivateChatMsg:error" : "chat:createComment:error";
    return error(name, checked.error);
  }
  let message;
  let recipients = [];
  let pushedEvent;
  if (event === "chat:createPublicChatMsg" || event === "chat:createIronPublicChatMsg") {
    const iron = event === "chat:createIronPublicChatMsg";
    if (iron && !isIronPlayer(player)) return error("chat:createComment:error", "仅铁猫角色可以使用铁猫频道");
    message = makeChatMessage(player, checked.content);
    message.channel = iron ? "iron" : "public";
    pushedEvent = iron ? "chat:newIronPublicChatMsg" : "chat:newPublicChatMsg";
    recipients = iron ? [...players.values()].filter(isIronPlayer).map((candidate) => candidate.uuid) : [...players.keys()];
  } else if (event === "chat:createPrivateChatMsg") {
    const targetUuid = String(data?.toUser || "");
    if (!players.has(targetUuid) || targetUuid === player.uuid) return error("chat:createPrivateChatMsg:error", "私聊对象不存在");
    if (!areFriends(player.uuid, targetUuid)) return error("chat:createPrivateChatMsg:error", "只能给好友发送私聊消息");
    if (blockedBy(targetUuid, player.uuid)) return error("chat:createPrivateChatMsg:error", "对方无法接收你的消息");
    message = makeChatMessage(player, checked.content, targetUuid, players.get(targetUuid).name);
    message.channel = "private";
    pushedEvent = "chat:newPrivateChatMsg";
    recipients = [player.uuid, targetUuid];
  } else if (event === "chat:createGuildChatMsg") {
    const guild = guildByUuid(String(data?.guildUuid || ""));
    if (!guild || !guildMember(guild, player.uuid)) return error("chat:createComment:error", "你不是该公会成员");
    message = makeChatMessage(player, checked.content, `guild:${guild.uuid}`, guild.name);
    message.channel = "guild";
    message.guildUuid = guild.uuid;
    pushedEvent = "chat:newGuildChatMsg";
    recipients = guild.members.map((member) => member.uuid);
  } else if (event === "chat:createRoomChatMsg") {
    const roomId = String(data?.roomId || "");
    const room = battleRooms.get(roomId);
    if (!room?.memberIds.includes(player.uuid)) return error("chat:createComment:error", "你不在该房间中");
    message = makeChatMessage(player, checked.content, `room:${roomId}`, room.name || roomId);
    message.channel = "room";
    message.roomId = roomId;
    pushedEvent = "chat:newRoomChatMsg";
    recipients = room.memberIds;
  } else {
    return false;
  }
  socialState.chatMessages.push(message);
  if (socialState.chatMessages.length > 5000) socialState.chatMessages.splice(0, socialState.chatMessages.length - 5000);
  schedulePersist();
  for (const uuid of new Set(recipients)) {
    if (blockedBy(uuid, player.uuid)) continue;
    emitSocialTo(uuid, pushedEvent, pushedEvent === "chat:newPublicChatMsg" || pushedEvent === "chat:newIronPublicChatMsg" ? message : { msg: message });
  }
  return true;
}

function auctionPublicView(auction) {
  const seller = players.get(auction.creator);
  const topBid = auction.bids.length ? auction.bids.reduce((best, bid) => (Number(bid.amount) > Number(best.amount) ? bid : best)) : null;
  const topBidAmount = topBid ? Number(topBid.amount) : 0;
  const metadata = auction.metadata && typeof auction.metadata === "object" ? { ...auction.metadata } : {};
  if (!metadata.title) metadata.title = resourceCatalog[auction.targetId]?.name || auction.targetId;
  return {
    uuid: auction.uuid,
    creator: auction.creator,
    creatorName: seller?.name || "未知玩家",
    targetType: auction.targetType,
    targetId: auction.targetId,
    targetCount: auction.targetCount,
    startPrice: auction.startPrice,
    currentPrice: Math.max(auction.startPrice, topBidAmount),
    currentMaxPrice: topBidAmount || null,
    currentMaxPriceUserUuid: topBid ? topBid.bidder : null,
    bidCount: auction.bids.length,
    state: auction.state,
    endAt: auction.endAt,
    createdAt: auction.createdAt,
    metadata
  };
}

function auctionFail(socket, name, message) {
  emitGameEvent(socket, name, { message });
  return true;
}

function settleExpiredAuctions() {
  const now = Date.now();
  let changed = false;
  for (const auction of auctionState.auctions) {
    if (auction.state !== "OPEN" || Date.parse(auction.endAt) > now) continue;
    const top = auction.bids.length
      ? auction.bids.reduce((best, bid) => (Number(bid.amount) > Number(best.amount) ? bid : best))
      : null;
    if (!top) {
      // 流拍：物品退回给卖家
      addAsset(players.get(auction.creator), auction.targetId, auction.targetCount);
      auction.state = "ENDED";
    } else {
      // 成交：物品给买家，金币给卖家（出价时已扣款托管）
      const buyer = players.get(top.bidder);
      const seller = players.get(auction.creator);
      if (buyer) addAsset(buyer, auction.targetId, auction.targetCount);
      if (seller) addAsset(seller, "gold", top.amount);
      auction.state = "SETTLED";
      auction.winner = top.bidder;
      auction.finalPrice = top.amount;
    }
    auction.settledAt = new Date().toISOString();
    changed = true;
  }
  if (changed) schedulePersist();
}

function handleAuctionEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  settleExpiredAuctions();
  if (event === "auction:list") {
    const query = data?.query || {};
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(query.pageSize) || 12)));
    const search = typeof query.search === "string" ? query.search.trim().toLowerCase() : "";
    const state = typeof query.state === "string" && query.state ? query.state : "OPEN";
    let list = auctionState.auctions.filter((auction) => auction.state === state);
    if (query.targetType) list = list.filter((auction) => auction.targetType === query.targetType);
    if (search) list = list.filter((auction) => String(auction.targetId).toLowerCase().includes(search));
    list.sort((left, right) => String(left.endAt).localeCompare(String(right.endAt)) || left.uuid.localeCompare(right.uuid));
    const total = list.length;
    const items = list.slice((page - 1) * pageSize, page * pageSize).map(auctionPublicView);
    emitGameEvent(socket, "auction:list:success", { items, total, page, pageSize });
    return true;
  }
  if (event === "auction:upcoming") {
    const soon = auctionState.auctions
      .filter((auction) => auction.state === "OPEN" && Date.parse(auction.endAt) - Date.now() <= 6 * 60 * 60 * 1000)
      .sort((left, right) => String(left.endAt).localeCompare(String(right.endAt)))
      .slice(0, 10)
      .map(auctionPublicView);
    emitGameEvent(socket, "auction:upcoming:success", { items: soon });
    return true;
  }
  if (event === "auction:detail") {
    const auction = auctionState.auctions.find((candidate) => candidate.uuid === String(data?.uuid || ""));
    if (!auction) return auctionFail(socket, "auction:detail:fail", "拍卖不存在");
    emitGameEvent(socket, "auction:detail:success", { auction: auctionPublicView(auction), bids: auction.bids });
    return true;
  }
  if (event === "auction:history") {
    const auctionUuid = String(data?.auctionUuid || "");
    if (auctionUuid) {
      const auction = auctionState.auctions.find((candidate) => candidate.uuid === auctionUuid);
      if (!auction) return auctionFail(socket, "auction:history:fail", "拍卖不存在");
      const history = [...auction.bids]
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .map((bid) => ({ ...bid, userUuid: bid.bidder }));
      emitGameEvent(socket, "auction:history:success", { history });
      return true;
    }
    const query = data?.query || {};
    const mine = auctionState.auctions
      .filter((auction) => auction.creator === player.uuid || auction.bids.some((bid) => bid.bidder === player.uuid))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.max(1, Math.min(100, Math.floor(Number(query.pageSize) || 20))))
      .map(auctionPublicView);
    emitGameEvent(socket, "auction:history:success", { items: mine, total: mine.length });
    return true;
  }
  if (event === "auction:create") {
    const input = data?.input || {};
    const targetId = typeof input.targetId === "string" ? input.targetId.trim() : "";
    const targetType = String(input.targetType || "").toUpperCase();
    const targetCount = Math.floor(Number(input.targetCount));
    const startPrice = Math.floor(Number(input.startPrice));
    const endAt = typeof input.endAt === "string" ? new Date(input.endAt) : null;
    if (!targetId || !["ITEM", "TITLE", "TEXT"].includes(targetType)) return auctionFail(socket, "auction:create:fail", "请填写有效的目标类型与目标 ID");
    if (!Number.isSafeInteger(targetCount) || targetCount < 1) return auctionFail(socket, "auction:create:fail", "数量必须为大于等于 1 的整数");
    if (!Number.isSafeInteger(startPrice) || startPrice < 1) return auctionFail(socket, "auction:create:fail", "起价必须为大于等于 1 的整数");
    if (!endAt || Number.isNaN(endAt.getTime()) || endAt.getTime() <= Date.now()) return auctionFail(socket, "auction:create:fail", "结束时间必须晚于当前时间");
    if (getAssetCount(player, targetId) < targetCount) return auctionFail(socket, "auction:create:fail", "背包中没有足够的委托物品");
    removeAsset(player, targetId, targetCount);
    const auction = {
      uuid: crypto.randomUUID(),
      creator: player.uuid,
      targetType,
      targetId,
      targetCount,
      startPrice,
      bids: [],
      state: "OPEN",
      endAt: endAt.toISOString(),
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: new Date().toISOString()
    };
    auctionState.auctions.push(auction);
    schedulePersist();
    emitGameEvent(socket, "auction:create:success", { auction: auctionPublicView(auction) });
    return true;
  }
  if (event === "auction:bid") {
    const input = data?.input && typeof data.input === "object" ? data.input : data;
    const auctionUuid = String(input?.auctionUuid || input?.uuid || "");
    const auction = auctionState.auctions.find((candidate) => candidate.uuid === auctionUuid);
    if (!auction) return auctionFail(socket, "auction:bid:fail", "拍卖不存在");
    if (auction.state !== "OPEN") return auctionFail(socket, "auction:bid:fail", "拍卖已结束");
    if (auction.creator === player.uuid) return auctionFail(socket, "auction:bid:fail", "不能对自己的拍卖出价");
    const amount = Math.floor(Number(input?.amount));
    const current = auction.bids.length ? Math.max(...auction.bids.map((bid) => Number(bid.amount) || 0)) : 0;
    const minimum = Math.max(auction.startPrice, current + 1);
    if (!Number.isSafeInteger(amount) || amount < minimum) return auctionFail(socket, "auction:bid:fail", `出价必须不低于 ${minimum}`);
    if (getAssetCount(player, "gold") < amount) return auctionFail(socket, "auction:bid:fail", "金币不足");
    removeAsset(player, "gold", amount);
    const previous = auction.bids.reduce((best, bid) => (!best || Number(bid.amount) > Number(best.amount) ? bid : best), null);
    if (previous) {
      const previousBidder = players.get(previous.bidder);
      if (previousBidder) addAsset(previousBidder, "gold", Number(previous.amount));
    }
    auction.bids.push({ bidder: player.uuid, amount, createdAt: new Date().toISOString() });
    schedulePersist();
    emitGameEvent(socket, "auction:bid:success", { auction: auctionPublicView(auction) });
    return true;
  }
  if (event === "auction:cancel") {
    const auctionUuid = String(data?.auctionUuid || data?.uuid || "");
    const auction = auctionState.auctions.find((candidate) => candidate.uuid === auctionUuid);
    if (!auction) return auctionFail(socket, "auction:cancel:fail", "拍卖不存在");
    if (auction.creator !== player.uuid) return auctionFail(socket, "auction:cancel:fail", "只有委托者可以取消");
    if (auction.state !== "OPEN") return auctionFail(socket, "auction:cancel:fail", "拍卖已结束");
    if (auction.bids.length) return auctionFail(socket, "auction:cancel:fail", "已有出价，不能取消");
    addAsset(player, auction.targetId, auction.targetCount);
    auction.state = "CANCELLED";
    auction.settledAt = new Date().toISOString();
    schedulePersist();
    emitGameEvent(socket, "auction:cancel:success", { uuid: auction.uuid });
    return true;
  }
  return false;
}

function shopItemView(item, seller) {
  const soldCount = Math.max(0, Math.floor(Number(item.soldCount) || 0));
  const reserve = Math.max(0, Math.floor(Number(item.inventoryRemainingCount) || 0));
  const remaining = seller
    ? Math.max(0, getAssetCount(seller, item.resourceId) - reserve)
    : Math.max(0, Math.floor(Number(item.remaining) || 0));
  return {
    uuid: item.uuid,
    resourceId: item.resourceId,
    name: resourceCatalog[item.resourceId]?.name || item.resourceId,
    count: remaining + soldCount,
    remaining,
    availableCount: remaining,
    soldCount,
    inventoryRemainingCount: Math.max(0, Math.floor(Number(item.inventoryRemainingCount) || 0)),
    state: remaining > 0 ? "ACTIVE" : "OUT",
    sellerUuid: item.sellerUuid || null,
    currencyResourceId: PLAYER_SHOP_CURRENCY_ID,
    unitPrice: item.unitPrice,
    comment: item.comment || "",
    perPlayerDailyLimit: item.perPlayerDailyLimit || 0,
    perPlayerLimitIntervalDays: item.perPlayerLimitIntervalDays || 1,
    createdAt: item.createdAt
  };
}

function shopView(shop) {
  const owner = players.get(shop.owner);
  const items = (shop.items || []).filter((item) => shopItemView({ ...item, sellerUuid: shop.owner }, owner).availableCount > 0 && Date.parse(shop.expiresAt) > Date.now());
  const itemViews = items.map((item) => shopItemView({ ...item, sellerUuid: shop.owner }, owner));
  return {
    uuid: shop.uuid,
    owner: shop.owner,
    ownerName: owner?.name || "未知玩家",
    sellerUuid: shop.owner,
    name: shop.name,
    description: shop.description || "",
    visibility: shop.visibility || "PUBLIC",
    state: Date.parse(shop.expiresAt) > Date.now() ? "OPEN" : "CLOSED",
    expiresAt: shop.expiresAt,
    createdAt: shop.createdAt,
    itemCount: itemViews.length,
    maxItems: shopCapacity(shop),
    sellResource: [...new Set(itemViews.map((item) => item.resourceId))],
    items: itemViews
  };
}

function shopFail(socket, name, message) {
  emitGameEvent(socket, name, { message });
  return true;
}

function pruneShopPins() {
  const now = Date.now();
  let changed = false;
  for (const [shopUuid, expiresAt] of Object.entries(shopState.pins)) {
    if (Number(expiresAt) <= now || !shopState.shops.some((shop) => shop.uuid === shopUuid)) {
      delete shopState.pins[shopUuid];
      changed = true;
    }
  }
  for (const [playerUuid, expiresAt] of Object.entries(shopState.pinCooldowns)) {
    if (Number(expiresAt) <= now || !players.has(playerUuid)) {
      delete shopState.pinCooldowns[playerUuid];
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

function pinnedShopList() {
  pruneShopPins();
  return Object.entries(shopState.pins)
    .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]))
    .map(([shopUuid, expiresAt]) => ({ shopUuid, expiresAt: new Date(Number(expiresAt)).toISOString() }));
}

function shopCapacity(shop) {
  return PLAYER_SHOP_BASE_ITEMS + Math.max(0, Math.min(PLAYER_SHOP_MAX_EXTRA_ITEMS, Math.floor(Number(shop?.extraItemSlots) || 0)));
}

function handlePlayerShopEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  const myShops = () => shopState.shops.filter((shop) => shop.owner === player.uuid);
  if (event === "playerShop:my") {
    emitGameEvent(socket, "playerShop:my:success", { shops: myShops().map(shopView) });
    return true;
  }
  if (event === "playerShop:public") {
    const pinned = new Set(pinnedShopList().map((entry) => entry.shopUuid));
    const shops = shopState.shops
      .filter((shop) => (shop.visibility || "PUBLIC") === "PUBLIC" && Date.parse(shop.expiresAt) > Date.now())
      .map(shopView)
      .filter((shop) => shop.items.length > 0)
      .sort((left, right) => Number(pinned.has(right.uuid)) - Number(pinned.has(left.uuid)) || String(right.createdAt).localeCompare(String(left.createdAt)));
    emitGameEvent(socket, "playerShop:public:success", { shops });
    return true;
  }
  if (event === "playerShop:detail") {
    const shop = shopState.shops.find((candidate) => candidate.uuid === String(data?.shopUuid || ""));
    if (!shop) return shopFail(socket, "playerShop:detail:error", "店铺不存在");
    emitGameEvent(socket, "playerShop:detail:success", { shop: shopView(shop), items: shopView(shop).items });
    return true;
  }
  if (event === "playerShop:getPinned") {
    const pinned = pinnedShopList();
    const cooldownRemainingSec = Math.max(0, Math.ceil((Number(shopState.pinCooldowns[player.uuid]) - Date.now()) / 1000) || 0);
    emitGameEvent(socket, "playerShop:getPinned:success", {
      pinned,
      cooldownRemainingSec,
      canPin: cooldownRemainingSec === 0 && pinned.length < PLAYER_SHOP_MAX_GLOBAL_PINS,
      currentPinnedCount: pinned.length,
      maxGlobalPins: PLAYER_SHOP_MAX_GLOBAL_PINS
    });
    return true;
  }
  if (event === "playerShop:getListingLimits") {
    const mine = myShops();
    const primaryShop = mine[0] || null;
    const extraSeller = primaryShop ? Math.max(0, Math.min(PLAYER_SHOP_MAX_EXTRA_ITEMS, Math.floor(Number(primaryShop.extraItemSlots) || 0))) : 0;
    const schemeUsage = {
      default: Math.max(0, Math.min(PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES, Math.floor(Number(primaryShop?.schemeUsage?.default) || 0))),
      fast: Math.max(0, Math.floor(Number(primaryShop?.schemeUsage?.fast) || 0))
    };
    const atCapacity = extraSeller >= PLAYER_SHOP_MAX_EXTRA_ITEMS;
    const allowedSchemes = atCapacity
      ? []
      : [schemeUsage.default < PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES ? "default" : null, "fast"].filter(Boolean);
    emitGameEvent(socket, "playerShop:getListingLimits:success", {
      maxShops: PLAYER_SHOP_MAX_SHOPS,
      maxSlots: PLAYER_SHOP_BASE_ITEMS + extraSeller,
      maxItemsPerShop: PLAYER_SHOP_BASE_ITEMS + extraSeller,
      currentShopCount: mine.length,
      currentItemCount: mine.reduce((sum, shop) => sum + (shop.items || []).length, 0),
      extra: extraSeller,
      extraSeller,
      allowedSchemes,
      schemeUsage,
      schemeRemaining: {
        default: Math.max(0, PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES - schemeUsage.default),
        fast: atCapacity ? 0 : "infinity"
      }
    });
    return true;
  }
  if (event === "playerShop:create") {
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    if (!name) return shopFail(socket, "playerShop:create:error", "请填写店铺名称");
    if (myShops().length >= PLAYER_SHOP_MAX_SHOPS) return shopFail(socket, "playerShop:create:error", `最多开设 ${PLAYER_SHOP_MAX_SHOPS} 家店铺`);
    if (getAssetCount(player, "playerShopLicense") < 1) return shopFail(socket, "playerShop:create:error", "缺少店铺营业许可");
    const now = new Date();
    const shop = {
      uuid: crypto.randomUUID(),
      owner: player.uuid,
      name,
      description: typeof data?.description === "string" ? data.description.slice(0, 200) : "",
      visibility: data?.visibility === "PRIVATE" ? "PRIVATE" : "PUBLIC",
      items: [],
      extraItemSlots: 0,
      schemeUsage: { default: 0, fast: 0 },
      expiresAt: new Date(now.getTime() + PLAYER_SHOP_DAYS * 86400000).toISOString(),
      createdAt: now.toISOString()
    };
    removeAsset(player, "playerShopLicense", 1);
    shopState.shops.push(shop);
    schedulePersist();
    emitGameEvent(socket, "playerShop:create:success", { shop: shopView(shop) });
    return true;
  }
  if (event === "playerShop:addItem") {
    const shopUuid = String(data?.shopUuid || "");
    const shop = myShops().find((candidate) => candidate.uuid === shopUuid);
    if (!shop) return shopFail(socket, "playerShop:addItem:error", "店铺不存在或不属于你");
    const resourceId = typeof data?.resourceId === "string" ? data.resourceId.trim() : "";
    const reserve = Math.max(0, Math.floor(Number(data?.inventoryRemainingCount) || 0));
    const unitPrice = Math.floor(Number(data?.unitPrice));
    if (!resourceId) return shopFail(socket, "playerShop:addItem:error", "请选择物品");
    if (!Number.isSafeInteger(reserve)) return shopFail(socket, "playerShop:addItem:error", "保留数量必须为非负整数");
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) return shopFail(socket, "playerShop:addItem:error", "单价必须为大于等于 1 的整数");
    if ((shop.items || []).length >= shopCapacity(shop)) return shopFail(socket, "playerShop:addItem:error", `该店铺最多挂售 ${shopCapacity(shop)} 件物品`);
    if (getAssetCount(player, resourceId) <= reserve) return shopFail(socket, "playerShop:addItem:error", "当前库存不高于保留数量，没有可售物品");
    const item = {
      uuid: crypto.randomUUID(),
      resourceId,
      count: getAssetCount(player, resourceId),
      soldCount: 0,
      remaining: Math.max(0, getAssetCount(player, resourceId) - reserve),
      inventoryRemainingCount: reserve,
      unitPrice,
      comment: typeof data?.comment === "string" ? data.comment.slice(0, 200) : "",
      perPlayerDailyLimit: Math.max(0, Math.floor(Number(data?.perPlayerDailyLimit) || 0)),
      perPlayerLimitIntervalDays: Math.max(1, Math.min(30, Math.floor(Number(data?.perPlayerLimitIntervalDays) || 1))),
      createdAt: new Date().toISOString()
    };
    shop.items.push(item);
    schedulePersist();
    emitGameEvent(socket, "playerShop:addItem:success", { item: shopItemView({ ...item, sellerUuid: shop.owner }, player), shop: shopView(shop) });
    return true;
  }
  if (event === "playerShop:removeItem") {
    const itemUuid = String(data?.itemUuid || "");
    const shop = myShops().find((candidate) => (candidate.items || []).some((item) => item.uuid === itemUuid));
    if (!shop) return shopFail(socket, "playerShop:removeItem:error", "物品不存在");
    const item = shop.items.find((candidate) => candidate.uuid === itemUuid);
    shop.items = shop.items.filter((candidate) => candidate.uuid !== itemUuid);
    schedulePersist();
    emitGameEvent(socket, "playerShop:removeItem:success", { itemUuid });
    return true;
  }
  if (event === "playerShop:updateItem") {
    const itemUuid = String(data?.itemUuid || "");
    const shop = myShops().find((candidate) => (candidate.items || []).some((item) => item.uuid === itemUuid));
    if (!shop) return shopFail(socket, "playerShop:updateItem:error", "物品不存在");
    const item = shop.items.find((candidate) => candidate.uuid === itemUuid);
    const unitPrice = Math.floor(Number(data?.unitPrice));
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) return shopFail(socket, "playerShop:updateItem:error", "单价必须为大于等于 1 的整数");
    item.unitPrice = unitPrice;
    item.comment = typeof data?.comment === "string" ? data.comment.slice(0, 200) : item.comment;
    const perPlayerDailyLimit = Math.max(0, Math.floor(Number(data?.perPlayerDailyLimit) || 0));
    item.perPlayerDailyLimit = perPlayerDailyLimit;
    item.perPlayerLimitIntervalDays = perPlayerDailyLimit > 0
      ? Math.max(1, Math.min(30, Math.floor(Number(data?.perPlayerLimitIntervalDays) || 1)))
      : 1;
    schedulePersist();
    emitGameEvent(socket, "playerShop:updateItem:success", { item: shopItemView({ ...item, sellerUuid: shop.owner }, player) });
    return true;
  }
  if (event === "playerShop:update") {
    const shop = myShops().find((candidate) => candidate.uuid === String(data?.shopUuid || ""));
    if (!shop) return shopFail(socket, "playerShop:update:error", "店铺不存在");
    if (typeof data?.name === "string" && data.name.trim()) shop.name = data.name.trim();
    if (typeof data?.description === "string") shop.description = data.description.slice(0, 200);
    if (data?.visibility === "PRIVATE" || data?.visibility === "PUBLIC") shop.visibility = data.visibility;
    schedulePersist();
    emitGameEvent(socket, "playerShop:update:success", { shop: shopView(shop) });
    return true;
  }
  if (event === "playerShop:renew") {
    const shop = myShops().find((candidate) => candidate.uuid === String(data?.shopUuid || ""));
    if (!shop) return shopFail(socket, "playerShop:renew:error", "店铺不存在");
    const days = Math.max(1, Math.min(30, Math.floor(Number(data?.days) || PLAYER_SHOP_DAYS)));
    const base = Math.max(Date.now(), Date.parse(shop.expiresAt));
    shop.expiresAt = new Date(base + days * 86400000).toISOString();
    schedulePersist();
    emitGameEvent(socket, "playerShop:renew:success", { shop: shopView(shop) });
    return true;
  }
  if (event === "playerShop:buy") {
    const itemUuid = String(data?.itemUuid || "");
    const shop = shopState.shops.find((candidate) => (candidate.items || []).some((item) => item.uuid === itemUuid));
    if (!shop || (shop.visibility || "PUBLIC") !== "PUBLIC" || Date.parse(shop.expiresAt) <= Date.now()) return shopFail(socket, "playerShop:buy:error", "物品不存在或已下架");
    if (shop.owner === player.uuid) return shopFail(socket, "playerShop:buy:error", "不能购买自己店铺的物品");
    const item = shop.items.find((candidate) => candidate.uuid === itemUuid);
    const seller = players.get(shop.owner);
    if (!seller) return shopFail(socket, "playerShop:buy:error", "店主不存在");
    const availableCount = shopItemView(item, seller).availableCount;
    const count = Math.floor(Number(data?.count) || 1);
    if (!Number.isSafeInteger(count) || count < 1) return shopFail(socket, "playerShop:buy:error", "购买数量不正确");
    if (availableCount < count) return shopFail(socket, "playerShop:buy:error", "库存不足");
    if (item.perPlayerDailyLimit > 0) {
      const intervalDays = Math.max(1, Math.min(30, Math.floor(Number(item.perPlayerLimitIntervalDays) || 1)));
      const cutoff = Date.now() - intervalDays * 86400000;
      const purchased = shopState.purchases
        .filter((entry) => entry.buyerUuid === player.uuid && entry.itemUuid === itemUuid && Date.parse(entry.createdAt) >= cutoff)
        .reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.count) || 0)), 0);
      if (purchased + count > item.perPlayerDailyLimit) return shopFail(socket, "playerShop:buy:error", `每 ${intervalDays} 天最多购买 ${item.perPlayerDailyLimit} 件`);
    }
    const total = item.unitPrice * count;
    if (!Number.isSafeInteger(total) || total < 1) return shopFail(socket, "playerShop:buy:error", "商品价格不正确");
    if (getAssetCount(player, PLAYER_SHOP_CURRENCY_ID) < total) return shopFail(socket, "playerShop:buy:error", "猫爪币不足");
    removeAsset(player, PLAYER_SHOP_CURRENCY_ID, total);
    removeAsset(seller, item.resourceId, count);
    addAsset(player, item.resourceId, count);
    addAsset(seller, PLAYER_SHOP_CURRENCY_ID, total);
    item.soldCount = Math.max(0, Math.floor(Number(item.soldCount) || 0)) + count;
    item.remaining = Math.max(0, getAssetCount(seller, item.resourceId) - Math.max(0, Math.floor(Number(item.inventoryRemainingCount) || 0)));
    shopState.purchases.push({
      uuid: crypto.randomUUID(),
      itemUuid,
      buyerUuid: player.uuid,
      sellerUuid: shop.owner,
      shopUuid: shop.uuid,
      resourceId: item.resourceId,
      count,
      unitPrice: item.unitPrice,
      total,
      createdAt: new Date().toISOString()
    });
    if (shopState.purchases.length > 2000) shopState.purchases.splice(0, shopState.purchases.length - 2000);
    schedulePersist();
    emitGameEvent(socket, "playerShop:buy:success", { itemUuid, buyCount: count, count, totalCost: total, total });
    return true;
  }
  if (event === "playerShop:purchaseList") {
    const itemUuid = String(data?.itemUuid || "");
    const ownedItem = itemUuid && myShops().some((shop) => (shop.items || []).some((item) => item.uuid === itemUuid));
    const page = Math.max(1, Math.floor(Number(data?.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(data?.pageSize) || 10)));
    const all = (ownedItem
      ? shopState.purchases.filter((entry) => entry.itemUuid === itemUuid)
      : shopState.purchases.filter((entry) => entry.buyerUuid === player.uuid))
      .slice().reverse()
      .map((entry) => ({ ...entry, currencyResourceId: PLAYER_SHOP_CURRENCY_ID }));
    emitGameEvent(socket, "playerShop:purchaseList:success", {
      records: all.slice((page - 1) * pageSize, page * pageSize),
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize
    });
    return true;
  }
  if (event === "playerShop:pin") {
    pruneShopPins();
    const shopUuid = String(data?.shopUuid || "");
    const shop = myShops().find((candidate) => candidate.uuid === shopUuid);
    if (!shop) return shopFail(socket, "playerShop:pin:error", "店铺不存在或不属于你");
    if ((shop.visibility || "PUBLIC") !== "PUBLIC" || Date.parse(shop.expiresAt) <= Date.now()) return shopFail(socket, "playerShop:pin:error", "只有营业中的公开店铺可以置顶");
    if (shopState.pins[shopUuid]) return shopFail(socket, "playerShop:pin:error", "店铺已在置顶中");
    const cooldown = Number(shopState.pinCooldowns[player.uuid]) || 0;
    if (cooldown > Date.now()) return shopFail(socket, "playerShop:pin:error", "置顶服务仍在冷却中");
    const current = pinnedShopList();
    if (current.length >= PLAYER_SHOP_MAX_GLOBAL_PINS) return shopFail(socket, "playerShop:pin:error", "当前置顶名额已满");
    if (getAssetCount(player, "playerShopPinnedLicense") < 1) return shopFail(socket, "playerShop:pin:error", "缺少店铺置顶许可");
    removeAsset(player, "playerShopPinnedLicense", 1);
    const expiresAt = Date.now() + PLAYER_SHOP_PIN_MS;
    shopState.pins[shopUuid] = expiresAt;
    shopState.pinCooldowns[player.uuid] = Date.now() + PLAYER_SHOP_PIN_COOLDOWN_MS;
    schedulePersist();
    emitGameEvent(socket, "playerShop:pin:success", { shopUuid, expiresAt: new Date(expiresAt).toISOString(), pinned: pinnedShopList() });
    return true;
  }
  if (event === "playerShop:unpin") {
    const shopUuid = String(data?.shopUuid || "");
    const shop = myShops().find((candidate) => candidate.uuid === shopUuid);
    if (!shop) return shopFail(socket, "playerShop:unpin:error", "店铺不存在或不属于你");
    if (!shopState.pins[shopUuid]) return shopFail(socket, "playerShop:unpin:error", "店铺没有置顶");
    delete shopState.pins[shopUuid];
    schedulePersist();
    emitGameEvent(socket, "playerShop:unpin:success", { shopUuid, pinned: pinnedShopList() });
    return true;
  }
  if (event === "playerShop:expandItemSlots") {
    const shop = myShops()[0];
    if (!shop) return shopFail(socket, "playerShop:expandItemSlots:error", "请先开设店铺");
    const current = Math.max(0, Math.min(PLAYER_SHOP_MAX_EXTRA_ITEMS, Math.floor(Number(shop.extraItemSlots) || 0)));
    if (current >= PLAYER_SHOP_MAX_EXTRA_ITEMS) return shopFail(socket, "playerShop:expandItemSlots:error", "店铺栏位已扩展至上限");
    const schemeId = String(data?.schemeId || "");
    if (!PLAYER_SHOP_SCHEME_IDS.includes(schemeId)) return shopFail(socket, "playerShop:expandItemSlots:error", "扩展方案不正确");
    shop.schemeUsage ||= { default: 0, fast: 0 };
    const schemeUseCount = Math.max(0, Math.floor(Number(shop.schemeUsage[schemeId]) || 0));
    if (schemeId === "default" && schemeUseCount >= PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES) return shopFail(socket, "playerShop:expandItemSlots:error", "方案A的可用次数已用尽");
    const costs = schemeId === "fast"
      ? [{ id: "playerShopCapacityUpgrade", count: 1 }]
      : [
          { id: "gold", count: 10000000 + 10000000 * schemeUseCount },
          { id: "catPawCoin", count: 50 + 25 * schemeUseCount },
          { id: "catPawStamp", count: 50 + 25 * schemeUseCount },
          { id: "genesisEssence", count: 5 + schemeUseCount }
        ];
    if (costs.some((cost) => getAssetCount(player, cost.id) < cost.count)) return shopFail(socket, "playerShop:expandItemSlots:error", "扩展所需资源不足");
    for (const cost of costs) removeAsset(player, cost.id, cost.count);
    shop.extraItemSlots = current + 1;
    shop.schemeUsage[schemeId] = schemeUseCount + 1;
    const atCapacity = shop.extraItemSlots >= PLAYER_SHOP_MAX_EXTRA_ITEMS;
    const allowedSchemes = atCapacity
      ? []
      : [shop.schemeUsage.default < PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES ? "default" : null, "fast"].filter(Boolean);
    schedulePersist();
    emitGameEvent(socket, "playerShop:expandItemSlots:success", {
      maxSlots: shopCapacity(shop),
      maxItemsPerShop: shopCapacity(shop),
      extra: shop.extraItemSlots,
      extraSeller: shop.extraItemSlots,
      allowedSchemes,
      schemeUsage: { default: shop.schemeUsage.default, fast: shop.schemeUsage.fast },
      schemeRemaining: {
        default: Math.max(0, PLAYER_SHOP_DEFAULT_SCHEME_MAX_USES - shop.schemeUsage.default),
        fast: atCapacity ? 0 : "infinity"
      }
    });
    return true;
  }
  return false;
}

// 交互式垂钓尚未实现完整的鱼获、打窝、出售与持久化事务。
// 在完整模块交付前，所有前端会发出的垂钓请求都明确失败，不能用临时在线状态伪装成功。
const UNSUPPORTED_FISHING_EVENTS = new Set([
  "fishing:start",
  "fishing:nearby:get",
  "fishing:myActive:get",
  "fishing:end",
  "fishing:catches:get",
  "fishing:sessions:get",
  "fishing:baitAreas:get",
  "fishing:myBaitAreas:get",
  "fishing:myCatches:get",
  "fishing:leaderboard:get",
  "fishing:shout:send",
  "fishing:sell",
  "fishing:sell:batch"
]);

function handleFishingEvent(socket, event) {
  if (!UNSUPPORTED_FISHING_EVENTS.has(event)) return false;
  return emitUnsupportedFeature(socket, event, "interactiveFishing", "fail", "交互式垂钓尚未实现");
}

function outfitTypeOf(value) {
  return value === "battle" || value === "work" ? value : null;
}

const OUTFIT_ACTION_LIMIT = 100;

function validateOutfitActionIds(raw) {
  if (!Array.isArray(raw)) return { actionIdList: [] };
  const result = [];
  const seen = new Set();
  for (const value of raw) {
    const actionId = typeof value === "string" ? value.trim() : "";
    if (!actionId || !taskActionExists(actionId)) return { error: `配装包含无效动作：${actionId || "(空)"}` };
    if (seen.has(actionId)) continue;
    seen.add(actionId);
    result.push(actionId);
    if (result.length > OUTFIT_ACTION_LIMIT) return { error: `配装动作最多 ${OUTFIT_ACTION_LIMIT} 项` };
  }
  return { actionIdList: result };
}

function validateOutfitEquipment(type, rawEquipment) {
  if (!rawEquipment || typeof rawEquipment !== "object" || Array.isArray(rawEquipment)) return { error: "配装数据无效" };
  const equipment = {};
  for (const [slot, value] of Object.entries(rawEquipment)) {
    const resourceId = typeof value === "string" ? value.trim() : "";
    if (!EQUIPMENT_SLOT_IDS.includes(slot)) return { error: `未知装备槽：${slot}` };
    const item = resourceCatalog[resourceId];
    if (!item?.equipPart) return { error: `配装包含无效装备：${resourceId || "(空)"}` };
    const equipmentTypes = Array.isArray(item.equipmentType) ? item.equipmentType : [];
    if (!equipmentTypes.includes(type)) return { error: `装备 ${resourceId} 不能放入${type === "battle" ? "战斗" : "生活"}配装` };
    if (resolveEquipmentSlot(item, equipment, slot) !== slot) return { error: `装备 ${resourceId} 与槽位 ${slot} 不匹配` };
    equipment[slot] = resourceId;
  }
  return { equipment };
}

function applyOutfitEquipment(player, type, desiredEquipment) {
  const key = type === "battle" ? "battleEquipment" : "workEquipment";
  const current = player[key] && typeof player[key] === "object" && !Array.isArray(player[key]) ? player[key] : {};
  const currentCounts = new Map();
  const desiredCounts = new Map();
  for (const resourceId of Object.values(current)) currentCounts.set(resourceId, (currentCounts.get(resourceId) || 0) + 1);
  for (const resourceId of Object.values(desiredEquipment)) desiredCounts.set(resourceId, (desiredCounts.get(resourceId) || 0) + 1);
  for (const [resourceId, desiredCount] of desiredCounts) {
    const need = Math.max(0, desiredCount - (currentCounts.get(resourceId) || 0));
    if (getAssetCount(player, resourceId) < need) return { error: `背包中缺少装备：${resourceId}` };
  }
  for (const [resourceId, currentCount] of currentCounts) {
    const release = Math.max(0, currentCount - (desiredCounts.get(resourceId) || 0));
    if (release) addAsset(player, resourceId, release);
  }
  for (const [resourceId, desiredCount] of desiredCounts) {
    const need = Math.max(0, desiredCount - (currentCounts.get(resourceId) || 0));
    if (need && !removeAsset(player, resourceId, need)) return { error: `背包中缺少装备：${resourceId}` };
  }
  player[key] = structuredClone(desiredEquipment);
  return { equipment: player[key] };
}

function applyOutfitActions(player, actionIdList) {
  const validated = validateOutfitActionIds(actionIdList);
  if (validated.error || !validated.actionIdList.length) return false;
  const now = Date.now();
  player.taskQueue = validated.actionIdList.map((actionId, index) => makeTask({ actionId, repeatCount: 1, createTime: now + index }, player));
  stopTaskRunner(player);
  return true;
}

function handleOutfitEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  player.outfits ||= [];
  const fail = (name, message) => {
    emitGameEvent(socket, name, { message });
    return true;
  };
  const emitAll = () => emitGameEvent(socket, "outfit:list:success", { outfits: player.outfits });
  if (event === "outfit:getAll") {
    emitAll();
    return true;
  }
  if (event === "outfit:create") {
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    if (!name) return fail("outfit:create:fail", "请填写套装名称");
    if ([...name].length > 12) return fail("outfit:create:fail", "套装名称最多12个字");
    if (player.outfits.length >= 20) return fail("outfit:create:fail", "最多保存 20 套配装");
    const type = outfitTypeOf(data?.type);
    if (!type) return fail("outfit:create:fail", "装备栏类型无效");
    const sourceEquipment = (type === "battle" ? player.battleEquipment : player.workEquipment) || {};
    const validated = validateOutfitEquipment(type, sourceEquipment);
    if (validated.error) return fail("outfit:create:fail", validated.error);
    const actions = validateOutfitActionIds(data?.actionIdList);
    if (actions.error) return fail("outfit:create:fail", actions.error);
    const now = new Date().toISOString();
    const outfit = {
      uuid: crypto.randomUUID(),
      name,
      type,
      // 创建时按当前已穿装备生成快照，避免空套装被应用后把角色扒光
      equipment: structuredClone(validated.equipment),
      actionIdList: actions.actionIdList,
      createdAt: now,
      updatedAt: now
    };
    player.outfits.push(outfit);
    schedulePersist();
    emitGameEvent(socket, "outfit:create:success", { outfit });
    emitAll();
    return true;
  }
  if (event === "outfit:update") {
    const outfit = player.outfits.find((candidate) => candidate.uuid === String(data?.outfitUuid || ""));
    if (!outfit) return fail("outfit:update:fail", "配装不存在");
    const type = outfitTypeOf(outfit.type);
    if (!type) return fail("outfit:update:fail", "装备栏类型无效");
    const patch = data?.equipment && typeof data.equipment === "object" && !Array.isArray(data.equipment) ? data.equipment : {};
    const sourceEquipment = (type === "battle" ? player.battleEquipment : player.workEquipment) || {};
    const updatedEquipment = validateOutfitEquipment(type, sourceEquipment);
    if (updatedEquipment.error) return fail("outfit:update:fail", updatedEquipment.error);
    let updatedActions;
    if (Array.isArray(data?.actionIdList)) {
      updatedActions = validateOutfitActionIds(data.actionIdList);
      if (updatedActions.error) return fail("outfit:update:fail", updatedActions.error);
    }
    if (typeof patch.name === "string" && patch.name.trim()) {
      if ([...patch.name.trim()].length > 12) return fail("outfit:update:fail", "套装名称最多12个字");
      outfit.name = patch.name.trim();
    }
    outfit.equipment = structuredClone(updatedEquipment.equipment);
    if (updatedActions) outfit.actionIdList = updatedActions.actionIdList;
    outfit.updatedAt = new Date().toISOString();
    schedulePersist();
    emitGameEvent(socket, "outfit:update:success", { outfit });
    emitAll();
    return true;
  }
  if (event === "outfit:delete") {
    const uuid = String(data?.outfitUuid || "");
    const before = player.outfits.length;
    player.outfits = player.outfits.filter((candidate) => candidate.uuid !== uuid);
    if (player.outfits.length === before) return fail("outfit:delete:fail", "配装不存在");
    schedulePersist();
    emitGameEvent(socket, "outfit:delete:success", { outfitUuid: uuid });
    emitAll();
    return true;
  }
  if (event === "outfit:apply") {
    const outfit = player.outfits.find((candidate) => candidate.uuid === String(data?.outfitUuid || ""));
    if (!outfit) return fail("outfit:apply:fail", "配装不存在");
    const type = outfitTypeOf(outfit.type);
    if (!type) return fail("outfit:apply:fail", "装备栏类型无效");
    const actionValidation = validateOutfitActionIds(outfit.actionIdList);
    if (actionValidation.error) return fail("outfit:apply:fail", actionValidation.error);
    const validated = validateOutfitEquipment(type, outfit.equipment || {});
    if (validated.error) return fail("outfit:apply:fail", validated.error);
    if (type === "battle") {
      const { disabled } = battleSlotState(skillTreeCatalog, player.skillTree || {});
      const blockedSlot = Object.keys(validated.equipment).find((slot) => disabled.includes(slot));
      if (blockedSlot) return fail("outfit:apply:fail", `槽位 ${blockedSlot} 尚未解锁或已被专精禁用`);
    }
    const applied = applyOutfitEquipment(player, type, validated.equipment);
    if (applied.error) return fail("outfit:apply:fail", applied.error);
    const actionsApplied = applyOutfitActions(player, actionValidation.actionIdList);
    if (type === "work") refreshWorkTaskDurations(player);
    schedulePersist();
    emitGameEvent(socket, `character:getEquipment:${type}:success`, applied.equipment);
    emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
    emitGameEvent(socket, "inventoryUpdated", player.inventory);
    emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(player).status);
    if (type === "work") emitGameEvent(socket, "characterInitData", { data: characterInitData(player) });
    if (actionsApplied) {
      emitGameEvent(socket, "needResetCurrentActionProgress", null);
      dispatchTaskQueue(socket);
      startTaskRunner(socket);
    }
    emitGameEvent(socket, "outfit:apply:success", {
      outfitUuid: outfit.uuid,
      type,
      equipment: applied.equipment,
      actionIdList: actionValidation.actionIdList
    });
    return true;
  }
  return false;
}

function publicOtherCharacterInfo(player) {
  const guild = guildForPlayer(player.uuid);
  const membership = guildMember(guild, player.uuid);
  const skills = playerSkills(player).map((entry) => ({
    skillId: entry.skillId,
    level: entry.level,
    enabled: entry.enabled,
    order: entry.order,
    logic: structuredClone(entry.logic || [])
  }));
  const kittiesInfo = (Array.isArray(player.kitty) ? player.kitty : []).map((kitty) => ({
    kitty: {
      uuid: kitty?.uuid || kitty?.id || "",
      name: typeof kitty?.name === "string" ? kitty.name : "小猫咪",
      avatar: kitty?.avatar || null
    },
    currentActionId: typeof kitty?.currentActionId === "string" ? kitty.currentActionId : null
  }));
  return {
    playerInfo: {
      base: {
        uuid: player.uuid,
        name: player.name,
        avatar: player.avatar,
        title: player.title ?? null,
        hName: [],
        guild: guild?.uuid || null,
        guildTitle: guild?.titles?.find((title) => title.uuid === membership?.titleUuid)?.title || null,
        createDate: player.createdAt,
        lastOnlineDate: null,
        style: publicStyleView(player),
        effect: {}
      },
      status: statusDetailFor(player),
      skills
    },
    currentActionId: typeof player.taskQueue?.[0]?.actionId === "string" ? player.taskQueue[0].actionId : null,
    kittiesInfo
  };
}

function eventResult(event, player, payload) {
  const data = payload?.data ?? payload ?? {};
  if (event === "character:getProfile") {
    const targetUuid = typeof data?.characterUuid === "string" ? data.characterUuid.trim() : "";
    const target = targetUuid ? players.get(targetUuid) : player;
    return target ? publicProfileView(target, player.uuid) : undefined;
  }
  if (event === "character:getInfo") {
    const targetUuid = typeof data?.characterUuid === "string" ? data.characterUuid.trim() : "";
    const target = targetUuid ? players.get(targetUuid) : player;
    return target ? publicOtherCharacterInfo(target) : undefined;
  }
  if (event === "character:getOtherPlayerEquipment" || event === "character:getOtherPlayerWorkEquipment") {
    const targetUuid = typeof data?.characterUuid === "string" ? data.characterUuid.trim() : "";
    const target = targetUuid && players.get(targetUuid);
    if (!target) return undefined;
    const equipment = event === "character:getOtherPlayerEquipment" ? target.battleEquipment : target.workEquipment;
    return structuredClone(equipment && typeof equipment === "object" && !Array.isArray(equipment) ? equipment : {});
  }
  if (event === "character:getGameState") return { resources: player.resources, inventory: player.inventory, taskQueue: player.taskQueue };
  if (event === "character:getEquipment") return data.type === "battle" ? player.battleEquipment : player.workEquipment;
  if (event === "character:getSkills") return playerSkills(player);
  if (event === "getTaskQueue") return player.taskQueue;
  if (event === "kitty:getAll") return player.kitty;
  if (event === "uniqueFlag:all") return { flags: player.uniqueFlag || [] };
  // 未知或尚未实现的事件不能伪装成成功：undefined 表示没有通用成功处理器认领。
  return undefined;
}

io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie).maomao_session;
  const session = token && sessions.get(token);
  socket.player = session ? players.get(session.uuid) || null : getLocalRecoveryPlayer();
  next();
});

// ---- 属性面板明细（statusDetail）----
// 前端 StatusCard（角色→属性）的契约（index-CnYosZ2K.js 约 825500 起）：
//   statusDetail = { level, currentExp, final, fromWorkEquipment, fromEquipment,
//                    fromSkillTreeNode, fromAffix, fromTitle{}, fromInactiveTitle{}, fromOther{} }
//   a = final ?? level                      → 主卡显示 Lv.a
//   final !== level 时额外显示 `(level +N)` → 绿/红
//   「详细信息」按字段名逐行：基础等级 / 生活装备 / 战斗装备 / 专精 / 祝福 / 称号 / 其他加成
// 只发 {level, currentExp} 的话这些分支永远进不去，玩家看到的就是「穿了装备属性没变」。
// 注意：这里只算「显示值」，战斗内仍然是 makeBattleUnit() 自己叠 equipmentEffects，别让它读这份。
function statusDetailFor(player) {
  const base = getPlayerStatus(player);
  const battleBonus = equipmentEffects(player, "battle").bonus;
  const workBonus = equipmentEffects(player, "work").bonus;
  const treeBonus = skillTreeStatusBonusFor(player);
  const detail = {};
  for (const key of statusKeys) {
    const entry = base[key];
    const fromEquipment = Number(battleBonus[key]) || 0;
    const fromWorkEquipment = Number(workBonus[key]) || 0;
    const fromSkillTreeNode = Number(treeBonus[key]) || 0;
    // 和战斗内一致：属性最低 1，装备的负数（铁甲衣 dexterity-2）不能把面板顶成负数
    const final = Math.max(1, roundOneDecimal(entry.level + fromEquipment + fromWorkEquipment + fromSkillTreeNode));
    const row = { level: entry.level, currentExp: entry.currentExp, final };
    // 为 0 的字段不发：前端用 `statusDetail.fromEquipment ? ...` 判断是否渲染该行
    if (fromWorkEquipment) row.fromWorkEquipment = roundOneDecimal(fromWorkEquipment);
    if (fromEquipment) row.fromEquipment = roundOneDecimal(fromEquipment);
    if (fromSkillTreeNode) row.fromSkillTreeNode = roundOneDecimal(fromSkillTreeNode);
    detail[key] = row;
  }
  return detail;
}

// ---- 专精（技能树）----
// 规则（游戏内说明）：每 15 级生活等级给 1 点（交易、强化不计），每 7 级战斗等级给 1 点。
// 前端只认 summary 里的 nodeLevels / unmetReasons / canAllocate / available 等字段，
// 加点本身必须由后端校验前置与消耗，否则界面点了也不会落盘。
const SKILL_TREE_BATTLE_STATUSES = ["battle", "attacking", "defencing", "strength", "dexterity", "intelligence", "stamina"];
const SKILL_TREE_LIFE_STATUSES = statusKeys.filter(
  (key) => !SKILL_TREE_BATTLE_STATUSES.includes(key) && key !== "trading" && key !== "enhance"
);

function skillTreeNode(treeId, nodeId) {
  return skillTreeCatalog.trees[treeId]?.byId?.[nodeId] || null;
}

function skillTreeLevels(player, treeId) {
  if (!player.skillTree || typeof player.skillTree !== "object" || Array.isArray(player.skillTree)) player.skillTree = {};
  const tree = skillTreeCatalog.trees[treeId];
  const levels = player.skillTree[treeId];
  if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
    player.skillTree[treeId] = {};
    return player.skillTree[treeId];
  }
  if (!tree) return levels;
  for (const [nodeId, rawLevel] of Object.entries(levels)) {
    const node = tree.byId[nodeId];
    const level = Math.max(0, Math.min(node?.maxLevel ?? 0, Math.floor(Number(rawLevel) || 0)));
    if (!node || level <= 0) delete levels[nodeId];
    else levels[nodeId] = level;
  }
  return levels;
}

function skillTreeSpent(tree, levels) {
  let spent = 0;
  for (const [nodeId, level] of Object.entries(levels)) {
    const node = tree.byId[nodeId];
    if (!node) continue;
    for (let i = 0; i < level; i += 1) spent += nodeCost(node, i);
  }
  return spent;
}

function skillTreePointPool(player, treeId) {
  const baseLevels = getPlayerStatus(player);
  const keys = treeId === "battle" ? SKILL_TREE_BATTLE_STATUSES : SKILL_TREE_LIFE_STATUSES;
  const totalLevels = keys.reduce((sum, key) => sum + (Number(baseLevels[key]?.level) || 0), 0);
  const perPoint = treeId === "battle" ? 7 : 15;
  const formulaEarned = Math.floor(totalLevels / perPoint);
  const bonusEarned = Math.max(0, Math.floor(Number(player.skillTreeBonus?.[treeId]) || 0));
  return { formulaEarned, bonusEarned, totalEarned: formulaEarned + bonusEarned, totalLevels };
}

function skillTreeUnmetReasons(treeId, levels, node, nextLevel) {
  const reasons = [];
  for (const requirement of nodeRequirements(node, nextLevel)) {
    if (requirement?.type === "nodeLevel") {
      const required = Math.max(1, Math.floor(Number(requirement.level) || 1));
      const current = Math.max(0, Math.floor(Number(levels[requirement.nodeId]) || 0));
      if (current < required) {
        const name = skillTreeNode(treeId, requirement.nodeId)?.name || requirement.nodeId;
        reasons.push(`需要「${name}」达到 ${required} 级（当前 ${current} 级）`);
      }
    } else if (requirement?.type === "notWith") {
      const current = Math.max(0, Math.floor(Number(levels[requirement.nodeId]) || 0));
      if (current > 0) {
        const name = skillTreeNode(treeId, requirement.nodeId)?.name || requirement.nodeId;
        reasons.push(`与「${name}」互斥`);
      }
    }
  }
  return reasons;
}

function skillTreeSummary(player, treeId) {
  const tree = skillTreeCatalog.trees[treeId];
  if (!tree) return null;
  const levels = skillTreeLevels(player, treeId);
  const pool = skillTreePointPool(player, treeId);
  const effectiveSpent = skillTreeSpent(tree, levels);
  const available = Math.max(0, pool.totalEarned - effectiveSpent);
  const nodeLevels = {};
  const unmetReasons = {};
  const canAllocate = {};
  for (const node of tree.nodes) {
    const level = Math.max(0, Math.min(node.maxLevel, Math.floor(Number(levels[node.id]) || 0)));
    nodeLevels[node.id] = level;
    if (level >= node.maxLevel) {
      unmetReasons[node.id] = [];
      canAllocate[node.id] = false;
      continue;
    }
    const reasons = skillTreeUnmetReasons(treeId, levels, node, level + 1);
    unmetReasons[node.id] = reasons;
    canAllocate[node.id] = reasons.length === 0 && available >= nodeCost(node, level);
  }
  return {
    treeId,
    nodeLevels,
    unmetReasons,
    canAllocate,
    available,
    effectiveSpent,
    formulaEarned: pool.formulaEarned,
    bonusEarned: pool.bonusEarned,
    totalEarned: pool.totalEarned,
    totalLevels: pool.totalLevels
  };
}

function skillTreeLearned(player) {
  const learned = [];
  for (const treeId of Object.keys(skillTreeCatalog.trees)) {
    const levels = skillTreeLevels(player, treeId);
    for (const [nodeId, level] of Object.entries(levels)) {
      if (level > 0) learned.push({ nodeId, treeId, level });
    }
  }
  return learned;
}

function skillTreeStatusBonusFor(player) {
  return skillTreeStatusBonus(skillTreeCatalog.trees, player.skillTree || {});
}

// 「弃臂/弃身/舍辅」这类节点会禁用部位：禁用后该槽位上的装备要直接卸回背包，
// 否则界面显示已禁用、装备却还挂在身上。
function sanitizeDisabledBattleEquipment(player) {
  const { disabled } = battleSlotState(skillTreeCatalog, player.skillTree || {});
  if (!disabled.length) return [];
  if (!player.battleEquipment || typeof player.battleEquipment !== "object") return [];
  const removed = [];
  for (const slot of disabled) {
    const resourceId = player.battleEquipment[slot];
    if (!resourceId) continue;
    delete player.battleEquipment[slot];
    addAsset(player, resourceId, 1);
    removed.push({ slot, resourceId });
  }
  if (removed.length) schedulePersist();
  return removed;
}

function handleSkillTreeEvent(socket, event, data) {
  const player = socket.player;
  if (event === "skillTree:summary") {
    const treeId = String(data?.treeId || "");
    const summary = skillTreeSummary(player, treeId);
    if (!summary) {
      emitGameEvent(socket, "skillTree:summary:fail", { treeId, msg: "技能树不存在" });
      return true;
    }
    emitGameEvent(socket, "skillTree:summary:success", { treeId, summary });
    return true;
  }
  if (event === "skillTree:learned") {
    emitGameEvent(socket, "skillTree:learned:success", { learned: skillTreeLearned(player) });
    return true;
  }
  if (event === "skillTree:allocate") {
    const treeId = String(data?.treeId || "");
    const nodeId = String(data?.nodeId || "");
    const tree = skillTreeCatalog.trees[treeId];
    const node = tree?.byId?.[nodeId];
    if (!tree || !node) {
      emitGameEvent(socket, "skillTree:allocate:fail", { treeId, msg: "节点不存在" });
      return true;
    }
    const levels = skillTreeLevels(player, treeId);
    const level = Math.max(0, Math.floor(Number(levels[nodeId]) || 0));
    if (level >= node.maxLevel) {
      emitGameEvent(socket, "skillTree:allocate:fail", { treeId, msg: "该节点已达到最高等级" });
      return true;
    }
    const summary = skillTreeSummary(player, treeId);
    const reasons = summary.unmetReasons[nodeId] || [];
    if (reasons.length) {
      emitGameEvent(socket, "skillTree:allocate:fail", { treeId, msg: reasons[0] });
      return true;
    }
    const cost = nodeCost(node, level);
    if (summary.available < cost) {
      emitGameEvent(socket, "skillTree:allocate:fail", {
        treeId,
        msg: `专精点不足（需要 ${cost}，可用 ${summary.available}）`
      });
      return true;
    }
    levels[nodeId] = level + 1;
    schedulePersist();
    const removed = sanitizeDisabledBattleEquipment(player);
    emitGameEvent(socket, "skillTree:summary:success", { treeId, summary: skillTreeSummary(player, treeId) });
    // 专精会解锁 / 禁用战斗装备槽，装备与属性面板都要跟着刷新
    if (removed.length) {
      emitGameEvent(socket, "character:getEquipment:battle:success", player.battleEquipment);
      emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
      emitGameEvent(socket, "inventoryUpdated", player.inventory);
    }
    emitGameEvent(socket, "skillTree:learned:success", { learned: skillTreeLearned(player) });
    emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(player).status);
    return true;
  }
  if (event === "skillTree:reset") {
    const treeId = String(data?.treeId || "");
    if (!skillTreeCatalog.trees[treeId]) {
      emitGameEvent(socket, "skillTree:reset:fail", { treeId, msg: "技能树不存在" });
      return true;
    }
    player.skillTree = player.skillTree || {};
    player.skillTree[treeId] = {};
    schedulePersist();
    const removed = sanitizeDisabledBattleEquipment(player);
    emitGameEvent(socket, "skillTree:reset:success", { treeId, summary: skillTreeSummary(player, treeId) });
    if (removed.length) {
      emitGameEvent(socket, "character:getEquipment:battle:success", player.battleEquipment);
      emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
      emitGameEvent(socket, "inventoryUpdated", player.inventory);
    }
    emitGameEvent(socket, "skillTree:learned:success", { learned: skillTreeLearned(player) });
    emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(player).status);
    return true;
  }
  return false;
}

// ---- 战斗技能配置（技能页）----
// 前端 store 是 characterBattleSkill，唯一的写入点是 character:getSkills:success
// （index-CnYosZ2K.js 约 475854 的 `XC(e => { _.value = e })`），且 sf() 的默认值是 []。
// 多处消费点直接 `(s.value || []).filter(...)` / `.find(e => e.skillId === t && e.enabled)`
// （知识王冠 860806、支配之印 878085、猫眼法杖 884666、影缠腰带 894389 等）
// → 下发必须是「数组」，元素 { skillId, level, exp, enabled, order, logic }。
// baseAttack 恒存在且不可禁用：前端 Base 卡片对 baseAttack 不渲染经验条、也不渲染启用/禁用按钮。
const SKILL_BASE_ID = "baseAttack";
// 技能书 → 技能 id。不能写白名单：资源表里带 onUse 的 *SkillBook 只有 12 本，
// 真正的大头（69 本战斗技能书）在 game-jresource 的怪物掉落表里（如 sweepSkillBook、
// summonBerryBirdSkillBook，掉率 1%~5%），硬编码会漏掉它们 —— 表现就是「用了没反应」，
// 书被扣掉但没有技能。凡是 `<skillId>SkillBook` 一律按「学会该技能」处理。
// lv1SkillBook~lv4SkillBook 是通用「一级/二级技能书」素材，不绑具体技能，不走这条。
function skillIdFromBook(itemId) {
  const id = String(itemId || "");
  if (!id.endsWith("SkillBook")) return null;
  const skillId = id.slice(0, -"SkillBook".length);
  if (!skillId || /^lv\d+$/i.test(skillId)) return null;
  return skillId;
}

// logic 是「条件组数组」：组间 OR、组内 AND，前端 LogicEditor 单组时会摊平成 [...conds]、
// 多组时是 [[...conds], ...]。后端不理解语义，只做深拷贝 + 尺寸上限，避免被塞爆存档。
const SKILL_LOGIC_MAX_BYTES = 20000;

function sanitizeSkillLogic(raw) {
  if (!Array.isArray(raw)) return [];
  try {
    const text = JSON.stringify(raw);
    if (text.length > SKILL_LOGIC_MAX_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 归一化：兼容老存档的 player.skills = { baseAttack: { level, order } } 对象形态。
// 返回值总是一个新数组，顺序即 order（baseAttack 排第 0 位，其余按原 order 升序重编号）。
function playerSkills(player) {
  const source = Array.isArray(player.skillList)
    ? player.skillList
    : player.skills && typeof player.skills === "object" && !Array.isArray(player.skills)
      ? Object.entries(player.skills).map(([skillId, entry]) => ({ skillId, ...(entry || {}) }))
      : [];
  const seen = new Set();
  const entries = [];
  for (const entry of source) {
    const skillId = typeof entry?.skillId === "string" ? entry.skillId.trim() : "";
    if (!skillId || seen.has(skillId)) continue;
    seen.add(skillId);
    entries.push({
      skillId,
      level: Math.max(1, Math.floor(Number(entry.level) || 1)),
      exp: Math.max(0, Number(entry.exp) || 0),
      // 缺 enabled 时按启用处理：老存档里已学会的技能不该突然变成「已禁用」
      enabled: entry.enabled !== false,
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : entries.length,
      logic: sanitizeSkillLogic(entry.logic) || []
    });
  }
  const base = entries.find((entry) => entry.skillId === SKILL_BASE_ID);
  if (!base) {
    // order -1 让它排在所有已有技能之前
    entries.push({ skillId: SKILL_BASE_ID, level: 1, exp: 0, enabled: true, order: -1, logic: [] });
  } else {
    base.enabled = true;
    base.level = Math.max(1, base.level);
  }
  // order 只用于前端排序和拖拽（前端拖拽列表里是「已启用」的全部技能，含 baseAttack，
  // 玩家把它拖到后面也允许），所以只按 order 升序重编号成 0..n-1，不钉死 baseAttack 的位置
  return entries
    .sort((left, right) => left.order - right.order)
    .map((entry, index) => ({ ...entry, order: index }));
}

// 写回：playerSkills 是纯函数（getSkills / characterInitData 会频繁调），落库走这里
function normalizePlayerSkills(player) {
  const list = playerSkills(player);
  player.skillList = list;
  if (player.skills !== undefined) delete player.skills;
  return list;
}

function findPlayerSkill(player, skillId) {
  if (!skillId) return null;
  return normalizePlayerSkills(player).find((entry) => entry.skillId === skillId) || null;
}

function skillOutfitsFor(player) {
  if (!Array.isArray(player.skillOutfits)) player.skillOutfits = [];
  return player.skillOutfits;
}

// 技能页上的「方案」卡片：{ uuid, name, data: [技能…] }，data 用和 getSkills 一样的形状，
// 前端 DK 组件只读 skillId / enabled / logic（index-CnYosZ2K.js 约 1090000）
function publicSkillOutfit(outfit) {
  return {
    uuid: outfit.uuid,
    name: outfit.name,
    data: (outfit.data || []).map((entry) => ({
      skillId: entry.skillId,
      level: entry.level,
      exp: entry.exp,
      enabled: !!entry.enabled,
      order: entry.order,
      logic: entry.logic || []
    })),
    createdAt: outfit.createdAt
  };
}

// 技能页的写操作。注意前端对这些事件只有 :success 的 toast 监听（QC/JC 只弹提示，
// 不写 store），唯一的状态更新通道是 character:getSkills:success 整包替换 → 每次写完都要重推。
// 返回 true 表示已处理（调用方不要再走 eventResult 兜底）。
function handleSkillConfigEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return false;
  const pushSkills = () => emitGameEvent(socket, "character:getSkills:success", normalizePlayerSkills(player));
  const pushOutfits = () => emitGameEvent(socket, "skillOutfit:list:success", { outfits: skillOutfitsFor(player).map(publicSkillOutfit) });
  const succeed = (payload) => {
    schedulePersist();
    pushSkills();
    emitGameEvent(socket, `${event}:success`, payload);
  };
  const fail = (message) => emitGameEvent(socket, `${event}:fail`, { message });

  if (event === "character:enableSkill" || event === "character:disableSkill") {
    const skillId = String(data?.skillId || "");
    const skill = findPlayerSkill(player, skillId);
    if (!skill) {
      fail("你还没有学会该技能");
      return true;
    }
    if (skillId === SKILL_BASE_ID) {
      fail("普通攻击不能禁用");
      return true;
    }
    skill.enabled = event === "character:enableSkill";
    succeed({ skillId, enabled: skill.enabled });
    return true;
  }

  if (event === "character:reorderSkill") {
    const order = Array.isArray(data?.skillOrder) ? data.skillOrder.map((item) => String(item)) : [];
    if (!order.length) {
      fail("技能顺序不能为空");
      return true;
    }
    const list = normalizePlayerSkills(player);
    const byId = new Map(list.map((entry) => [entry.skillId, entry]));
    const ranked = [];
    for (const skillId of order) {
      const skill = byId.get(skillId);
      if (skill && !ranked.includes(skill)) ranked.push(skill);
    }
    // 前端拖拽只提交「已启用」的技能，未启用的接在后面并保持原有相对顺序
    const merged = [...ranked, ...list.filter((entry) => !ranked.includes(entry))];
    player.skillList = merged.map((entry, index) => ({ ...entry, order: index }));
    succeed({ skillOrder: player.skillList.map((entry) => entry.skillId) });
    return true;
  }

  if (event === "character:updateSkillCastLogic") {
    const skillId = String(data?.skillId || "");
    const skill = findPlayerSkill(player, skillId);
    if (!skill) {
      fail("你还没有学会该技能");
      return true;
    }
    const logic = sanitizeSkillLogic(data?.logic);
    // 非数组要直接拒：sanitizeSkillLogic 对非数组返回 [] 是给老数据兜底用的，
    // 用在写路径上会把「传错类型」当成「清空逻辑」悄悄存下去
    if (!Array.isArray(data?.logic) || !logic) {
      fail("自动释放逻辑不合法或数据过大");
      return true;
    }
    skill.logic = logic;
    succeed({ skillId, logic });
    return true;
  }

  if (event === "character:copySkillLogic") {
    const replyCopyFail = (payload) => {
      emitGameEvent(socket, "character:copySkillLogic:fail", payload);
      return true;
    };
    const targetKey = String(data?.playerUuid || "").trim();
    const target = players.get(targetKey) || [...players.values()].find((item) => item.name === targetKey);
    if (!target) return replyCopyFail({ message: "找不到该玩家" });
    if (target.uuid === player.uuid) return replyCopyFail({ message: "不能复制自己的技能配置" });
    // 只复制「配置」（启用状态 / 顺序 / 自动释放逻辑）；等级和经验是各自的进度，不覆盖
    const source = playerSkills(target).filter((entry) => entry.skillId !== SKILL_BASE_ID);
    const own = new Map(normalizePlayerSkills(player).map((entry) => [entry.skillId, entry]));
    // 缺技能就整体不复制：前端拿到 missingSkills 会弹「缺失技能」列表，部分应用反而更难解释
    const missingSkills = source.filter((entry) => !own.has(entry.skillId)).map((entry) => entry.skillId);
    if (missingSkills.length) return replyCopyFail({ message: "以下技能你还没有学会", missingSkills });
    for (const entry of source) {
      const skill = own.get(entry.skillId);
      skill.enabled = entry.enabled;
      skill.order = entry.order;
      skill.logic = structuredClone(entry.logic || []);
    }
    player.skillList = [...own.values()].map((entry, index) => ({ ...entry, order: index }));
    schedulePersist();
    pushSkills();
    emitGameEvent(socket, "character:copySkillLogic:success", {});
    return true;
  }

  if (event === "skillOutfit:list") {
    pushOutfits();
    return true;
  }

  if (event === "skillOutfit:saveCurrent") {
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    const failSave = (message) => {
      emitGameEvent(socket, "skillOutfit:saveCurrent:fail", { message });
      return true;
    };
    if (!name || name.length > 12) return failSave("方案名称需为 1~12 个字符");
    const outfits = skillOutfitsFor(player);
    const snapshot = normalizePlayerSkills(player).map((entry) => ({ ...entry, logic: structuredClone(entry.logic || []) }));
    const now = new Date().toISOString();
    let outfit = outfits.find((item) => item.name === name);
    if (outfit) {
      // 同名直接覆盖：前端只给了名字，没有「重命名」入口，同名当更新更符合直觉
      outfit.data = snapshot;
      outfit.updatedAt = now;
    } else {
      if (outfits.length >= 20) return failSave("技能配置方案最多 20 个");
      outfit = { uuid: crypto.randomUUID(), name, data: snapshot, createdAt: now, updatedAt: now };
      outfits.push(outfit);
    }
    schedulePersist();
    emitGameEvent(socket, "skillOutfit:saveCurrent:success", { outfit: publicSkillOutfit(outfit) });
    // 方案列表组件只在挂载时拉一次（skillOutfit:list），保存后不推一份的话新方案不会出现
    pushOutfits();
    return true;
  }

  if (event === "skillOutfit:apply") {
    const outfit = skillOutfitsFor(player).find((item) => item.uuid === String(data?.outfitUuid || ""));
    if (!outfit) {
      emitGameEvent(socket, "skillOutfit:apply:fail", { message: "找不到该技能配置" });
      return true;
    }
    const own = new Map(normalizePlayerSkills(player).map((entry) => [entry.skillId, entry]));
    const base = own.get(SKILL_BASE_ID);
    const applied = [];
    const seen = new Set();
    for (const entry of outfit.data || []) {
      const skill = own.get(entry.skillId);
      if (!skill || seen.has(entry.skillId)) continue;
      seen.add(entry.skillId);
      applied.push({ ...skill, enabled: entry.enabled !== false, logic: structuredClone(entry.logic || []) });
    }
    // baseAttack 的位置跟玩家拖拽的结果走（reorderSkill 允许把它拖到中间），
    // 只有方案里确实没有它时才补到最前；方案里没有的技能接在后面保持原状
    if (!seen.has(SKILL_BASE_ID)) applied.unshift(base);
    const tail = [...own.values()].filter((entry) => !seen.has(entry.skillId) && entry.skillId !== SKILL_BASE_ID);
    player.skillList = [...applied, ...tail].map((entry, index) => ({ ...entry, order: index }));
    schedulePersist();
    pushSkills();
    emitGameEvent(socket, "skillOutfit:apply:success", { outfit: publicSkillOutfit(outfit) });
    return true;
  }

  if (event === "skillOutfit:delete") {
    const outfits = skillOutfitsFor(player);
    const index = outfits.findIndex((item) => item.uuid === String(data?.outfitUuid || ""));
    if (index < 0) {
      emitGameEvent(socket, "skillOutfit:delete:fail", { message: "找不到该技能配置" });
      return true;
    }
    outfits.splice(index, 1);
    schedulePersist();
    // 前端删完把 e.outfit 当成整个列表直接赋值（t.value = e.outfit），所以这里发的是剩余全部
    emitGameEvent(socket, "skillOutfit:delete:success", { outfit: outfits.map(publicSkillOutfit) });
    return true;
  }

  return false;
}

// ---- 战斗物品袋（「技能&物品袋」页下半部分「战斗物品配置」）----
// 前端 store 是组件内的本地 ref，所有写操作的 :success 都整包替换成「对象 map」：
//   { [resourceId]: { remainingCount, prepareCount, ai, order, useWhen } }
// 形状不对会被 Object.entries 当成条目渲染出来（没实现时页面显示成 accepted / event / data 三行）。
// 语义：prepareCount 是计划携带量，remainingCount 是袋里还剩几个；取回时按 remainingCount 退回背包。
function battleInventoryView(player) {
  const source = player.battleInventory;
  const result = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return result;
  let index = 0;
  for (const [resourceId, entry] of Object.entries(source)) {
    if (!resourceCatalog[resourceId] || !entry) continue;
    result[resourceId] = {
      remainingCount: Math.max(0, Math.floor(Number(entry.remainingCount) || 0)),
      prepareCount: Math.max(0, Math.floor(Number(entry.prepareCount) || 0)),
      ai: Array.isArray(entry.ai) ? entry.ai : [],
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : index,
      useWhen: Array.isArray(entry.useWhen) ? entry.useWhen.filter((item) => typeof item === "string").slice(0, 10) : []
    };
    index += 1;
  }
  return result;
}

function battleInventoryStore(player) {
  if (!player.battleInventory || typeof player.battleInventory !== "object" || Array.isArray(player.battleInventory)) player.battleInventory = {};
  return player.battleInventory;
}

function handleBattleInventoryEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return false;
  const pushBag = () => emitGameEvent(socket, "character:getBattleInventory:success", battleInventoryView(player));
  const pushInventory = () => {
    emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
    emitGameEvent(socket, "inventoryUpdated", player.inventory);
  };
  // 前端失败事件名不统一：add / remove / refill 用 :fail，reorder 用 :error
  const failWith = (suffix, message) => {
    emitGameEvent(socket, `${event}:${suffix}`, { message });
    return true;
  };

  if (event === "character:getBattleInventory") {
    pushBag();
    return true;
  }

  if (event === "character:addResourceToBattleInventory") {
    const resourceId = String(data?.resourceId || "");
    const count = Math.max(1, Math.floor(Number(data?.count) || 1));
    // 前端下拉只列 inBattleEffect 的物品，后端照样校验，避免塞进不能用的东西
    if (!resourceCatalog[resourceId]?.inBattleEffect) return failWith("fail", "该物品不能放进战斗物品袋");
    if (getAssetCount(player, resourceId) < count) return failWith("fail", "背包中数量不足");
    removeAsset(player, resourceId, count);
    const bag = battleInventoryStore(player);
    const current = bag[resourceId] || {};
    bag[resourceId] = {
      remainingCount: (Number(current.remainingCount) || 0) + count,
      prepareCount: (Number(current.prepareCount) || 0) + count,
      ai: Array.isArray(current.ai) ? current.ai : [],
      order: Number.isFinite(Number(current.order)) ? Number(current.order) : Object.keys(bag).length,
      useWhen: Array.isArray(current.useWhen) ? current.useWhen : []
    };
    schedulePersist();
    pushInventory();
    emitGameEvent(socket, "character:addResourceToBattleInventory:success", battleInventoryView(player));
    return true;
  }

  if (event === "character:removeResourceFromBattleInventory") {
    const resourceId = String(data?.resourceId || "");
    const bag = battleInventoryStore(player);
    const entry = bag[resourceId];
    if (!entry) return failWith("fail", "战斗物品袋里没有该物品");
    // prepareCount 只是计划量，不产生实物；只把袋里实际剩下的退回去
    const back = Math.max(0, Math.floor(Number(entry.remainingCount) || 0));
    if (back > 0) addAsset(player, resourceId, back);
    delete bag[resourceId];
    schedulePersist();
    pushInventory();
    pushBag();
    emitGameEvent(socket, "character:removeResourceFromBattleInventory:success", battleInventoryView(player));
    return true;
  }

  if (event === "character:refillBattleInventory") {
    const resourceId = String(data?.resourceId || "");
    const bag = battleInventoryStore(player);
    const entry = bag[resourceId];
    if (!entry) return failWith("fail", "战斗物品袋里没有该物品");
    const remaining = Math.max(0, Math.floor(Number(entry.remainingCount) || 0));
    const missing = Math.max(0, Math.floor(Number(entry.prepareCount) || 0) - remaining);
    if (missing <= 0) return failWith("fail", "已经补满了");
    const count = Math.min(missing, Math.max(1, Math.floor(Number(data?.count) || missing)));
    if (getAssetCount(player, resourceId) < count) return failWith("fail", "背包中数量不足");
    removeAsset(player, resourceId, count);
    entry.remainingCount = remaining + count;
    schedulePersist();
    pushInventory();
    emitGameEvent(socket, "character:refillBattleInventory:success", battleInventoryView(player));
    return true;
  }

  if (event === "character:reorderBattleInventory") {
    const order = Array.isArray(data?.order) ? data.order.map((item) => String(item)) : [];
    if (!order.length) return failWith("error", "排序不能为空");
    const bag = battleInventoryStore(player);
    const ranked = [];
    for (const resourceId of order) {
      if (bag[resourceId] && !ranked.includes(resourceId)) ranked.push(resourceId);
    }
    // 前端拖拽提交的是完整列表，没提到的物品接在后面保持原顺序
    const tail = Object.keys(bag).filter((resourceId) => !ranked.includes(resourceId));
    [...ranked, ...tail].forEach((resourceId, index) => {
      bag[resourceId].order = index;
    });
    schedulePersist();
    emitGameEvent(socket, "character:reorderBattleInventory:success", battleInventoryView(player));
    return true;
  }

  if (event === "character:updateBattleUseItemLogic") {
    const resourceId = String(data?.resourceId || "");
    const bag = battleInventoryStore(player);
    const entry = bag[resourceId];
    if (!entry) return failWith("fail", "战斗物品袋里没有该物品");
    // payload 里叫 logic，存下来给前端读的字段是 ai（见 949400 附近的 f computed）
    if (!Array.isArray(data?.logic)) return failWith("fail", "自动使用逻辑不合法");
    const logic = sanitizeSkillLogic(data.logic);
    if (!logic) return failWith("fail", "自动使用逻辑不合法或数据过大");
    entry.ai = logic;
    entry.useWhen = Array.isArray(data?.useWhen) ? data.useWhen.filter((item) => typeof item === "string").slice(0, 10) : [];
    schedulePersist();
    emitGameEvent(socket, "character:updateBattleUseItemLogic:success", battleInventoryView(player));
    return true;
  }

  return false;
}

function characterInitData(player) {
  const currentBattleRoom = getBattleRoom(player.currentBattleRoomId);
  return {
    inventory: player.inventory,
    tavern: [],
    quest: Array.isArray(player.quests) ? player.quests : [],
    kittyInfo: player.kitty,
    currentBattleRoom: publicBattleRoom(currentBattleRoom),
    battleInfo: player.battleInfo || null,
    allGameActionDurationDetail: actionDurationDetailFor(player),
    allGameActionResourceRequirementDetail: actionResourceRequirementDetailFor(player),
    workEquipment: player.workEquipment || {},
    battleEquipment: player.battleEquipment || {},
    // 技能页的 characterBattleSkill 是数组（见 playerSkills 的注释），初始化时整包下发
    skills: playerSkills(player),
    // 已点出的专精节点：前端用它解锁/禁用战斗装备槽（右手2、弃臂聚势等）
    skillNodes: skillTreeLearned(player),
    // 前端只判断 building[type].status === "BUILT"（其他状态位是公共建筑 villageBuilding 用的另一套）
    building: player.building || {},
    kittyFurniture: Array.isArray(player.kittyFurniture) ? player.kittyFurniture : [],
    // 属性面板要的是「基础等级 + 装备加成」明细，不是裸 status（见 statusDetailFor）
    status: statusDetailFor(player),
    guild: {},
    userStyle: publicStyleView(player),
    // 前端以数组消费：FarmingPlotCard 用 .some(e => e.type === "kittyHomeServiceCenter" && e.level >= 2)
    // 判断是否显示「补种」开关，5430 处用 .find(e => e.type === "catVillageMonument") 算经验加成。
    // 下发 {} 会抛 TypeError 并被 Vue 的 errorHandler 吞掉，整张田地卡片渲染成注释节点。
    villageBuildingInfo: villageBuildingProjection(),
    uniqueFlag: player.uniqueFlag,
    sponsorPoint: player.sponsorPoint && typeof player.sponsorPoint === "object"
      ? player.sponsorPoint
      : { current: 0, max: 0 },
    kittyExpedition: {},
    lastOnlineDate: null,
    isBeginner: true
  };
}

function emitGameEvent(socket, event, payload) {
  socket.emit(event, JSON.stringify({ data: payload }));
}

function unsupportedFeaturePayload(feature, event, message) {
  const text = message || `功能尚未实现：${feature}`;
  return {
    code: "UNSUPPORTED_FEATURE",
    feature,
    ...(event ? { event } : {}),
    message: text,
    msg: text
  };
}

function sendUnsupportedFeature(res, feature, message) {
  return res.status(501).json(unsupportedFeaturePayload(feature, undefined, message));
}

function emitUnsupportedFeature(socket, event, feature, suffix = "error", message) {
  emitGameEvent(socket, `${event}:${suffix}`, unsupportedFeaturePayload(feature, event, message));
  return true;
}

function getBattleRoom(roomId) {
  return roomId ? battleRooms.get(roomId) : null;
}

function publicBattleRoom(room) {
  if (!room) return null;
  // battleRewardInfo 只通过 battleRoom:rewardInfo 下发，避免每次房间广播都带上全部战利品
  const { battleRewardInfo, battleRewardInfoExpireAt, ...rest } = room;
  const cloned = structuredClone(rest);
  cloned.hasBattleRewardInfo = Boolean(battleRewardInfo && Object.keys(battleRewardInfo).length);
  return cloned;
}

function emitRoomUpdate(room) {
  for (const memberId of room.memberIds) {
    const member = players.get(memberId);
    if (!member) continue;
    member.currentBattleRoomId = room.uuid;
    for (const socket of io.sockets.sockets.values()) {
      if (socket.player?.uuid === memberId) {
        emitGameEvent(socket, "battleRoom:update", publicBattleRoom(room));
      }
    }
  }
}

function emitRoomEvent(room, event, payload) {
  for (const memberId of room.memberIds) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.player?.uuid === memberId) emitGameEvent(socket, event, payload);
    }
  }
}

// 每次成功施放技能给的经验。技能页面板显示「经验 x / pq[level]」，pq[1]=20，
// 所以 7 次施放左右能升到 2 级，不至于一场战斗就满级。
const SKILL_CAST_EXP = 3;

function emitToPlayer(uuid, event, payload) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.player?.uuid === uuid) emitGameEvent(socket, event, payload);
  }
}

// 战斗单位里的技能等级/经验是快照，升级后要写回玩家存档，否则下一场又会掉回 1 级
function syncBattleSkillProgress(unit) {
  const player = players.get(unit?.uuid);
  if (!player || !unit?.skills) return false;
  const list = normalizePlayerSkills(player);
  let changed = false;
  for (const entry of list) {
    const state = unit.skills[entry.skillId];
    if (!state) continue;
    const level = Math.max(1, Math.floor(Number(state.level) || 1));
    const exp = Math.max(0, Number(state.exp) || 0);
    if (level !== entry.level || exp !== entry.exp) {
      entry.level = level;
      entry.exp = exp;
      changed = true;
    }
  }
  if (changed) {
    player.skillList = list;
    schedulePersist();
  }
  return changed;
}

// ---- 战斗数值换算（对照参考站 http://111.229.73.102:8080 实测 + 官方更新日志）----
// 攻击力 = 力量 × 1.25（更新日志「每点力量提供 0.25 攻击力，仅战斗内显示加成」）+ 战斗等级 × 0.2
// 防御力 = 耐力 + 战斗等级 × 0.2
// 生命上限 = 100 + 耐力 × 5；魔法上限 = 50 + 智力 × 5
// 伤害减免 = (0.0065 × 有效防御) / (1 + 0.0065 × 有效防御)，最终伤害 = floor(伤害 × (1 - 减免))
const BATTLE_LEVEL_BONUS_PER_LEVEL = 0.2;
const STRENGTH_ATTACK_BONUS = 0.25;
const DEFENSE_REDUCTION_CONSTANT = 0.0065;
const BATTLE_ATTRIBUTE_EXP = { strength: 0.28, attacking: 0.28, dexterity: 0.185, stamina: 0.09, defencing: 0.09 };
const BATTLE_LOSE_EXP_RATIO = 0.3;

function roundOneDecimal(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function battleAttackValue(strengthLevel, battleLevel) {
  const strength = Number(strengthLevel) || 1;
  const level = Number(battleLevel) || 1;
  return roundOneDecimal(strength * (1 + STRENGTH_ATTACK_BONUS) + level * BATTLE_LEVEL_BONUS_PER_LEVEL);
}

function battleDefenceValue(staminaLevel, battleLevel) {
  const stamina = Number(staminaLevel) || 1;
  const level = Number(battleLevel) || 1;
  return roundOneDecimal(stamina + level * BATTLE_LEVEL_BONUS_PER_LEVEL);
}

function battleDamageReduction(defenceValue) {
  const defence = Math.max(0, Number(defenceValue) || 0);
  const scaled = DEFENSE_REDUCTION_CONSTANT * defence;
  return scaled / (1 + scaled);
}

function battleFinalDamage(attackValue, defenceValue) {
  const attack = Number(attackValue) || 0;
  const reduction = battleDamageReduction(defenceValue);
  return Math.max(1, Math.floor(attack * (1 - reduction)));
}

// ---- 战斗掉落（对照参考站 game-battle-skill-I4Ckwbp2.js 导出的难度表 He / 常量 Ge）----
// 副本难度：房间 difficulty = 0（无额外难度）/ 1..6，索引进表即 difficulty - 1。
// 怪物数值 = 原值 × (1 + 百分比) + 固定值；敌人数量 + additionalEnemyCount；
// 掉落率、经验均为「乘算」加成：掉落率 ×= (1 + additionalDropPercent)，经验 ×= (1 + additionalExpPercent)。
const BATTLE_DIFFICULTY_CATALOG = [
  { hpBase: 200, attackBase: 30, defenseBase: 50, hpPercent: 0.25, attackPercent: 0.25, defensePercent: 0.25, additionalEnemyCount: 2, additionalDropPercent: 0.15, additionalExpPercent: 0.15 },
  { hpBase: 350, attackBase: 45, defenseBase: 65, hpPercent: 0.35, attackPercent: 0.35, defensePercent: 0.35, additionalEnemyCount: 2, additionalDropPercent: 0.25, additionalExpPercent: 0.23 },
  { hpBase: 550, attackBase: 60, defenseBase: 80, hpPercent: 0.5, attackPercent: 0.5, defensePercent: 0.5, additionalEnemyCount: 3, additionalDropPercent: 0.4, additionalExpPercent: 0.31 },
  { hpBase: 800, attackBase: 75, defenseBase: 95, hpPercent: 0.7, attackPercent: 0.7, defensePercent: 0.7, additionalEnemyCount: 3, additionalDropPercent: 0.6, additionalExpPercent: 0.5 },
  { hpBase: 1100, attackBase: 90, defenseBase: 110, hpPercent: 1, attackPercent: 1, defensePercent: 1, additionalEnemyCount: 4, additionalDropPercent: 0.9, additionalExpPercent: 0.75 },
  { hpBase: 5500, attackBase: 200, defenseBase: 300, hpPercent: 2, attackPercent: 2, defensePercent: 2, additionalEnemyCount: 4, additionalDropPercent: 1.25, additionalExpPercent: 1.25 }
];
// 硬核猫房间的「金币/战利品比例」滑块：每格金币 -10%，战利品掉落率 +7.5%
const LOOT_GOLD_SLIDER_GOLD_STEP = 0.1;
const LOOT_GOLD_SLIDER_LOOT_STEP = 0.075;
// 参考站：战利品信息最多在房间停止战斗后保留 6 小时
const BATTLE_REWARD_INFO_TTL_MS = 6 * 60 * 60 * 1000;

function battleDifficultyConfig(room) {
  const index = Math.floor(Number(room?.difficulty) || 0) - 1;
  return BATTLE_DIFFICULTY_CATALOG[index] || null;
}

function battleLootGoldSlider(room) {
  return Math.max(0, Math.min(10, Math.floor(Number(room?.lootGoldSlider) || 0)));
}

// 战利品掉落率乘算：难度加成 × 金币/战利品比例滑块（参考站「战利品掉落概率为最终乘算」）
function battleDropMultiplier(room) {
  const difficulty = battleDifficultyConfig(room);
  const difficultyBonus = 1 + (difficulty?.additionalDropPercent || 0);
  const sliderBonus = 1 + LOOT_GOLD_SLIDER_LOOT_STEP * battleLootGoldSlider(room);
  // 「自然时运」（自然馈赠挂的状态）按状态强度提升战利品掉落率：
  // 参考站是每级采集 +0.08%，30 级采集 = +2.4%（×1.024）
  const battleInfo = room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean);
  let giftBonus = 0;
  for (const unit of battleInfo?.members || []) {
    if (!(unit?.hp > 0)) continue;
    giftBonus += Number(unit.state?.natureGift?.actualValue) || 0;
  }
  return difficultyBonus * sliderBonus * (1 + giftBonus);
}

// 金币获取比例：只有滑块会削减金币，难度不削减
function battleGoldMultiplier(room) {
  return Math.max(0, 1 - LOOT_GOLD_SLIDER_GOLD_STEP * battleLootGoldSlider(room));
}

function battleExpMultiplier(room) {
  const difficulty = battleDifficultyConfig(room);
  return 1 + (difficulty?.additionalExpPercent || 0);
}

function scaleEnemyStat(baseValue, percent, fixedValue) {
  const base = Number(baseValue) || 0;
  return roundOneDecimal(base * (1 + (Number(percent) || 0)) + (Number(fixedValue) || 0));
}

// 掷一次掉落：基础概率 × 乘算倍率；超过 100% 的整数部分转为掉落数量（参考站 2025-07-03 更新）
function rollBattleDrop(drop, multiplier) {
  const basePercent = Math.max(0, Number(drop?.percent) || 0);
  const effective = basePercent * (Number(multiplier) || 0);
  if (!(effective > 0)) return 0;
  const guaranteed = Math.floor(effective);
  const remainder = effective - guaranteed;
  const times = guaranteed + (Math.random() < remainder ? 1 : 0);
  if (times <= 0) return 0;
  const minimum = Math.max(1, Math.floor(Number(drop?.range?.min ?? drop?.count ?? 1)));
  const maximum = Math.max(minimum, Math.floor(Number(drop?.range?.max ?? drop?.count ?? minimum)));
  const perRoll = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
  return perRoll * times;
}

// ---- 装备属性加成 ----
// 装备的效果写在资源表的 onEquip[].statusEffect 里（`{status, increase}` 或 `{status, decrease}`），
// 例如斧头 attacking +1、铁剑 attacking +4、战士披风 battle +10、鱼鳞帽 hp +40。
// 两个栏位各自独立：战斗读 battleEquipment，生活读 workEquipment（同一件装备不会两边同时生效）。
// `hp` 是伪属性（加生命上限），`hpRegen` / `mpRegen` 是每回合回复量。
function equipmentEffects(player, type) {
  const slots = player[type === "battle" ? "battleEquipment" : "workEquipment"];
  const bonus = {};
  const regen = { hp: 0, mp: 0 };
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return { bonus, regen };
  for (const resourceId of Object.values(slots)) {
    const item = resourceCatalog[resourceId];
    if (!item) continue;
    for (const effect of item.onEquip || []) {
      for (const entry of effect?.statusEffect || []) {
        const status = String(entry?.status || "");
        if (!status) continue;
        const amount = (Number(entry.increase) || 0) - (Number(entry.decrease) || 0);
        if (!amount) continue;
        bonus[status] = (bonus[status] || 0) + amount;
      }
      regen.hp += Number(effect?.hpRegen?.increase) || 0;
      regen.mp += Number(effect?.mpRegen?.increase) || 0;
    }
  }
  return { bonus, regen };
}

function makeBattleUnit(player) {
  const status = getPlayerStatus(player);
  const { bonus, regen } = equipmentEffects(player, "battle");
  const bonusOf = (key) => Number(bonus[key]) || 0;
  const strength = Math.max(1, (status.strength?.level || 1) + bonusOf("strength"));
  const stamina = Math.max(1, (status.stamina?.level || 1) + bonusOf("stamina"));
  const intelligence = Math.max(1, (status.intelligence?.level || 1) + bonusOf("intelligence"));
  const dexterity = Math.max(1, (status.dexterity?.level || 1) + bonusOf("dexterity"));
  const battleLevel = Math.max(1, (status.battle?.level || 1) + bonusOf("battle"));
  const maxHp = 100 + stamina * 5 + bonusOf("hp");
  const maxMp = 50 + intelligence * 5;
  // 攻击/防御是「力量/耐力换算值 + 装备直接加的攻击力」，两者都算
  const attacking = roundOneDecimal(battleAttackValue(strength, battleLevel) + bonusOf("attacking"));
  const defencing = roundOneDecimal(battleDefenceValue(stamina, battleLevel) + bonusOf("defencing"));
  const battleStatus = {
    ...status,
    attacking: { level: attacking, currentExp: status.strength?.currentExp || 0 },
    defencing: { level: defencing, currentExp: status.stamina?.currentExp || 0 },
    dexterity: { level: dexterity, currentExp: status.dexterity?.currentExp || 0 },
    strength: { level: strength, currentExp: status.strength?.currentExp || 0 },
    intelligence: { level: intelligence, currentExp: status.intelligence?.currentExp || 0 },
    stamina: { level: stamina, currentExp: status.stamina?.currentExp || 0 },
    battle: { level: battleLevel, currentExp: status.battle?.currentExp || 0 }
  };
  // 其余属性（幸运等）直接按装备加成平移，战斗面板里显示的值要和实际生效值一致
  for (const [key, amount] of Object.entries(bonus)) {
    if (["hp", "attacking", "defencing", "strength", "stamina", "intelligence", "dexterity", "battle"].includes(key)) continue;
    const current = battleStatus[key] || { level: 1 };
    battleStatus[key] = { ...current, level: roundOneDecimal((Number(current.level) || 1) + amount) };
  }
  // 技能页启用的技能直接进战斗：skills 是前端战斗引擎认的对象形态 {id:{level,order,exp}}，
  // skillOrder 决定施放优先级（就是技能页拖拽后的顺序），skillLogic 是自动释放逻辑。
  // 只有 skill-catalog 里带可执行算式的技能才会被 selectSkill 选中，其余退回普攻。
  const enabledSkills = playerSkills(player).filter((entry) => entry.enabled);
  const battleSkills = {};
  const skillOrder = [];
  const skillLogic = {};
  for (const entry of enabledSkills) {
    battleSkills[entry.skillId] = { level: entry.level, order: entry.order, exp: entry.exp };
    skillOrder.push(entry.skillId);
    skillLogic[entry.skillId] = Array.isArray(entry.logic) ? entry.logic : [];
  }
  if (!battleSkills[SKILL_BASE_ID]) {
    battleSkills[SKILL_BASE_ID] = { level: 1, order: 0, exp: 0 };
    skillOrder.unshift(SKILL_BASE_ID);
  }
  return {
    uuid: player.uuid,
    id: player.uuid,
    name: player.name,
    isPlayerUnit: true,
    isPlayer: true,
    isSummoned: false,
    isBoss: false,
    level: battleLevel,
    hp: maxHp,
    maxHp,
    mp: maxMp,
    maxMp,
    tmpShield: 0,
    expReward: 0,
    status: battleStatus,
    baseStatus: structuredClone(battleStatus),
    state: {},
    skills: battleSkills,
    skillOrder,
    skillLogic,
    ai: {},
    skillColddown: {},
    equipment: { ...(player.battleEquipment || {}) },
    inventory: {},
    initialStates: [],
    affix: [],
    // 装备提供的每回合回复量，在 resolveBattleTurn 里叠加到耐力/智力回复之上
    equipRegen: regen
  };
}

function makeBattleInfo(room) {
  const playersInBattle = room.memberIds.map((uuid) => players.get(uuid)).filter(Boolean).map(makeBattleUnit);
  const area = battleAreaCatalog[room.area] || battleAreaCatalog.forest_001;
  const specialBattle = area?.specialBattles?.find((item) => item.every && (room.turn || 1) % item.every === 0);
  const enemyPool = specialBattle?.enemies?.length ? specialBattle.enemies : area?.enemyPool || [];
  const difficulty = battleDifficultyConfig(room);
  const baseEnemyCount = specialBattle?.enemies?.length
    ? Math.max(1, Math.min(specialBattle.maxBossNum || 1, specialBattle.enemies.length))
    : Math.max(1, Number(area?.minEnemies) || 1) + Math.floor(Math.random() * Math.max(1, (Number(area?.maxEnemies) || 3) - (Number(area?.minEnemies) || 1) + 1));
  // 难度等级：额外敌人数量（参考站建房界面「额外敌人数量」）
  const enemyCount = baseEnemyCount + (difficulty?.additionalEnemyCount || 0);
  const enemies = [];
  for (let index = 0; index < enemyCount; index += 1) {
    const weightedPool = specialBattle?.enemies?.length ? specialBattle.enemies : enemyPool;
    const totalWeight = weightedPool.reduce((sum, entry) => sum + (Number(entry.weight) || 0), 0);
    let selection = Math.random() * totalWeight;
    const chosen = weightedPool.find((entry) => (selection -= Number(entry.weight) || 0) <= 0) || weightedPool[0];
    const template = chosen && battleMonsterCatalog[chosen.id];
    if (!template) continue;
    const enemy = structuredClone(template);
    enemy.uuid = crypto.randomUUID();
    enemy.isPlayer = false;
    enemy.isPlayerUnit = false;
    enemy.isSummoned = false;
    enemy.status ||= {};
    enemy.status.attacking ||= { level: Number(enemy.attack) || 5 };
    enemy.status.defencing ||= { level: Number(enemy.defense) || 1 };
    enemy.status.strength ||= { level: 1 };
    enemy.status.dexterity ||= { level: 1 };
    enemy.status.intelligence ||= { level: 1 };
    enemy.status.stamina ||= { level: 1 };
    enemy.skills ||= { baseAttack: { level: 1, order: 0 } };
    enemy.skills.baseAttack ||= { level: 1, order: 0 };
    enemy.skills.baseAttack.order ??= 0;
    // 参考站的怪物自带技能表（{id:{level}}），进战斗后按模板里的顺序当施放优先级，
    // 和玩家一样走 selectSkill：冷却 / 蓝量 / 目标 / 条件全过才放，否则退回普攻。
    enemy.skillOrder = Object.keys(enemy.skills).filter((id) => id !== "baseAttack");
    enemy.skillLogic ||= {};
    enemy.ai ||= {};
    enemy.skillColddown = {};
    enemy.equipment ||= {};
    enemy.inventory ||= {};
    enemy.state ||= {};
    if (difficulty) {
      // 难度等级：生命/攻击/防御 = 原值 × (1 + 百分比) + 固定值（参考站建房界面的难度说明）
      enemy.hp = Math.round(scaleEnemyStat(enemy.maxHp ?? enemy.hp, difficulty.hpPercent, difficulty.hpBase));
      enemy.maxHp = enemy.hp;
      enemy.attack = scaleEnemyStat(enemy.attack, difficulty.attackPercent, difficulty.attackBase);
      enemy.defense = scaleEnemyStat(enemy.defense, difficulty.defensePercent, difficulty.defenseBase);
      enemy.status.attacking = { ...(enemy.status.attacking || {}), level: enemy.attack };
      enemy.status.defencing = { ...(enemy.status.defencing || {}), level: enemy.defense };
    }
    enemies.push(enemy);
  }
  const members = [...playersInBattle, ...enemies];
  const turnOrder = [...members].sort((left, right) =>
    (Number(right.status?.dexterity?.level) || 1) - (Number(left.status?.dexterity?.level) || 1)
  ).map((member) => member.uuid);
  const playerIds = playersInBattle.map((member) => member.uuid);
  const enemyIds = enemies.map((member) => member.uuid);
  return {
    roomId: room.uuid,
    battleType: room.battleType,
    battleStatus: "BATTLING",
    battleId: crypto.randomUUID(),
    passedTurn: 0,
    currentTurnIndex: 0,
    turnOrder,
    extraTurnIndex: 0,
    extraTurnOnBattleBegin: [],
    thisBattleTmpOnceExtraTurnIndexList: [],
    playerGroupId: "0",
    groups: { "0": playerIds, "1": enemyIds },
    members,
    worldBossConfig: { uuidList: [] },
    area: room.area,
    turnIndex: room.turn || 1,
    battleLog: []
  };
}

function setRoomBattleState(room, status) {
  room.status = status;
  room.lastUpdateAt = Date.now();
  for (const memberId of room.memberIds) {
    const player = players.get(memberId);
    if (!player) continue;
    player.battleInfo = status === "battling" ? makeBattleInfo(room) : null;
  }
}

function pushBattleInfo(room) {
  const battleInfo = room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean);
  if (!battleInfo) return;
  for (const memberId of room.memberIds) {
    const player = players.get(memberId);
    if (player) player.battleInfo = battleInfo;
  }
  emitRoomEvent(room, "battle:fullInfo:success", { battleInfo });
  emitRoomEvent(room, "battle:begin:success", { turnIndex: room.turn || 1 });
  startBattleTurns(room);
}

function appendBattleLog(room, type, payload) {
  const battleInfo = room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean);
  if (!battleInfo) return;
  battleInfo.battleLog.push({ type, ...payload, timestamp: Date.now() });
  if (battleInfo.battleLog.length > 300) battleInfo.battleLog.shift();
}

// 房间内累计战利品（参考站「查看战斗奖励」面板）：{ [uuid]: { [itemId]: { count } } }，
// 房间停止战斗后保留 6 小时。
function accumulateRoomBattleLoot(room, uuid, gained) {
  if (!room.battleRewardInfo || typeof room.battleRewardInfo !== "object") room.battleRewardInfo = {};
  const record = room.battleRewardInfo[uuid] || (room.battleRewardInfo[uuid] = {});
  for (const [itemId, info] of Object.entries(gained)) {
    const count = Number(info?.count) || 0;
    if (!(count > 0)) continue;
    record[itemId] = { count: (Number(record[itemId]?.count) || 0) + count };
  }
  room.battleRewardInfoExpireAt = Date.now() + BATTLE_REWARD_INFO_TTL_MS;
}

function battleRewardInfoOf(room) {
  if (!room) return {};
  if (room.battleRewardInfoExpireAt && Date.now() > room.battleRewardInfoExpireAt) {
    room.battleRewardInfo = {};
    room.battleRewardInfoExpireAt = null;
    return {};
  }
  const info = room.battleRewardInfo && typeof room.battleRewardInfo === "object" ? room.battleRewardInfo : {};
  // 已经离开房间的成员不再展示（参考站面板只显示「当前成员」）
  return Object.fromEntries(Object.entries(info).filter(([uuid]) => room.memberIds.includes(uuid)));
}

function grantBattleRewards(room, battleInfo, result) {
  const expRewards = {};
  const resourceRewards = {};
  const enemies = battleInfo.members.filter((unit) => !unit.isPlayerUnit && !unit.isSummoned);
  const totalExp = enemies.reduce((sum, enemy) => sum + (Number(enemy.expReward) || 0), 0);
  const baseExp = Math.floor(totalExp / Math.max(1, room.memberIds.length));
  // 参考站：战斗失败只结算基础经验，胜利额外获得完整经验（难度加成的额外经验仅胜利提供）
  const exp = result === "PLAYER_WIN"
    ? Math.max(1, Math.floor(baseExp * battleExpMultiplier(room)))
    : Math.max(0, Math.floor(baseExp * BATTLE_LOSE_EXP_RATIO));
  // 参考站：战斗会同时给予战斗属性经验（每场固定值，攻/防与力量/耐力同步）
  const attributeGain = Number(battleInfo.passedTurn) > 0 ? BATTLE_ATTRIBUTE_EXP : null;
  const lootMultiplier = battleDropMultiplier(room);
  const goldMultiplier = battleGoldMultiplier(room);
  for (const uuid of room.memberIds) {
    const player = players.get(uuid);
    if (!player) continue;
    const battleStatus = addStatusExp(player, "battle", exp);
    if (attributeGain) {
      for (const key of ["strength", "dexterity", "stamina"]) {
        addStatusExp(player, key, Number(attributeGain[key]) || 0);
      }
      player.status.attacking = normalizeStatus({ ...player.status.attacking, expMode: "level", level: player.status.strength.level, currentExp: player.status.strength.currentExp, exp: player.status.strength.currentExp });
      player.status.defencing = normalizeStatus({ ...player.status.defencing, expMode: "level", level: player.status.stamina.level, currentExp: player.status.stamina.currentExp, exp: player.status.stamina.currentExp });
    }
    expRewards[uuid] = { exp, status: battleStatus };
    const gained = {};
    if (result === "PLAYER_WIN") {
      for (const enemy of enemies) {
        for (const drop of enemy.drops || []) {
          // 金币走「金币获取比例」，其余物品走「战利品掉落率」（难度加成 × 金币/战利品比例滑块）
          const multiplier = drop.id === "gold" ? goldMultiplier : lootMultiplier;
          const count = rollBattleDrop(drop, multiplier);
          if (!(count > 0)) continue;
          const current = Number(player.inventory[drop.id]?.count) || 0;
          player.inventory[drop.id] = { count: current + count };
          gained[drop.id] = { count: (gained[drop.id]?.count || 0) + count };
        }
      }
    }
    resourceRewards[uuid] = gained;
    if (Object.keys(gained).length) accumulateRoomBattleLoot(room, uuid, gained);
    const memberSocket = [...io.sockets.sockets.values()].find((candidate) => candidate.player?.uuid === uuid);
    if (memberSocket) {
      emitGameEvent(memberSocket, "dispatchCharacterStatusInfo", characterInitData(player).status);
      emitGameEvent(memberSocket, "dispatchInventoryInfo", player.inventory);
      emitGameEvent(memberSocket, "inventoryUpdated", player.inventory);
      if (Object.keys(gained).length) emitGameEvent(memberSocket, "inventory:increase:success", gained);
    }
  }
  emitRoomEvent(room, "battle:giveExpReward:success", expRewards);
  emitRoomEvent(room, "battle:giveResourceReward:success", resourceRewards);
  emitRoomEvent(room, "battle:battleInfoDetail:success", {
    roomId: room.uuid,
    battleStatus: result,
    passedTurn: battleInfo.passedTurn,
    members: battleInfo.members.map(({ uuid, name, hp, maxHp, isPlayerUnit }) => ({ uuid, name, hp, maxHp, isPlayerUnit }))
  });
}

function beginBattleRound(room) {
  room.turn = (room.turn || 0) + 1;
  room.status = "battling";
  room.waitingForRestartTime = null;
  room.waitingForAutoStartTime = null;
  room.lastUpdateAt = Date.now();
  room.memberIds.forEach((uuid) => { room.readyMap[uuid] = false; });
  setRoomBattleState(room, "battling");
  emitRoomUpdate(room);
  emitRoomEvent(room, "battle:prepareBegin:success", { roomId: room.uuid });
  emitRoomEvent(room, "battle:prepareEnd:success", { roomId: room.uuid });
  pushBattleInfo(room);
  startBattleTurns(room);
  // 每场开头落一次盘：挂机时没有客户端事件，不主动存的话重启只能回到上一场
  schedulePersist();
}

function scheduleBattleRestart(room) {
  const restartDelayMs = 10e3;
  room.status = "waiting_for_restart";
  room.waitingForRestartTime = Date.now() + restartDelayMs;
  room.lastUpdateAt = Date.now();
  console.log(`[battle] 房间 ${room.uuid} 第 ${room.turn || 1} 场结束，${restartDelayMs / 1000}s 后自动开下一场（在线人数无关）`);
  emitRoomUpdate(room);
  const timer = setTimeout(() => {
    battleTimers.delete(room.uuid);
    if (room.memberIds.length && room.status === "waiting_for_restart") beginBattleRound(room);
  }, restartDelayMs);
  battleTimers.set(room.uuid, timer);
  // 挂机时没有客户端事件，靠这里把「等待重启」的状态落盘
  schedulePersist();
}

function finishBattle(room, result) {
  const timer = battleTimers.get(room.uuid);
  if (timer) clearTimeout(timer);
  battleTimers.delete(room.uuid);
  const battleInfo = room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean);
  if (battleInfo) {
    battleInfo.battleStatus = result;
    appendBattleLog(room, result, { battleStatus: result });
    emitRoomEvent(room, "battle:update:success", battleInfo);
    grantBattleRewards(room, battleInfo, result);
  }
  // 「自动开始战斗」和「自动重启」在离线挂机场景下是同一件事：一场打完就接着开下一场。
  // 之前只认 autoRestart，玩家勾了「自动开始战斗」也会打完就停。
  if ((room.autoRestart || room.autoStartBattle) && (result === "PLAYER_WIN" || result === "PLAYER_LOSE")) {
    scheduleBattleRestart(room);
    return;
  }
  room.status = "ended";
  room.lastUpdateAt = Date.now();
  for (const uuid of room.memberIds) {
    room.readyMap[uuid] = uuid !== room.ownerId;
    const player = players.get(uuid);
    if (player) player.battleInfo = null;
  }
  emitRoomEvent(room, "battle:end:success", { battleStatus: result, roomId: room.uuid });
  emitRoomUpdate(room);
  // 战斗结束 + 奖励已入账，立刻落盘，避免重启后回到「还在打」的旧快照
  schedulePersist();
}

/**
 * 普攻选目标：潜行的单位不能被选中（全员潜行时退回全体随机）、
 * 有嘲讽就打嘲讽来源、自己处于慌乱状态时不分敌我。
 */
function pickBasicAttackTarget(actor, opponents, members) {
  const pick = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);
  if (isConfused(actor)) {
    const anyone = members.filter((unit) => unit.hp > 0 && unit.uuid !== actor.uuid);
    if (anyone.length) return pick(anyone);
  }
  const alive = opponents.filter((unit) => unit.hp > 0);
  const visible = alive.filter((unit) => !isUntargetable(unit));
  const pool = visible.length ? visible : alive;
  const taunted = tauntSources(pool);
  return pick(taunted.length ? taunted : pool);
}

function resolveBattleTurn(room) {
  const battleInfo = room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean);
  if (!battleInfo || room.status !== "battling") return;
  const alivePlayers = battleInfo.members.filter((unit) => unit.isPlayerUnit && unit.hp > 0);
  const aliveEnemies = battleInfo.members.filter((unit) => !unit.isPlayerUnit && unit.hp > 0);
  if (!aliveEnemies.length) return finishBattle(room, "PLAYER_WIN");
  if (!alivePlayers.length) return finishBattle(room, "PLAYER_LOSE");

  let actor = null;
  for (let offset = 0; offset < battleInfo.turnOrder.length; offset += 1) {
    const index = (battleInfo.currentTurnIndex + offset) % battleInfo.turnOrder.length;
    const candidate = battleInfo.members.find((unit) => unit.uuid === battleInfo.turnOrder[index]);
    if (candidate?.hp > 0) {
      battleInfo.currentTurnIndex = index;
      actor = candidate;
      break;
    }
  }
  if (!actor) return finishBattle(room, "PLAYER_LOSE");

  const source = actor.uuid;
  // 自己的回合开始：先结算状态剩余回合，再让技能冷却 -1（和参考站的 turnStart 语义一致）
  // detachEffects 收集「到期才结算」的效果（种瓜得瓜：恢复一半已损失生命/魔法、清空技能冷却）
  const detachEffects = { heal: [], mpRestore: [], cooldowns: [] };
  const expiredStates = tickStates(actor, detachEffects);
  for (const stateId of expiredStates) {
    emitRoomEvent(room, "battle:floatText:success", { unit: source, text: `${stateLabel(stateId)} 结束` });
  }
  for (const item of detachEffects.heal) {
    emitRoomEvent(room, "battle:heal:success", { source, target: item.unit, value: item.value, reason: "state", stateId: item.stateId });
    emitRoomEvent(room, "battle:floatText:success", { unit: item.unit, text: `+${item.value}` });
  }
  for (const item of detachEffects.mpRestore) {
    emitRoomEvent(room, "battle:restoreMp:success", { target: item.unit, value: item.value });
    emitRoomEvent(room, "battle:floatText:success", { unit: item.unit, text: `+${item.value} MP` });
  }
  for (const item of detachEffects.cooldowns) {
    emitRoomEvent(room, "battle:floatText:success", { unit: item.unit, text: "技能冷却已重置" });
  }
  // 中毒/绝望在回合开始掉血，自我疗愈/再生回血 —— 结算完再决定这一回合还能不能行动
  const stateTick = applyStateTurnStart(actor, { members: battleInfo.members });
  for (const hit of stateTick.damage) {
    emitRoomEvent(room, "battle:floatText:success", { unit: hit.unit, text: `-${hit.value}` });
    emitRoomEvent(room, "battle:dealDamage:success", {
      source: hit.sourceUnitUuid || hit.unit,
      type: "state",
      castSkillId: hit.stateId,
      target: [{ unit: hit.unit, value: hit.value, fDamage: hit.value, remainingHp: actor.hp, damageType: "magical", shieldDamage: 0, causeBy: { type: "state", stateId: hit.stateId } }],
      sourceUnitUuid: hit.sourceUnitUuid || hit.unit,
      targetUnitUuidList: [hit.unit],
      damageType: "magical"
    });
    appendBattleLog(room, "damage", {
      source: hit.sourceUnitUuid || hit.unit,
      type: "state",
      castSkillId: hit.stateId,
      damage: [{ unit: hit.unit, value: hit.value, fDamage: hit.value, remainingHp: actor.hp, damageType: "magical", causeBy: { type: "state", stateId: hit.stateId } }]
    });
  }
  for (const tick of stateTick.heal) {
    emitRoomEvent(room, "battle:heal:success", { source: source, target: tick.unit, value: tick.value, reason: "state", stateId: tick.stateId });
    emitRoomEvent(room, "battle:floatText:success", { unit: tick.unit, text: `+${tick.value}` });
  }
  for (const skillId of Object.keys(actor.skillColddown || {})) {
    const left = Number(actor.skillColddown[skillId]) || 0;
    if (left <= 1) delete actor.skillColddown[skillId];
    else actor.skillColddown[skillId] = left - 1;
  }

  const actorIsPlayer = actor.isPlayerUnit;
  // 双方阵容都带上「已倒下」的成员：复活类技能要能找到尸体，其它流程各自过滤 hp>0
  const allies = battleInfo.members.filter((unit) => Boolean(unit.isPlayerUnit) === actorIsPlayer);
  const opponents = actorIsPlayer ? battleInfo.members.filter((unit) => !unit.isPlayerUnit) : battleInfo.members.filter((unit) => unit.isPlayerUnit);

  emitRoomEvent(room, "battle:turnStart:success", { source });

  // 控制类状态 / 回合开始被状态打死：本回合直接跳过（状态已在上面的 tickStates 里递减过）
  if (!(actor.hp > 0) || isIncapacitated(actor)) {
    emitRoomEvent(room, "battle:floatText:success", { unit: source, text: actor.hp > 0 ? "无法行动" : "倒下" });
    appendBattleLog(room, "turn", { source, skipped: true });
    battleInfo.currentTurnIndex = (battleInfo.currentTurnIndex + 1) % Math.max(1, battleInfo.turnOrder.length);
    if (battleInfo.currentTurnIndex === 0) battleInfo.passedTurn += 1;
    emitRoomEvent(room, "battle:turnEnd:success", { source });
    emitRoomEvent(room, "battle:update:success", battleInfo);
    const skippedResult = battleInfo.members.some((unit) => unit.isPlayerUnit && unit.hp > 0)
      ? battleInfo.members.some((unit) => !unit.isPlayerUnit && unit.hp > 0) ? null : "PLAYER_WIN"
      : "PLAYER_LOSE";
    if (skippedResult) return finishBattle(room, skippedResult);
    const skipDelay = Math.max(500, Number(room.turnDurationMs) || 1800);
    battleTimers.set(room.uuid, setTimeout(() => resolveBattleTurn(room), skipDelay));
    return;
  }

  const ctx = { allies, enemies: opponents, members: battleInfo.members, passedTurn: battleInfo.passedTurn };
  // 玩家和怪物走同一套：技能页里启用的技能按顺序优先尝试，没有能放的（冷却/蓝量/条件/未实装）就退回普攻
  let action = selectSkill(actor, ctx);
  const skillHelpers = {
    defenceOf: (unit) => Number(unit.status?.defencing?.level) || Number(unit.defence) || 0,
    finalDamage: battleFinalDamage
  };
  // 手写技能可能发现「现在放没意义」（比如驱散时没人中负面），这时退回普攻，不扣蓝不进冷却
  let effects = null;
  if (action) {
    effects = resolveSkillEffects(actor, action, skillHelpers, ctx);
    if (effects.skipCast) {
      action = null;
      effects = null;
    }
  }

  if (action && effects) {
    const { skill } = action;
    actor.mp = Math.max(0, (Number(actor.mp) || 0) - skill.mpCost);
    if (skill.mpCost > 0) {
      emitRoomEvent(room, "battle:lossMp:success", { source, target: source, value: skill.mpCost });
    }
    if (skill.colddown > 0) {
      actor.skillColddown = actor.skillColddown || {};
      actor.skillColddown[skill.id] = skill.colddown + 1;
    }
    emitRoomEvent(room, "battle:castSkill:success", { source, skillId: skill.id, skillName: skill.name });

    const targetPayload = [];
    for (const [unitId, detail] of Object.entries(effects.damage)) {
      targetPayload.push({
        unit: unitId,
        value: detail.value,
        fDamage: detail.fDamage,
        remainingHp: detail.remainingHp,
        damageType: detail.damageType,
        shieldDamage: detail.shieldDamage,
        causeBy: { type: "skill", skillId: skill.id }
      });
      emitRoomEvent(room, "battle:drawLine:success", {
        source,
        target: unitId,
        color: detail.damageType === "magical" ? "#409eff" : "#f56c6c"
      });
      emitRoomEvent(room, "battle:floatText:success", { unit: unitId, text: `-${detail.value}` });
    }
    if (targetPayload.length) {
      const payload = {
        source,
        type: "skill",
        castSkillId: skill.id,
        target: targetPayload,
        sourceUnitUuid: source,
        targetUnitUuidList: targetPayload.map((item) => item.unit),
        damageType: targetPayload[0].damageType
      };
      appendBattleLog(room, "damage", { ...payload, damage: targetPayload });
      emitRoomEvent(room, "battle:dealDamage:success", payload);
    }
    for (const [unitId, value] of Object.entries(effects.heal)) {
      emitRoomEvent(room, "battle:heal:success", { source, target: unitId, value, reason: "skill", skillId: skill.id });
      emitRoomEvent(room, "battle:floatText:success", { unit: unitId, text: `+${value}` });
    }
    // 回蓝（知识启迪）：前端有 battle:restoreMp:success，用同一个事件
    for (const [unitId, value] of Object.entries(effects.mp || {})) {
      emitRoomEvent(room, "battle:restoreMp:success", { target: unitId, value });
      emitRoomEvent(room, "battle:floatText:success", { unit: unitId, text: `+${value} MP` });
    }
    for (const [unitId, value] of Object.entries(effects.shield)) {
      emitRoomEvent(room, "battle:floatText:success", { unit: unitId, text: `护盾 +${value}` });
      emitRoomEvent(room, "battle:addState:success", {
        source,
        target: unitId,
        stateId: "shield",
        stateName: "护盾",
        duration: 2,
        actualValue: value
      });
    }
    for (const state of effects.states) {
      if (state.stateId === "shield") continue;
      emitRoomEvent(room, "battle:addState:success", {
        source,
        target: state.unit,
        stateId: state.stateId,
        stateName: stateLabel(state.stateId),
        duration: state.duration,
        actualValue: state.actualValue ?? null
      });
    }
    // 驱散（净化/识破魔法）和「让敌人技能进冷却」（静默烟雾弹）要让前端把状态/冷却抹掉
    for (const item of effects.removedStates || []) {
      emitRoomEvent(room, "battle:removeState:success", { source, target: item.unit, stateId: item.stateId, stateName: stateLabel(item.stateId) });
      emitRoomEvent(room, "battle:floatText:success", { unit: item.unit, text: `${stateLabel(item.stateId)} 被驱散` });
    }
    for (const item of effects.cooldowns || []) {
      emitRoomEvent(room, "battle:addColddown:success", { source, target: item.unit, skillId: item.skillId, colddown: item.colddown });
    }
    // 施放成功才有技能经验：让技能页的等级/经验条真正会涨。
    // 怪物没有技能页，加经验只会在房间里广播「升到 N 级」，所以只给玩家单位算。
    if (actor.isPlayerUnit) {
      const levelUps = grantSkillExp(actor, skill.id, SKILL_CAST_EXP);
      if (levelUps > 0) {
        emitRoomEvent(room, "battle:floatText:success", { unit: source, text: `${skill.name} 升到 ${actor.skills[skill.id].level} 级` });
        appendBattleLog(room, "skillLevelUp", { source, skillId: skill.id, level: actor.skills[skill.id].level });
      }
      if (syncBattleSkillProgress(actor)) {
        emitToPlayer(actor.uuid, "character:getSkills:success", normalizePlayerSkills(players.get(actor.uuid)));
      }
      // 生活经验（种瓜得瓜）：写回存档并刷新属性面板，否则前端看到的还是旧等级
      if (effects.lifeExp) {
        const battlePlayer = players.get(actor.uuid);
        if (battlePlayer) {
          const next = addStatusExp(battlePlayer, effects.lifeExp.status, effects.lifeExp.amount);
          emitRoomEvent(room, "battle:floatText:success", {
            unit: source,
            text: `+${effects.lifeExp.amount} ${LIFE_STATUS_LABELS[effects.lifeExp.status] || effects.lifeExp.status} 经验`
          });
          emitToPlayer(actor.uuid, "dispatchCharacterStatusInfo", next);
        }
      }
    }
  } else {
    // 普攻选目标要认状态：潜行的人选不到、嘲讽优先打嘲讽来源、慌乱的人不分敌我
    const target = pickBasicAttackTarget(actor, opponents, battleInfo.members);
    if (!target) return;
    const attack = Number(actor.status?.attacking?.level) || Number(actor.attack) || 5;
    const defense = Number(target.status?.defencing?.level) || Number(target.defense) || 0;
    // 参考站的普通攻击没有随机浮动：固定基础伤害，再按目标的防御减免结算
    const damage = battleFinalDamage(attack, defense);
    const applied = applyIncomingDamage(target, damage);
    const damagePayload = {
      source,
      type: "skill",
      castSkillId: "baseAttack",
      target: [{ unit: target.uuid, value: damage, fDamage: applied.damage, remainingHp: target.hp, damageType: "physical", shieldDamage: applied.absorbedByShield, causeBy: {} }],
      sourceUnitUuid: source,
      targetUnitUuidList: [target.uuid],
      damageType: "physical"
    };
    emitRoomEvent(room, "battle:castSkill:success", { source, skillId: "baseAttack", skillName: "普通攻击" });
    appendBattleLog(room, "damage", { ...damagePayload, damage: damagePayload.target });
    emitRoomEvent(room, "battle:dealDamage:success", damagePayload);
    emitRoomEvent(room, "battle:drawLine:success", { source, target: target.uuid, color: "#f56c6c" });
    emitRoomEvent(room, "battle:floatText:success", { unit: target.uuid, text: `-${damage}` });
  }

  battleInfo.currentTurnIndex = (battleInfo.currentTurnIndex + 1) % Math.max(1, battleInfo.turnOrder.length);
  if (battleInfo.currentTurnIndex === 0) battleInfo.passedTurn += 1;
  // 回合开始回复：每 1 点耐力回复 0.1 生命，每 1 点智力回复 0.05 魔法（向下取整，参考站多数回合回复为 0）
  // 装备的 hpRegen / mpRegen（生命披风 +5、法师披风 +8 这类）直接加在上面
  battleInfo.members.forEach((unit) => {
    if (!(unit.hp > 0)) return;
    const equipHpRegen = Math.floor(Number(unit.equipRegen?.hp) || 0);
    const equipMpRegen = Math.floor(Number(unit.equipRegen?.mp) || 0);
    const hpRegen = Math.floor((Number(unit.status?.stamina?.level) || 1) * 0.1) + equipHpRegen;
    const mpRegen = Math.floor((Number(unit.status?.intelligence?.level) || 1) * 0.05) + equipMpRegen;
    if (hpRegen > 0) unit.hp = Math.min(unit.maxHp, unit.hp + hpRegen);
    if (mpRegen > 0) unit.mp = Math.min(unit.maxMp, unit.mp + mpRegen);
    if (hpRegen > 0) emitRoomEvent(room, "battle:heal:success", { source: unit.uuid, target: unit.uuid, value: hpRegen, reason: "turnRegen" });
    if (mpRegen > 0) emitRoomEvent(room, "battle:restoreMp:success", { target: unit.uuid, value: mpRegen });
  });
  emitRoomEvent(room, "battle:turnEnd:success", { source });
  emitRoomEvent(room, "battle:update:success", battleInfo);

  const nextResult = battleInfo.members.some((unit) => unit.isPlayerUnit && unit.hp > 0)
    ? battleInfo.members.some((unit) => !unit.isPlayerUnit && unit.hp > 0) ? null : "PLAYER_WIN"
    : "PLAYER_LOSE";
  if (nextResult) return finishBattle(room, nextResult);
  const delay = Math.max(500, Number(room.turnDurationMs) || 1800);
  battleTimers.set(room.uuid, setTimeout(() => resolveBattleTurn(room), delay));
}

function startBattleTurns(room) {
  const timer = battleTimers.get(room.uuid);
  if (timer) clearTimeout(timer);
  battleTimers.set(room.uuid, setTimeout(() => resolveBattleTurn(room), 900));
}

// ---- 战斗循环自愈 ----
// 房间里没人在线时，整场战斗完全靠 setTimeout 链推进：只要有一环丢了（重连时被 clear、
// 回调里抛异常、系统休眠导致定时器漂移…），房间就会停在 "battling" 却再也不出回合，
// 玩家回来只看到「战斗结束」。这里每 5 秒巡检一次，缺定时器就补、战斗数据丢了就重开一轮。
const BATTLE_WATCHDOG_INTERVAL_MS = 5000;

function roomBattleInfo(room) {
  return room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean) || null;
}

function reviveBattleLoop(room) {
  if (!room.memberIds.length) return;
  if (room.status === "battling") {
    if (!roomBattleInfo(room)) {
      // 回合数据没了但房间还标着「战斗中」：重开一场，别让房间永久卡住
      console.warn(`[battle] 房间 ${room.uuid} 战斗数据丢失，直接开始新一场`);
      beginBattleRound(room);
      return;
    }
    if (!battleTimers.has(room.uuid)) {
      console.warn(`[battle] 房间 ${room.uuid} 回合定时器丢失，补一次回合`);
      startBattleTurns(room);
    }
    return;
  }
  if (room.status !== "waiting_for_restart" || battleTimers.has(room.uuid)) return;
  const remain = (Number(room.waitingForRestartTime) || 0) - Date.now();
  if (remain <= 0) {
    console.warn(`[battle] 房间 ${room.uuid} 重启定时器丢失且已超时，立即开下一场`);
    beginBattleRound(room);
    return;
  }
  battleTimers.set(room.uuid, setTimeout(() => {
    battleTimers.delete(room.uuid);
    if (room.memberIds.length && room.status === "waiting_for_restart") beginBattleRound(room);
  }, remain));
}

setInterval(() => {
  for (const room of battleRooms.values()) {
    try {
      reviveBattleLoop(room);
    } catch (error) {
      console.error("[battle] 巡检异常", room.uuid, error);
    }
  }
}, BATTLE_WATCHDOG_INTERVAL_MS).unref();

function removePlayerFromBattleRoom(player, socket, { emit = true } = {}) {
  const room = getBattleRoom(player.currentBattleRoomId);
  if (!room) {
    player.currentBattleRoomId = null;
    player.battleInfo = null;
    return null;
  }
  room.memberIds = room.memberIds.filter((uuid) => uuid !== player.uuid);
  delete room.readyMap[player.uuid];
  for (const offering of room.offerings.filter((item) => item.fromUserUuid === player.uuid)) {
    player.inventory[offering.resourceId] ??= { count: 0 };
    player.inventory[offering.resourceId].count += offering.count;
  }
  room.offerings = room.offerings.filter((offering) => offering.fromUserUuid !== player.uuid);
  player.currentBattleRoomId = null;
  player.battleInfo = null;
  if (socket) {
    emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
    emitGameEvent(socket, "inventoryUpdated", player.inventory);
  }
  if (!room.memberIds.length) {
    battleRooms.delete(room.uuid);
    if (emit && socket) emitGameEvent(socket, "battleRoom:leave:success", null);
    return room;
  }
  if (room.ownerId === player.uuid) room.ownerId = room.memberIds[0];
  if (room.status === "battling") {
    room.status = "ended";
    for (const memberId of room.memberIds) players.get(memberId).battleInfo = null;
    emitRoomEvent(room, "battle:end:success", { battleStatus: "PLAYER_LOSE" });
  }
  emitRoomUpdate(room);
  if (emit && socket) emitGameEvent(socket, "battleRoom:leave:success", publicBattleRoom(room));
  return room;
}

function handleBattleRoomEvent(socket, event, data) {
  const player = socket.player;
  const fail = (message, suffix = ":error") => emitGameEvent(socket, `${event}${suffix}`, { message });
  const emitSuccess = (name, value) => emitGameEvent(socket, `${name}:success`, value);
  const room = getBattleRoom(data.roomId || player.currentBattleRoomId);

  if (event === "battleRoom:create") {
    if (player.currentBattleRoomId) return fail("请先离开当前房间");
    if (!String(data.name || "").trim()) return fail("请输入房间名称");
    const battleType = data.battleType === "worldBoss" ? "worldBoss" : "normal";
    const uuid = crypto.randomUUID();
    const memberIds = [player.uuid];
    const newRoom = {
      uuid,
      name: String(data.name).trim().slice(0, 20),
      ownerId: data.ownerId && data.ownerId === player.uuid ? data.ownerId : player.uuid,
      memberIds,
      maxMembers: 4,
      readyMap: { [player.uuid]: true },
      status: "waiting",
      battleType,
      area: data.area || "forest_001",
      difficulty: Math.max(0, Number(data.difficulty) || 0),
      isPublic: data.isPublic !== false,
      autoRestart: Boolean(data.autoRestart),
      autoStartBattle: Boolean(data.autoStartBattle),
      autoRestartDenseFogMode: Boolean(data.autoRestartDenseFogMode),
      denseFogMode: Boolean(data.denseFogMode),
      phantomUuidList: Array.isArray(data.phantomUuidList) ? data.phantomUuidList : [],
      publicBattleLoot: data.publicBattleLoot !== false,
      // 硬核猫房间的「金币/战利品比例」滑块（0-10）：金币 -10%/格，战利品 +7.5%/格
      lootGoldSlider: Math.max(0, Math.min(10, Math.floor(Number(data.lootGoldSlider) || 0))),
      // 「查看战斗奖励」面板的累计战利品，停战后保留 6 小时
      battleRewardInfo: {},
      battleRewardInfoExpireAt: null,
      worldBossId: data.worldBossId || null,
      worldBossVersion: data.worldBossVersion,
      afterWin: data.afterWin || null,
      autoWorldBossBattleConf: { type: "none", config: {} },
      offerings: [],
      turn: 0,
      createdAt: Date.now(),
      lastUpdateAt: Date.now()
    };
    battleRooms.set(uuid, newRoom);
    player.currentBattleRoomId = uuid;
    emitSuccess(event, publicBattleRoom(newRoom));
    emitRoomUpdate(newRoom);
    return;
  }

  if (event === "battleRoom:list") {
    const page = Math.max(1, Math.floor(Number(data.page) || 1));
    const filtered = [...battleRooms.values()].filter((candidate) =>
      (!data.name || candidate.name.toLowerCase().includes(String(data.name).toLowerCase())) &&
      (!data.area || candidate.area === data.area) &&
      (!data.onlyWaiting || candidate.status === "waiting") &&
      (candidate.isPublic || candidate.memberIds.includes(player.uuid))
    );
    emitSuccess(event, filtered.slice((page - 1) * 20, page * 20).map(publicBattleRoom));
    return;
  }

  if (event === "battleRoom:getCurrentRoom") {
    if (!room) return fail("当前不在房间", ":error");
    emitSuccess(event, publicBattleRoom(room));
    return;
  }

  if (event === "battleRoom:join") {
    const target = getBattleRoom(data.roomId);
    if (!target || target.status !== "waiting") return fail("房间不存在或已开始");
    if (player.currentBattleRoomId) return fail("请先离开当前房间");
    if (target.memberIds.length >= target.maxMembers) return fail("房间人数已满");
    target.memberIds.push(player.uuid);
    target.readyMap[player.uuid] = false;
    player.currentBattleRoomId = target.uuid;
    emitSuccess(event, publicBattleRoom(target));
    emitRoomUpdate(target);
    return;
  }

  if (event === "battleRoom:leave" || event === "battle:leaveBattle") {
    if (!room) return fail("当前不在房间", event === "battleRoom:leave" ? ":error" : ":error");
    if (event === "battle:leaveBattle") emitSuccess(event, { roomId: room.uuid });
    removePlayerFromBattleRoom(player, socket, { emit: true });
    return;
  }

  if (!room || !room.memberIds.includes(player.uuid)) return fail("你不在该房间");

  if (event === "battleRoom:rewardInfo") {
    // 「查看战斗奖励」：下发本房间当前成员的战利品累计（itemId -> { count }）。
    // 前端订阅封装会先剥一层 data，而组件再取 e.data，所以这里要多包一层（与 characterInitData 一致）。
    emitSuccess(event, { data: battleRewardInfoOf(room) });
    return;
  }

  if (event === "battleRoom:resetSelfBattleRewardInfo") {
    if (room.battleRewardInfo && typeof room.battleRewardInfo === "object") delete room.battleRewardInfo[player.uuid];
    emitSuccess(event, { uuid: player.uuid });
    return;
  }

  if (event === "battleRoom:kick") {
    if (room.ownerId !== player.uuid) return fail("只有房主可以移除成员");
    const targetId = data.userUuid || data.memberUuid || data.targetUuid;
    const target = players.get(targetId);
    if (!target || targetId === player.uuid || !room.memberIds.includes(targetId)) return fail("成员不存在");
    const targetSocket = [...io.sockets.sockets.values()].find((item) => item.player?.uuid === targetId);
    target.currentBattleRoomId = room.uuid;
    removePlayerFromBattleRoom(target, targetSocket, { emit: true });
    emitSuccess(event, publicBattleRoom(room));
    return;
  }

  if (event === "battleRoom:updateReadyState") {
    if (room.status !== "waiting" && room.status !== "ended") return fail("当前无法切换准备状态", ":error");
    room.readyMap[player.uuid] = Boolean(data.ready);
    emitRoomUpdate(room);
    return;
  }

  if (event === "battleRoom:update") {
    if (room.ownerId !== player.uuid || !["waiting", "ended"].includes(room.status)) return fail("当前无法修改房间");
    const editable = ["name", "area", "isPublic", "autoRestart", "autoStartBattle", "difficulty", "denseFogMode", "autoRestartDenseFogMode", "phantomUuidList", "publicBattleLoot", "lootGoldSlider", "battleType", "worldBossId", "worldBossVersion", "afterWin"];
    for (const key of editable) if (data[key] !== undefined) room[key] = data[key];
    room.difficulty = Math.max(0, Math.min(BATTLE_DIFFICULTY_CATALOG.length, Math.floor(Number(room.difficulty) || 0)));
    room.lootGoldSlider = Math.max(0, Math.min(10, Math.floor(Number(room.lootGoldSlider) || 0)));
    room.lastUpdateAt = Date.now();
    emitSuccess(event, publicBattleRoom(room));
    emitRoomUpdate(room);
    return;
  }

  if (event === "battleRoom:startBattle") {
    if (room.ownerId !== player.uuid) return fail("只有房主可以开始战斗", ":error");
    if (!room.memberIds.every((uuid) => room.readyMap[uuid])) return fail("所有成员准备后才能开始战斗", ":error");
    if (room.status === "battling") return fail("战斗已开始", ":error");
    beginBattleRound(room);
    emitSuccess(event, publicBattleRoom(room));
    return;
  }

  if (event === "battle:stopBattle") {
    if (room.ownerId !== player.uuid) return fail("只有房主可以结束战斗", ":error");
    if (room.status !== "battling") return fail("当前没有进行中的战斗", ":error");
    const timer = battleTimers.get(room.uuid);
    if (timer) clearTimeout(timer);
    battleTimers.delete(room.uuid);
    const battleInfo = room.memberIds.map((uuid) => players.get(uuid)?.battleInfo).find(Boolean);
    if (battleInfo) {
      battleInfo.battleStatus = "ESCAPED";
      emitRoomEvent(room, "battle:update:success", battleInfo);
      emitRoomEvent(room, "battle:end:success", { battleStatus: "ESCAPED", roomId: room.uuid });
    }
    room.status = "ended";
    room.lastUpdateAt = Date.now();
    room.memberIds.forEach((uuid) => { room.readyMap[uuid] = uuid !== room.ownerId; });
    emitSuccess(event, { roomId: room.uuid });
    room.memberIds.forEach((uuid) => { players.get(uuid).battleInfo = null; });
    emitRoomUpdate(room);
    return;
  }

  if (event === "battleRoom:reorder") {
    if (room.ownerId !== player.uuid) return fail("只有房主可以调整成员顺序");
    const requested = Array.isArray(data.newMemberUuids) ? data.newMemberUuids : [];
    room.memberIds = [...requested.filter((uuid) => room.memberIds.includes(uuid)), ...room.memberIds.filter((uuid) => !requested.includes(uuid))];
    emitSuccess(event, publicBattleRoom(room));
    emitRoomUpdate(room);
    return;
  }

  if (event === "battleRoom:setAutoWorldBossBattleConf") {
    room.autoWorldBossBattleConf = data.autoWorldBossBattleConf || { type: "none", config: {} };
    emitSuccess(event, publicBattleRoom(room));
    emitRoomUpdate(room);
    return;
  }

  if (event === "battleRoom:addOffering" || event === "battleRoom:returnOffering") {
    if (room.status !== "waiting" && room.status !== "ended") return fail("戰鬥開始後不能調整契約");
    if (event === "battleRoom:addOffering") {
      if (!data.specId || !data.resourceId || !Number.isFinite(Number(data.count)) || Number(data.count) < 1) return fail("契约参数无效");
      const count = Math.floor(Number(data.count));
      const item = player.inventory[data.resourceId];
      if (!item || Number(item.count) < count) return fail("物品数量不足");
      item.count -= count;
      room.offerings.push({ specId: data.specId, count, resourceId: data.resourceId, fromUserUuid: player.uuid, consumedCount: 0 });
      emitSuccess(event, publicBattleRoom(room));
    } else {
      const offeringIndex = room.offerings.findIndex((item) => item.specId === data.specId && item.fromUserUuid === player.uuid);
      if (offeringIndex < 0) return fail("契约不存在");
      const [offering] = room.offerings.splice(offeringIndex, 1);
      player.inventory[offering.resourceId] ??= { count: 0 };
      player.inventory[offering.resourceId].count += offering.count;
      emitSuccess(event, publicBattleRoom(room));
    }
    emitRoomUpdate(room);
    return;
  }

  if (event.startsWith("battle:") && player.battleInfo && room.status === "battling") {
    if (event === "battle:update") return emitSuccess(event, player.battleInfo);
    if (event === "battle:fullInfo") return emitSuccess(event, { battleInfo: player.battleInfo });
    // 其余 battle:* 输入没有可信的客户端指令语义；交给已知未实现或未知事件错误契约。
    return false;
  }
  return false;
}

function getTaskRequirements(actionId) {
  return actionRequirements[actionId] || [];
}

// ---- 生活装备降低动作消耗 ----
// 装备的效果写在资源表的 onEquip[].resourceRequirementModifyEffect 里：
// `{resource:"__satiety", actionId:"woodcutting", decrease:1}`（采集戒指让 8 个采集动作少扣 1 饱食度）。
// 只算生活栏位；`actionId` 支持具体动作或 `allXxxAction` 分组。结果夹到 0（不会倒贴资源）。
function workRequirementModifier(player, actionId, resourceId) {
  const slots = player?.workEquipment;
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return 0;
  let delta = 0;
  for (const equipped of Object.values(slots)) {
    const item = resourceCatalog[equipped];
    if (!item) continue;
    for (const effect of item.onEquip || []) {
      for (const entry of effect?.resourceRequirementModifyEffect || []) {
        if (String(entry?.resource || "") !== resourceId) continue;
        if (!actionDurationMatches(String(entry?.actionId || ""), actionId)) continue;
        delta += (Number(entry.increase) || 0) - (Number(entry.decrease) || 0);
      }
    }
  }
  return delta;
}

// 实际要扣的材料（含生活装备修正）
function taskRequirementsFor(player, actionId) {
  return getTaskRequirements(actionId).map((requirement) => ({
    resourceId: requirement.resourceId,
    count: Math.max(0, requirement.count + workRequirementModifier(player, actionId, requirement.resourceId))
  }));
}

function taskRequirementError(player, actionId) {
  for (const requirement of taskRequirementsFor(player, actionId)) {
    if (getAssetCount(player, requirement.resourceId) < requirement.count) {
      return { resourceId: requirement.resourceId, required: requirement.count, available: getAssetCount(player, requirement.resourceId) };
    }
  }
  return null;
}

function consumeTaskRequirements(player, actionId) {
  const requirements = taskRequirementsFor(player, actionId);
  const error = taskRequirementError(player, actionId);
  if (error) return error;
  for (const requirement of requirements) if (requirement.count > 0) removeAsset(player, requirement.resourceId, requirement.count);
  return null;
}

// ---- 建造（building）状态 ----
// 前端 store 形状是 { [buildingId]: { status } }，只认 status === "BUILT"：
//   My() = e("building", () => ({}))  →  v = "BUILT" == a[buildingId]?.status
// （UNBUILD / BUILDING / NORMAL / PREPARE_UPGRADE 那套枚举属于公共建筑 villageBuilding，不是这里）
function buildingState(player, type) {
  const entry = player?.building?.[type];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

function isBuildingBuilt(player, type) {
  return buildingState(player, type)?.status === "BUILT";
}

// 建造任务跑完一次 → 建筑落成。已经是 BUILT 的不会重复写，返回 false。
function completeBuildingAction(player, actionId) {
  const action = buildingActions[actionId];
  if (!action) return false;
  const current = buildingState(player, action.type);
  if (current?.status === "BUILT") return false;
  if (!player.building || typeof player.building !== "object" || Array.isArray(player.building)) player.building = {};
  player.building[action.type] = {
    type: action.type,
    status: "BUILT",
    level: Math.max(1, Number(current?.level) || 0),
    builtAt: new Date().toISOString()
  };
  return true;
}

function taskActionExists(actionId) {
  return Boolean(actionId && (actionDurationMs[actionId] || actionRewards[actionId] || actionImprovements[actionId] || actionRequirements[actionId]));
}

// ---- 生活装备缩短动作耗时 ----
// 装备的效果写在资源表的 onEquip[].actionDurationEffect 里，例如斧头
// `{ action:"woodcutting", decrease:1000 }`、矿工腰带 `{ action:"allMiningAction", decreasePercent:.08 }`。
// 字段有四种：increase / decrease（绝对毫秒）、increasePercent / decreasePercent（小数）。
// action 可能是具体动作，也可能是 `allXxxAction` 分组（对应 jresource 里的分组表）+ `allAction`（全部动作）。
// 注意 `fishing` / `farming` 既是动作名也恰好是分组名，这里按动作理解（分组要写 allFishingAction）。
const ACTION_DURATION_GROUPS = {
  allMiningAction: "mining",
  allLevel1Manufacture: "level1Manufacture",
  allForgingAction: "forging",
  allSewingAction: "sewing",
  allMysteriousAction: "mysterious",
  allExerciseAction: "exercise",
  allFarmingAnimalAction: "farmingAnimal",
  allCookingAction: "cooking",
  allCollectingAction: "collection",
  allFishingAction: "fishing",
  allExploreAction: "explore"
};
const MIN_TASK_DURATION_MS = 1000;
const DEFAULT_TASK_DURATION_MS = 24e3;

function actionDurationMatches(target, actionId) {
  if (!target || !actionId) return false;
  if (target === "allAction") return true;
  const group = ACTION_DURATION_GROUPS[target];
  if (group) return (actionGroupCatalog[group] || []).includes(actionId);
  return target === actionId;
}

// 只算生活栏位（workEquipment）：同一件装备放进战斗栏位不该影响生活耗时。
function workDurationModifier(player, actionId) {
  let absolute = 0;
  let percent = 0;
  const slots = player?.workEquipment;
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return { absolute, percent };
  for (const resourceId of Object.values(slots)) {
    const item = resourceCatalog[resourceId];
    if (!item) continue;
    for (const effect of item.onEquip || []) {
      for (const entry of effect?.actionDurationEffect || []) {
        if (!actionDurationMatches(String(entry?.action || ""), actionId)) continue;
        absolute += (Number(entry.increase) || 0) - (Number(entry.decrease) || 0);
        percent += (Number(entry.increasePercent) || 0) - (Number(entry.decreasePercent) || 0);
      }
    }
  }
  return { absolute, percent };
}

// 先叠绝对值再乘百分比，最后夹到前端展示用的 1000ms 下限（前端图表也是 Math.max(1e3, …)）。
function taskDurationFor(player, actionId, base = actionDurationMs[actionId] || DEFAULT_TASK_DURATION_MS) {
  const baseDuration = Number(base) > 0 ? Number(base) : DEFAULT_TASK_DURATION_MS;
  if (!player) return baseDuration;
  const { absolute, percent } = workDurationModifier(player, actionId);
  if (!absolute && !percent) return baseDuration;
  return Math.max(MIN_TASK_DURATION_MS, Math.round((baseDuration + absolute) * (1 + percent)));
}

// 换装/上线时重算队列里每项任务的时长：已完成比例不变，剩余时间按新时长等比缩放，
// 否则玩家把装备换上后已经排着的任务还是旧时长（看起来"没生效"）。
// 显式指定过 duration 的任务（durationOverride）按定值处理，不参与重算；
// 老存档的任务没有 baseDuration，就把当时存下的 duration 当作基准（那时候还没算过装备）。
function refreshWorkTaskDurations(player, now = Date.now()) {
  if (!Array.isArray(player?.taskQueue) || !player.taskQueue.length) return false;
  let changed = false;
  for (const task of player.taskQueue) {
    if (!task || task.durationOverride) continue;
    const base = Number(task.baseDuration) || Number(task.duration) || actionDurationMs[task.actionId] || DEFAULT_TASK_DURATION_MS;
    const next = taskDurationFor(player, task.actionId, base);
    if (task.baseDuration !== base) {
      task.baseDuration = base;
      changed = true;
    }
    const previous = Number(task.duration) || 0;
    if (!next || next === previous) continue;
    const startedAt = Number(task.lastSubtaskDoneTime) || now;
    const ratio = previous > 0 ? Math.min(1, Math.max(0, (now - startedAt) / previous)) : 0;
    task.duration = next;
    task.lastSubtaskDoneTime = now - Math.round(ratio * next);
    changed = true;
  }
  return changed;
}

// 前端 `characterInitData.allGameActionDurationDetail` / `allGameActionResourceRequirementDetail`
// 会被合并进它自己的时长/消耗模型（index bundle 10959），队列面板的「⏰ 预计完成」「😋 饱食度」
// 和排任务弹窗的次数估算都读这两个模型，所以装备修正要从这里下发。
//
// 前端那边是「整包替换 + 用 bundle 自带基线补缺键」：
//   y.value = e.allGameActionDurationDetail; for (const t of v(c)) y.value[t] || (y.value[t] = c[t]);
// 所以只发被装备改动过的动作就够了，其余键会自动回退到基线。
// 全量下发的话首包会从 ~3KB 涨到 ~130KB（389 个动作 + 386 条消耗表），没必要。
function actionDurationDetailFor(player) {
  const detail = {};
  for (const [actionId, base] of Object.entries(actionDurationMs)) {
    const final = taskDurationFor(player, actionId, base);
    if (final === base) continue;
    detail[actionId] = { base, final, fromEquipmentModify: final - base };
  }
  return detail;
}

function actionResourceRequirementDetailFor(player) {
  const detail = {};
  for (const [actionId, requirements] of Object.entries(actionRequirements)) {
    const entries = requirements.map((requirement) => {
      const base = requirement.count;
      const final = Math.max(0, base + workRequirementModifier(player, actionId, requirement.resourceId));
      return { resourceId: requirement.resourceId, base, final, fromEquipmentModify: final - base };
    });
    // 只有真被改动过才整条下发；同一动作的几个资源要一起发，否则前端会缺项
    if (entries.some((entry) => entry.fromEquipmentModify)) detail[actionId] = entries;
  }
  return detail;
}

function makeTask(payload = {}, player = null) {
  const createTime = payload.createTime || Date.now();
  const suppliedDuration = Number(payload.duration);
  // 显式 duration 视为定值（离线补算/运维用），不吃生活装备修正
  const durationOverride = Number.isFinite(suppliedDuration) && suppliedDuration > 0;
  const baseDuration = durationOverride ? suppliedDuration : actionDurationMs[payload.actionId] || DEFAULT_TASK_DURATION_MS;
  return {
    uuid: payload.uuid || crypto.randomUUID(),
    actionId: payload.actionId,
    repeatCount: Math.max(1, Number(payload.repeatCount) || 1),
    currentRepeat: Math.max(0, Number(payload.currentRepeat) || 0),
    createTime,
    lastSubtaskDoneTime: payload.lastSubtaskDoneTime || createTime,
    baseDuration,
    durationOverride: durationOverride || undefined,
    duration: durationOverride ? suppliedDuration : taskDurationFor(player, payload.actionId, baseDuration),
    paused: Boolean(payload.paused),
    pauseReason: payload.pauseReason || null
  };
}

function dispatchTaskQueue(socket) {
  emitGameEvent(socket, "dispatchTaskQueueToClient", socket.player.taskQueue);
}

function applyActionRewards(player, actionId) {
  const gained = {};
  for (const reward of actionRewards[actionId] || []) {
    if (Math.random() > reward.percent) continue;
    const minimum = reward.count ?? reward.min ?? 1;
    const maximum = reward.count ?? reward.max ?? minimum;
    const count = Math.max(1, Math.floor(minimum + Math.random() * (maximum - minimum + 1)));
    addAsset(player, reward.resourceId, count);
    if (reward.resourceId === "gold") recordWeeklyRankingGain(player, "goldEarned", count);
    gained[reward.resourceId] = { count: (gained[reward.resourceId]?.count || 0) + count };
  }
  return gained;
}

function useCosmeticItem(player, itemId, multiple) {
  const item = player.inventory?.[itemId];
  const metadata = resourceCatalog[itemId];
  const count = Math.max(1, Math.floor(Number(multiple) || 1));
  const plan = cosmeticUsePlan(metadata);
  if (!plan.grants.length && !plan.flags.length) return null;
  if (!item || (Number(item.count) || 0) < count) return { error: "物品数量不足" };
  if (count !== 1 || Number(metadata?.maxUseEachTime) === 1) {
    if (count !== 1) return { error: "该物品每次只能使用 1 个" };
  }
  const style = normalizeStyleState(player.style, player.uniqueFlag);
  if (plan.grants.some(({ category, key }) => style.owned[category].includes(key))
    || plan.flags.some((flag) => hasUniqueFlag(player, flag))) return { error: "该装饰已经解锁" };
  const newFlags = plan.flags.filter((flag) => !hasUniqueFlag(player, flag));
  if (normalizeUniqueFlags(player.uniqueFlag).length + newFlags.length > UNIQUE_FLAG_LIMIT) return { error: "特殊标记数量已达上限" };
  const next = structuredClone(style);
  for (const grant of plan.grants) {
    if (next.owned[grant.category].length >= STYLE_OWNED_LIMIT) return { error: "样式数量已达上限" };
    next.owned[grant.category].push(grant.key);
  }
  for (const flag of newFlags) addUniqueFlagSet(player, flag);
  next.version = style.version + 1;
  next.updatedAt = nextUpdatedAt(style.updatedAt);
  player.style = next;
  item.count = (Number(item.count) || 0) - 1;
  if (item.count <= 0) delete player.inventory[itemId];
  return { cosmetic: true, consumed: 1, gained: {} };
}

function useItem(player, itemId, multiple) {
  const cosmetic = useCosmeticItem(player, itemId, multiple);
  if (cosmetic) return cosmetic;
  const count = Math.max(1, Math.floor(Number(multiple) || 1));
  const item = player.inventory[itemId];
  if (!item || (Number(item.count) || 0) < count) return { error: "物品数量不足" };
  // 技能书：前端「使用物品」按钮点完只会发 effectAction:useItem，
  // 真正学技能要做在这里（前端技能页只认 character:getSkills:success）。
  // 一次只能学一本（学会了再用就没意义了）。
  const learnedSkillId = skillIdFromBook(itemId);
  if (learnedSkillId) {
    const list = normalizePlayerSkills(player);
    if (list.some((entry) => entry.skillId === learnedSkillId)) return { error: "你已经学会该技能了" };
    list.push({ skillId: learnedSkillId, level: 1, exp: 0, enabled: true, order: list.length, logic: [] });
    player.skillList = list;
    const left = (Number(item.count) || 0) - 1;
    if (left <= 0) delete player.inventory[itemId];
    else item.count = left;
    return { learnedSkill: learnedSkillId, consumed: 1 };
  }
  const gained = {};
  for (let index = 0; index < count; index += 1) {
    for (const effect of itemUseEffects[itemId] || []) {
      if (Math.random() > effect.percent) continue;
      const current = Number(player.inventory[effect.resource]?.count) || 0;
      player.inventory[effect.resource] = { count: current + effect.increase };
      gained[effect.resource] = { count: (gained[effect.resource]?.count || 0) + effect.increase };
    }
  }
  item.count -= count;
  if (item.count <= 0) delete player.inventory[itemId];
  return { gained };
}

const EQUIPMENT_DECORATE_SLOTS = Array.from({ length: 9 }, (_, index) => `decorate${index + 1}`);
const EQUIPMENT_BASE_SLOTS = ["cloak", "head", "body", "arm", "leg", "foot", "leftHand", "rightHand"];
const EQUIPMENT_SLOT_IDS = [...EQUIPMENT_BASE_SLOTS, "leftHand2", "rightHand2", ...EQUIPMENT_DECORATE_SLOTS];
const EQUIPMENT_EQUIP_PARTS = [...EQUIPMENT_BASE_SLOTS, ...EQUIPMENT_DECORATE_SLOTS];

function equipmentForType(player, rawType) {
  const type = rawType === "battle" ? "battle" : "work";
  const key = type === "battle" ? "battleEquipment" : "workEquipment";
  if (!player[key] || typeof player[key] !== "object" || Array.isArray(player[key])) player[key] = {};
  for (const [slot, resourceId] of Object.entries(player[key])) {
    if (!EQUIPMENT_SLOT_IDS.includes(slot) || typeof resourceId !== "string" || !resourceCatalog[resourceId]) delete player[key][slot];
  }
  return { type, equipment: player[key] };
}

// 槽位分配：界面从某个明确槽位选择装备时必须落在该目标槽；
// 未携带目标槽位的旧客户端仍按主槽 / 首个空饰品槽分配。
function resolveEquipmentSlot(item, equipment, requestedPart) {
  const equipPart = String(item?.equipPart || "");
  if (!EQUIPMENT_EQUIP_PARTS.includes(equipPart)) return null;
  const target = String(requestedPart || "");
  if (target) {
    if (!EQUIPMENT_SLOT_IDS.includes(target)) return null;
    if (EQUIPMENT_DECORATE_SLOTS.includes(equipPart)) {
      return EQUIPMENT_DECORATE_SLOTS.includes(target) ? target : null;
    }
    if (target === equipPart) return target;
    if (equipPart === "rightHand" && target === "rightHand2") return target;
    if (equipPart === "leftHand" && target === "leftHand2") return target;
    return null;
  }
  if (!EQUIPMENT_DECORATE_SLOTS.includes(equipPart)) return equipPart;
  return EQUIPMENT_DECORATE_SLOTS.find((slot) => !equipment[slot]) || equipPart;
}

// 只有带「耗时 / 消耗」修正的装备才会改动前端那两份动作模型，其它装备没必要重发整包初始数据
function affectsActionDetail(item) {
  if (!item) return false;
  return (item.onEquip || []).some((effect) => effect?.actionDurationEffect?.length || effect?.resourceRequirementModifyEffect?.length);
}

function equipItem(player, resourceId, rawType, requestedPart) {
  const item = resourceCatalog[resourceId];
  if (!item || !item.equipPart) return { error: "该物品不可装备" };
  if (rawType !== "battle" && rawType !== "work") return { error: "装备栏类型无效" };
  const { type, equipment } = equipmentForType(player, rawType);
  const equipmentTypes = Array.isArray(item.equipmentType) ? item.equipmentType : [];
  if (!equipmentTypes.includes(type)) return { error: `该物品不能装备到${type === "battle" ? "战斗" : "生活"}装备栏` };
  if (getAssetCount(player, resourceId) < 1) return { error: "背包中没有该装备" };
  const slot = resolveEquipmentSlot(item, equipment, requestedPart);
  if (!slot) return { error: "该装备无法装备到所选部位" };
  if (type === "battle") {
    const { disabled } = battleSlotState(skillTreeCatalog, player.skillTree || {});
    if (disabled.includes(slot)) return { error: "该部位尚未解锁或已被专精禁用，无法装备" };
  }
  const previous = equipment[slot];
  if (previous === resourceId) return { error: "该装备已在槽位中" };
  if (!removeAsset(player, resourceId, 1)) return { error: "背包中没有该装备" };
  equipment[slot] = resourceId;
  if (previous) addAsset(player, previous, 1);
  return { type, equipment, slot, replaced: previous || null };
}

function unequipItem(player, part, rawType) {
  if (!EQUIPMENT_SLOT_IDS.includes(String(part || ""))) return { error: "装备槽位无效" };
  const { type, equipment } = equipmentForType(player, rawType);
  const resourceId = equipment[part];
  if (!resourceId) return { error: "该槽位没有装备" };
  delete equipment[part];
  addAsset(player, resourceId, 1);
  return { type, equipment, slot: part, resourceId };
}

const QUEST_WINDOW_MS = 4 * 60 * 60 * 1000;
const QUEST_ACTION_POOL = ["pickBerry", "gatherMushroom", "fishing", "pickShell", "woodcutting"];
const QUEST_SEQ_START = 37;
const QUEST_MAX_COUNT = 10;
const QUEST_REROLL_BASE_COST = 250;
const QUEST_REWARD_BASE_GOLD = 18500;
const QUEST_REWARD_GOLD_STEP = 500;

function questWindowStart(timestamp) {
  return Math.floor(timestamp / QUEST_WINDOW_MS) * QUEST_WINDOW_MS;
}

// 任务编号与会参考站一致：首条 37 次，之后每条 +1，动作在 5 个生活动作里轮转；
// 金币 18500 起每条 +500，猫爪印章每 4 条 +1。
function makeQuest(player, createdAtTimestamp) {
  const index = Math.max(0, Math.floor(Number(player.questSeq) || 0));
  player.questSeq = index + 1;
  const count = QUEST_SEQ_START + index;
  const actionId = QUEST_ACTION_POOL[index % QUEST_ACTION_POOL.length];
  const title = `${actionNames[actionId] || actionId}${count}次`;
  const gold = QUEST_REWARD_BASE_GOLD + (count - QUEST_SEQ_START) * QUEST_REWARD_GOLD_STEP;
  const stamp = 22 + Math.floor((count - QUEST_SEQ_START) / 4);
  const rewardMap = { catPawStamp: { count: stamp }, gold: { count: gold } };
  return {
    uuid: crypto.randomUUID(),
    name: title,
    title,
    description: "亲自完成生活行动即可获得奖励",
    actionId,
    targetCount: count,
    currentCount: 0,
    progress: 0,
    rewardMap,
    reward: rewardMap,
    createdAt: new Date(questWindowStart(createdAtTimestamp)).toISOString(),
    rerollCount: 0,
    completed: false,
    status: "PENDING",
    target: { actionId, count, current: 0 },
    rewards: [{ count: stamp, resourceId: "catPawStamp" }, { count: gold, resourceId: "gold" }]
  };
}

// 每 4 小时补一份新任务；窗口按 UTC 0/4/8/12/16/20 对齐，对应东八区 8/12/16/20/0/4 点。
function syncQuests(player, now = Date.now()) {
  if (!Array.isArray(player.quests)) player.quests = [];
  const currentWindow = questWindowStart(now);
  const lastWindow = Number(player.questWindow) || 0;
  if (!lastWindow) {
    player.questWindow = currentWindow;
    player.quests.push(makeQuest(player, currentWindow));
    player.quests = player.quests.slice(-QUEST_MAX_COUNT);
    return 1;
  }
  let added = 0;
  let window = lastWindow + QUEST_WINDOW_MS;
  while (window <= currentWindow && added < 6) {
    player.quests.push(makeQuest(player, window));
    player.questWindow = window;
    window += QUEST_WINDOW_MS;
    added += 1;
  }
  if (added) player.quests = player.quests.slice(-QUEST_MAX_COUNT);
  return added;
}

function advanceQuests(player, actionId) {
  const changed = [];
  if (!Array.isArray(player.quests)) return changed;
  for (const quest of player.quests) {
    if (quest?.target?.actionId !== actionId) continue;
    if (quest.status === "DONE") continue;
    const total = Math.max(1, Math.floor(Number(quest.target.count) || 1));
    const current = Math.min(total, Math.max(0, Math.floor(Number(quest.target.current) || 0)) + 1);
    quest.target.current = current;
    quest.currentCount = current;
    quest.progress = Math.min(100, Math.round((current / total) * 100));
    quest.completed = current >= total;
    quest.status = quest.completed ? "DONE" : "DOING";
    changed.push(quest);
  }
  return changed;
}

function questRewardEntries(quest) {
  const rewards = [];
  for (const entry of Array.isArray(quest?.rewards) ? quest.rewards : []) {
    const count = Math.max(0, Math.floor(Number(entry?.count) || 0));
    if (!entry?.resourceId || count <= 0) continue;
    rewards.push({ resourceId: String(entry.resourceId), count });
  }
  return rewards;
}

function claimQuest(player, questUuid) {
  const index = player.quests.findIndex((quest) => quest.uuid === questUuid);
  if (index < 0) return { error: "任务不存在" };
  if (player.quests[index].status !== "DONE") return { error: "任务尚未完成" };
  const [quest] = player.quests.splice(index, 1);
  const rewards = questRewardEntries(quest);
  for (const reward of rewards) addAsset(player, reward.resourceId, reward.count);
  return { quest, rewards };
}

function claimAllQuests(player) {
  const claimable = player.quests.filter((quest) => quest.status === "DONE");
  if (!claimable.length) return { error: "没有可领取的任务奖励" };
  player.quests = player.quests.filter((quest) => quest.status !== "DONE");
  const rewards = [];
  for (const quest of claimable) {
    for (const reward of questRewardEntries(quest)) {
      addAsset(player, reward.resourceId, reward.count);
      const existing = rewards.find((item) => item.resourceId === reward.resourceId);
      if (existing) existing.count += reward.count;
      else rewards.push({ ...reward });
    }
  }
  return { rewards, quests: claimable };
}

function rerollQuest(player, questUuid) {
  const index = player.quests.findIndex((quest) => quest.uuid === questUuid);
  if (index < 0) return { error: "任务不存在" };
  const previous = player.quests[index];
  if (previous.status === "DONE") return { error: "已完成的任务无需重随" };
  const cost = QUEST_REROLL_BASE_COST * ((Number(previous.rerollCount) || 0) + 1);
  if (getAssetCount(player, "gold") < cost) return { error: `金币不足，重随需要 ${cost} 金币` };
  removeAsset(player, "gold", cost);
  const replacement = makeQuest(player, Date.parse(previous.createdAt) || Date.now());
  replacement.createdAt = previous.createdAt;
  replacement.rerollCount = (Number(previous.rerollCount) || 0) + 1;
  player.quests[index] = replacement;
  return { newQuest: replacement, cost };
}

function deleteQuest(player, questUuid) {
  const index = player.quests.findIndex((quest) => quest.uuid === questUuid);
  if (index < 0) return { error: "任务不存在" };
  const [quest] = player.quests.splice(index, 1);
  return { quest };
}

function emitPlayerResources(socket) {
  const player = socket.player;
  emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
  emitGameEvent(socket, "inventoryUpdated", player.inventory);
  emitGameEvent(socket, "character:getGameState:success", { resources: player.resources, inventory: player.inventory, taskQueue: player.taskQueue });
}

// ── 公共村庄 / 家政服务 ────────────────────────────────────────────────────────
const VILLAGE_BUILDING_STATUS = new Set(["UNBUILD", "PREPARE", "BUILDING", "NORMAL", "PREPARE_UPGRADE", "UPGRADING"]);
const VILLAGE_BUILDING_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VILLAGE_BUILDING_CATALOG = {
  catVillageMonument: {
    maxLevel: 2,
    buildDurationSeconds: 28800,
    buildCost: {
      gold: 2275000000, stone: 2500000, shell: 1250000, berry: 1250000, wood: 1250000,
      fish: 1000000, salmon: 1000000, chickenEgg: 1000000, milk: 1000000,
      simpleSalad: 750000, fishSoup: 750000, axe: 150000, steel: 150000, catFurCoat: 150000,
      "axe+5": 50000, catHairball: 500000, catPawStamp: 2500
    },
    upgrades: {
      1: {
        durationSeconds: 10800,
        cost: {
          gold: 2275000000, silverOre: 1250000, shell: 1250000, bamboo: 1250000,
          dawnBlossom: 250000, catMint: 250000, custardPudding: 250000,
          fish: 1000000, tuna: 1000000, animalManure: 1000000,
          glassBottles: 150000, cashmere: 150000, wool: 500000, catPawStamp: 3000
        }
      }
    }
  },
  battlePyreAltar: {
    maxLevel: 1,
    buildDurationSeconds: 28800,
    buildCost: {
      gold: 2125000000, wood: 875000000, lavaHeart: 500,
      pure_monster_essence_lv1: 50000, pure_monster_essence_lv2: 25000, pure_monster_essence_lv3: 12500
    },
    upgrades: {}
  },
  kittyHomeServiceCenter: {
    maxLevel: 2,
    buildDurationSeconds: 14400,
    buildCost: { gold: 400000000, stone: 25000000, iron: 2675000, cashmere: 1250000, ironMachinistHammer: 125, ironTongs: 125 },
    upgrades: {
      1: {
        durationSeconds: 7200,
        cost: {
          gold: 400000000, stone: 25000000, animalManure: 375000, fertBasic: 375000,
          dawnBlossom: 100000, windBellHerb: 100000, nutrientEssence: 37500
        }
      }
    }
  }
};

function villageBuildingDefault(type) {
  return {
    type,
    level: 0,
    exp: 0,
    maxLevel: VILLAGE_BUILDING_CATALOG[type].maxLevel,
    status: "UNBUILD",
    phaseId: null,
    targetLevel: null,
    fundList: [],
    startBuildAt: null,
    endBuildAt: null,
    startUpgradeAt: null,
    endUpgradeAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    extra: null
  };
}

function ensureVillageBuildings() {
  const byType = new Map();
  for (const raw of Array.isArray(villageState.buildings) ? villageState.buildings : []) {
    const type = String(raw?.type || "");
    if (!VILLAGE_BUILDING_CATALOG[type] || byType.has(type)) continue;
    const base = villageBuildingDefault(type);
    const status = VILLAGE_BUILDING_STATUS.has(raw.status) ? raw.status : base.status;
    byType.set(type, {
      ...base,
      ...raw,
      type,
      maxLevel: base.maxLevel,
      level: Math.max(0, Math.min(base.maxLevel, Math.floor(Number(raw.level) || 0))),
      status,
      fundList: Array.isArray(raw.fundList) ? raw.fundList.map((row) => ({ ...row })) : []
    });
  }
  for (const type of Object.keys(VILLAGE_BUILDING_CATALOG)) {
    if (!byType.has(type)) byType.set(type, villageBuildingDefault(type));
  }
  villageState.buildings = [...byType.values()];
  return villageState.buildings;
}

function villageBuildingByType(type) {
  return ensureVillageBuildings().find((entry) => entry.type === type) || null;
}

function villagePublicBuilding(entry) {
  if (!entry) return null;
  const { fundList, ...publicEntry } = entry;
  return { ...publicEntry };
}

function villageFundList(entry) {
  return (Array.isArray(entry?.fundList) ? entry.fundList : []).map((row) => ({
    materialId: String(row.materialId),
    required: Math.max(0, Math.floor(Number(row.required) || 0)),
    collected: Math.max(0, Math.floor(Number(row.collected) || 0)),
    status: Number(row.collected) >= Number(row.required) ? "COMPLETED" : "COLLECTING"
  }));
}

function villagePhaseRows(cost) {
  return Object.entries(cost).map(([materialId, required]) => ({ materialId, required, collected: 0, status: "COLLECTING" }));
}

function nextVillagePhaseId(type, targetLevel) {
  villageState.phaseSequence = Math.max(0, Math.floor(Number(villageState.phaseSequence) || 0)) + 1;
  return `${type}:${targetLevel}:${villageState.phaseSequence}:${crypto.randomUUID()}`;
}

function villageDonationSignature(buildingType, phaseId, info) {
  return JSON.stringify({ buildingType, phaseId, info: Object.fromEntries(Object.entries(info).sort(([left], [right]) => left.localeCompare(right))) });
}

// 村庄建筑是全服共享，不属于 player.building（后者是角色自建建筑）。UI 始终消费这一份权威投影。
function villageBuildingProjection() {
  return ensureVillageBuildings()
    .filter((entry) => ["NORMAL", "PREPARE_UPGRADE"].includes(entry.status))
    .map(villagePublicBuilding);
}

function villageBuildingLevel(type) {
  const entry = villageBuildingByType(type);
  return entry && ["NORMAL", "PREPARE_UPGRADE"].includes(entry.status) ? entry.level : 0;
}

function homeServiceView(now = Date.now()) {
  const level = Math.min(2, villageBuildingLevel("kittyHomeServiceCenter"));
  const service = villageState.homeService;
  const cycleDays = Math.max(1, Math.floor(Number(service.cycleDays) || HOME_SERVICE_CYCLE_DAYS));
  // 一期开始筹款后锁定费用，避免筹到一半升级使目标突然翻倍。
  let fundingLevel = Math.max(0, Math.floor(Number(service.fundingLevel) || 0));
  let feeGold = Math.max(0, Math.floor(Number(service.fundingFeeGold) || 0));
  if (level < 1) {
    fundingLevel = 0;
    feeGold = 0;
  } else if (feeGold <= 0 || fundingLevel <= 0) {
    fundingLevel = level;
    feeGold = 200000 * fundingLevel;
  }
  service.fundingLevel = fundingLevel;
  service.fundingFeeGold = feeGold;
  service.cycleDays = cycleDays;
  service.fundsGold = Math.min(feeGold, Math.max(0, Math.floor(Number(service.fundsGold) || 0)));
  const paidUntilMs = Date.parse(service.paidUntil || "");
  const paidUntil = Number.isFinite(paidUntilMs) ? new Date(paidUntilMs).toISOString() : null;
  return {
    level,
    active: level >= 1 && Number.isFinite(paidUntilMs) && paidUntilMs > now,
    paidUntil,
    cycleDays,
    fee: { gold: feeGold },
    funds: { gold: service.fundsGold },
    needed: { gold: Math.max(0, feeGold - service.fundsGold) }
  };
}

function homeServiceCan(requiredLevel, now = Date.now()) {
  const view = homeServiceView(now);
  return view.active && view.level >= requiredLevel;
}

function broadcastHomeServiceStatus(view = homeServiceView()) {
  for (const connected of io.sockets.sockets.values()) {
    if (connected.player) emitGameEvent(connected, "homeService:status:success", view);
  }
}

function commitVillageTransaction() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const transactionSnapshot = {
    status: "prepared",
    preparedAt: new Date().toISOString(),
    players: [...players.values()].map(playerPersistenceView),
    village: villagePersistenceView()
  };
  fs.mkdirSync(path.dirname(homeServiceWalFile), { recursive: true });
  writeJsonAtomic(homeServiceWalFile, transactionSnapshot);
  try {
    flushPersistedState();
    fs.rmSync(homeServiceWalFile, { force: true });
  } catch (commitError) {
    try {
      replayPreparedVillageTransaction(transactionSnapshot);
    } catch (recoveryError) {
      const fatal = new AggregateError([commitError, recoveryError], "village transaction recovery failed");
      console.error("[village] fatal transaction recovery failure", fatal);
      setImmediate(() => process.exit(1));
      throw fatal;
    }
  }
  return transactionSnapshot;
}

function handleHomeServiceEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  if (event === "homeService:status") {
    emitGameEvent(socket, "homeService:status:success", homeServiceView());
    return true;
  }
  if (event !== "homeService:donate") return false;

  const requestId = typeof data?.requestId === "string" ? data.requestId.trim() : "";
  const normalizedRequestId = requestId.toLowerCase();
  const count = Number(data?.count);
  const fail = (message, id = requestId) => {
    emitGameEvent(socket, "homeService:donate:error", { requestId: id, message });
    return true;
  };
  if (!HOME_SERVICE_REQUEST_ID_PATTERN.test(requestId)) return fail("捐助请求编号不合法");
  if (!Number.isSafeInteger(count) || count < 1) return fail("捐助金币必须是正整数");

  const donationKey = `${player.uuid}:${normalizedRequestId}`;
  const previous = villageState.donations[donationKey];
  if (previous) {
    if (previous.count !== count) return fail("requestId 已用于另一笔捐助");
    // ACK 丢失后的重试必须重放同一终态，绝不能再扣金币。
    emitGameEvent(socket, "homeService:donate:success", previous.response);
    return true;
  }

  const beforeView = homeServiceView();
  if (beforeView.level < 1) return fail("家政服务中心尚未建成");
  if (beforeView.needed.gold < 1) return fail("本期维护费已筹满，请刷新状态");
  if (count > beforeView.needed.gold) return fail("捐助金额超过本期剩余维护费");
  if (getAssetCount(player, "gold") < count) return fail("金币不足");

  const serviceBefore = structuredClone(villageState.homeService);
  const donationsBefore = structuredClone(villageState.donations);
  const goldBefore = getAssetCount(player, "gold");
  let transactionCommitted = false;
  try {
    if (!removeAsset(player, "gold", count)) return fail("金币不足");
    villageState.homeService.fundsGold += count;
    if (villageState.homeService.fundsGold === beforeView.fee.gold) {
      const paidUntilMs = Date.parse(villageState.homeService.paidUntil || "");
      const base = Number.isFinite(paidUntilMs) && paidUntilMs > Date.now() ? paidUntilMs : Date.now();
      villageState.homeService.paidUntil = new Date(base + beforeView.cycleDays * 24 * 60 * 60 * 1000).toISOString();
      villageState.homeService.fundsGold = 0;
      const currentLevel = Math.max(1, villageBuildingLevel("kittyHomeServiceCenter"));
      villageState.homeService.fundingLevel = currentLevel;
      villageState.homeService.fundingFeeGold = 200000 * currentLevel;
    }
    const response = { ...homeServiceView(), requestId };
    villageState.donations[donationKey] = {
      playerUuid: player.uuid,
      requestId: normalizedRequestId,
      count,
      status: "committed",
      response,
      committedAt: new Date().toISOString()
    };
    // success 只能在玩家扣款、公共筹款和幂等记录全部同步落盘后发送。
    commitVillageTransaction();
    transactionCommitted = true;
    for (const connected of marketPlayerSockets(player.uuid)) emitPlayerResources(connected);
    emitGameEvent(socket, "homeService:donate:success", response);
    broadcastHomeServiceStatus(response);
    return true;
  } catch (error) {
    if (transactionCommitted) {
      console.error("[homeService] donation committed but notification failed", error);
      return fail("捐助已完成，请刷新状态");
    }
    let preparedWalExists = false;
    try {
      const wal = JSON.parse(fs.readFileSync(homeServiceWalFile, "utf8"));
      preparedWalExists = wal?.status === "prepared";
      if (!preparedWalExists) fs.rmSync(homeServiceWalFile, { force: true });
    } catch {
      preparedWalExists = false;
    }
    if (!preparedWalExists) {
      setGoldCount(player, goldBefore);
      villageState.homeService = serviceBefore;
      villageState.donations = donationsBefore;
    }
    console.error("[homeService] donation commit failed", error);
    return fail(preparedWalExists ? "服务器正在恢复交易，请稍后使用同一请求编号重试" : "服务器开小差了");
  }
}

function broadcastVillageEvent(event, payload) {
  for (const connected of io.sockets.sockets.values()) {
    if (connected.player) emitGameEvent(connected, event, payload);
  }
}

function villageListView() {
  return ensureVillageBuildings().map(villagePublicBuilding);
}

function broadcastVillageBuilding(entry, includeList = true) {
  const building = villagePublicBuilding(entry);
  const fundList = villageFundList(entry);
  broadcastVillageEvent("villageBuilding:fund:success", { buildingType: entry.type, fundList });
  if (includeList) broadcastVillageEvent("villageBuilding:list:success", { list: villageListView() });
  broadcastVillageEvent("villageBuilding:normalStateBaseBuildings:success", { list: villageBuildingProjection() });
  broadcastHomeServiceStatus();
  return { building, fundList };
}

function completeVillageBuildingPhase(entry, now = Date.now()) {
  if (!entry) return false;
  const originalPhaseId = entry.phaseId;
  const expectedLevel = Math.max(0, Math.floor(Number(entry.targetLevel) || 0));
  if (entry.status === "BUILDING") {
    const end = Date.parse(entry.endBuildAt || "");
    if (!originalPhaseId || expectedLevel !== 1 || !Number.isFinite(end) || end > now) return false;
    entry.level = 1;
    entry.status = "NORMAL";
    entry.startBuildAt = null;
    entry.endBuildAt = null;
  } else if (entry.status === "UPGRADING") {
    const end = Date.parse(entry.endUpgradeAt || "");
    if (!originalPhaseId || expectedLevel !== entry.level + 1 || !Number.isFinite(end) || end > now) return false;
    entry.level = expectedLevel;
    entry.status = "NORMAL";
    entry.startUpgradeAt = null;
    entry.endUpgradeAt = null;
  } else {
    return false;
  }
  entry.phaseId = null;
  entry.targetLevel = null;
  entry.fundList = [];
  entry.updatedAt = new Date(now).toISOString();
  return true;
}

function reconcileVillageBuildings({ persist = true, broadcast = true } = {}) {
  let changed = false;
  const completed = [];
  for (const entry of ensureVillageBuildings()) {
    if (!completeVillageBuildingPhase(entry)) continue;
    changed = true;
    completed.push(entry);
  }
  if (changed && persist) schedulePersist();
  if (changed && broadcast) {
    broadcastVillageEvent("villageBuilding:list:success", { list: villageListView() });
    broadcastVillageEvent("villageBuilding:normalStateBaseBuildings:success", { list: villageBuildingProjection() });
    for (const entry of completed) broadcastVillageEvent("villageBuilding:fund:success", { buildingType: entry.type, fundList: [] });
    broadcastHomeServiceStatus();
  }
  return changed;
}

function beginVillagePhase(entry, kind) {
  const catalog = VILLAGE_BUILDING_CATALOG[entry.type];
  const isBuild = kind === "build";
  const targetLevel = isBuild ? 1 : entry.level + 1;
  const phase = isBuild ? { cost: catalog.buildCost, durationSeconds: catalog.buildDurationSeconds } : catalog.upgrades[entry.level];
  if (!phase) return null;
  const now = new Date().toISOString();
  entry.status = isBuild ? "PREPARE" : "PREPARE_UPGRADE";
  entry.phaseId = nextVillagePhaseId(entry.type, targetLevel);
  entry.targetLevel = targetLevel;
  entry.fundList = villagePhaseRows(phase.cost);
  entry.updatedAt = now;
  if (entry.createdAt === new Date(0).toISOString()) entry.createdAt = now;
  return entry;
}

function startFundedVillagePhase(entry) {
  const rows = villageFundList(entry);
  if (!rows.length || rows.some((row) => row.status !== "COMPLETED")) return false;
  const now = Date.now();
  if (entry.status === "PREPARE") {
    entry.status = "BUILDING";
    entry.startBuildAt = new Date(now).toISOString();
    entry.endBuildAt = new Date(now + VILLAGE_BUILDING_CATALOG[entry.type].buildDurationSeconds * 1000).toISOString();
  } else if (entry.status === "PREPARE_UPGRADE") {
    const phase = VILLAGE_BUILDING_CATALOG[entry.type].upgrades[entry.level];
    if (!phase) return false;
    entry.status = "UPGRADING";
    entry.startUpgradeAt = new Date(now).toISOString();
    entry.endUpgradeAt = new Date(now + phase.durationSeconds * 1000).toISOString();
  } else {
    return false;
  }
  entry.updatedAt = new Date(now).toISOString();
  return true;
}

function normalizeVillageDonationInfo(info, entry = null) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const remainingById = entry
    ? new Map(villageFundList(entry).map((row) => [row.materialId, row.required - row.collected]))
    : null;
  const normalized = {};
  for (const [materialId, raw] of Object.entries(info)) {
    if (remainingById && !remainingById.has(materialId)) return null;
    const count = Number(raw?.count ?? raw);
    if (!Number.isSafeInteger(count) || count < 1 || (remainingById && count > remainingById.get(materialId))) return null;
    normalized[materialId] = count;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function villageDonationHistory(type) {
  return (Array.isArray(villageState.buildingDonations) ? villageState.buildingDonations : [])
    .filter((entry) => entry.buildingType === type)
    .map((entry) => ({
      userUuid: entry.donorUuid,
      donorUuid: entry.donorUuid,
      buildingLevel: entry.buildingLevel,
      materialId: entry.materialId,
      amount: entry.amount,
      createdAt: entry.createdAt
    }));
}

function handleVillageBuildingEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  reconcileVillageBuildings();
  const fail = (message, extra = {}) => {
    emitGameEvent(socket, `${event}:fail`, { message, ...extra });
    return true;
  };
  if (event === "villageBuilding:list") {
    emitGameEvent(socket, `${event}:success`, { list: villageListView() });
    return true;
  }
  if (event === "villageBuilding:normalStateBaseBuildings") {
    emitGameEvent(socket, `${event}:success`, { list: villageBuildingProjection() });
    return true;
  }
  const buildingType = String(data?.buildingType || "");
  const entry = villageBuildingByType(buildingType);
  if (!entry) return fail("未知的小镇建筑");
  if (event === "villageBuilding:fund") {
    emitGameEvent(socket, `${event}:success`, { buildingType, fundList: villageFundList(entry) });
    return true;
  }
  if (event === "villageBuilding:donationList") {
    emitGameEvent(socket, `${event}:success`, { list: villageDonationHistory(buildingType) });
    return true;
  }
  if (event === "villageBuilding:prepare") {
    if (entry.status !== "UNBUILD") return fail("该建筑已进入筹备或建造阶段");
    beginVillagePhase(entry, "build");
    schedulePersist();
    const response = { building: villagePublicBuilding(entry), fundList: villageFundList(entry) };
    emitGameEvent(socket, `${event}:success`, response);
    broadcastVillageBuilding(entry);
    return true;
  }
  if (event === "villageBuilding:upgrade") {
    if (entry.status !== "NORMAL") return fail("该建筑当前无法升级");
    if (entry.level >= VILLAGE_BUILDING_CATALOG[buildingType].maxLevel) return fail("该建筑已达到最高等级");
    if (!beginVillagePhase(entry, "upgrade")) return fail("该建筑没有可用的升级方案");
    schedulePersist();
    const response = { building: villagePublicBuilding(entry), fundList: villageFundList(entry) };
    emitGameEvent(socket, `${event}:success`, response);
    broadcastVillageBuilding(entry);
    return true;
  }
  if (event !== "villageBuilding:donate") return false;
  const requestId = typeof data?.requestId === "string" ? data.requestId.trim().toLowerCase() : "";
  if (!VILLAGE_BUILDING_REQUEST_ID_PATTERN.test(requestId)) return fail("捐赠请求编号不合法", { code: "INVALID_REQUEST_ID" });
  const requestKey = `${player.uuid}:${requestId}`;
  const previous = villageState.buildingRequests[requestKey];
  if (previous) {
    // 永久幂等记录必须先于当前阶段校验：ACK 丢失后的重试可能发生在资金已满、施工完成，
    // 甚至下一次升级募集开始之后。用请求本身的语义比对，而不是用当前 entry.phaseId 重算。
    const replayInfo = normalizeVillageDonationInfo(data?.info, null);
    const replaySignature = replayInfo
      ? villageDonationSignature(previous.buildingType || buildingType, previous.phaseId || "", replayInfo)
      : "";
    if (!replayInfo || previous.signature !== replaySignature || (previous.buildingType && previous.buildingType !== buildingType)) {
      return fail("requestId 已用于另一笔捐赠", { code: "IDEMPOTENCY_CONFLICT", requestId });
    }
    emitGameEvent(socket, `${event}:success`, previous.response);
    return true;
  }
  if (!["PREPARE", "PREPARE_UPGRADE"].includes(entry.status)) return fail("该建筑当前不接受捐赠");
  const expectedPhaseId = typeof data?.expectedPhaseId === "string" ? data.expectedPhaseId : "";
  if (expectedPhaseId && expectedPhaseId !== entry.phaseId) return fail("募集阶段已变化，请刷新后重试", { code: "PHASE_CHANGED" });
  const info = normalizeVillageDonationInfo(data?.info, entry);
  if (!info) return fail("捐赠材料或数量无效");
  const signature = villageDonationSignature(buildingType, entry.phaseId, info);
  for (const [materialId, count] of Object.entries(info)) {
    if (getAssetCount(player, materialId) < count) return fail(`${materialId} 数量不足`);
  }
  const inventoryBefore = structuredClone(player.inventory);
  const resourcesBefore = structuredClone(player.resources);
  const entryBefore = structuredClone(entry);
  const historyBefore = structuredClone(villageState.buildingDonations);
  const requestsBefore = structuredClone(villageState.buildingRequests);
  let committed = false;
  try {
    for (const [materialId, count] of Object.entries(info)) {
      if (!removeAsset(player, materialId, count)) throw new Error(`failed to deduct ${materialId}`);
      const row = entry.fundList.find((item) => item.materialId === materialId);
      row.collected += count;
      row.status = row.collected >= row.required ? "COMPLETED" : "COLLECTING";
      villageState.buildingDonations.push({
        id: crypto.randomUUID(), donorUuid: player.uuid, buildingType, phaseId: entry.phaseId,
        buildingLevel: entry.targetLevel, materialId, amount: count, createdAt: new Date().toISOString()
      });
    }
    startFundedVillagePhase(entry);
    const response = { requestId, buildingType, building: villagePublicBuilding(entry), fundList: villageFundList(entry) };
    villageState.buildingRequests[requestKey] = {
      playerUuid: player.uuid, requestId, buildingType, phaseId: entryBefore.phaseId, signature,
      status: "committed", response, committedAt: new Date().toISOString()
    };
    commitVillageTransaction();
    committed = true;
    for (const connected of marketPlayerSockets(player.uuid)) emitPlayerResources(connected);
    emitGameEvent(socket, `${event}:success`, response);
    broadcastVillageBuilding(entry);
    return true;
  } catch (error) {
    if (!committed && !fs.existsSync(homeServiceWalFile)) {
      player.inventory = inventoryBefore;
      player.resources = resourcesBefore;
      Object.assign(entry, entryBefore);
      villageState.buildingDonations = historyBefore;
      villageState.buildingRequests = requestsBefore;
    }
    console.error("[village] donation commit failed", error);
    return fail(committed ? "捐赠已完成，请刷新状态" : "服务器开小差了", { requestId });
  }
}

setInterval(() => {
  reconcileVillageBuildings();
}, 1000).unref();

// ── 排行榜 ─────────────────────────────────────────────────────────────────────
const WEEKLY_RANKING_CATEGORIES = new Set(["goldEarned", "total", ...statusKeys]);

function isIronPlayer(player) {
  return player?.ironcat === true || player?.isIronCat === true;
}

function rankingStableCompare(left, right) {
  const rankDiff = Number(right.rank) - Number(left.rank);
  if (rankDiff) return rankDiff;
  const leftPlayer = players.get(left.uuid);
  const rightPlayer = players.get(right.uuid);
  const createdDiff = String(leftPlayer?.createdAt || "").localeCompare(String(rightPlayer?.createdAt || ""));
  return createdDiff || String(left.uuid).localeCompare(String(right.uuid));
}

function rankingRows(pool, metric) {
  return pool
    .map((player) => ({ uuid: player.uuid, name: player.name, rank: Math.max(0, Number(metric(player)) || 0) }))
    .sort(rankingStableCompare);
}

function totalRankingPayload(ironMode) {
  const pool = [...players.values()].filter((player) => isIronPlayer(player) === ironMode);
  const suffix = ironMode ? "iron" : "normal";
  const list = [];
  const add = (name, rows) => list.push({ name, list: rows });
  add(`gold_ranking_list_${suffix}`, rankingRows(pool, (player) => getAssetCount(player, "gold")));
  add(`cat_paw_coin_ranking_list_${suffix}`, rankingRows(pool, (player) => getAssetCount(player, "catPawCoin")));
  add(`cat_paw_stamp_ranking_list_${suffix}`, rankingRows(pool, (player) => getAssetCount(player, "catPawStamp")));
  // sponsor_ranking_list 在普通/硬核页共用名称；只展示对应模式玩家。
  add("sponsor_ranking_list", rankingRows(pool, (player) => player.sponsorPoint?.max));
  add(`character_total_level_ranking_list_${suffix}`, rankingRows(pool, (player) => Object.values(getPlayerStatus(player)).reduce((sum, status) => sum + status.level, 0)));
  for (const status of statusKeys) add(`character_${status}_level_ranking_list_${suffix}`, rankingRows(pool, (player) => getPlayerStatus(player)[status].level));
  // 友情、好友数与强化榜尚无可信数据模型；不要以空榜伪装成真实零结果。
  return list;
}

function normalizeRankingDate(value) {
  return rankingLocalDateKey(value || Date.now());
}

function rankingWeekDateKeys(value) {
  const key = normalizeRankingDate(value);
  const [year, month, day] = key.split("-").map(Number);
  const selected = new Date(Date.UTC(year, month - 1, day, 12));
  const isoWeekday = selected.getUTCDay() || 7;
  selected.setUTCDate(selected.getUTCDate() - isoWeekday + 1);
  return Array.from({ length: 7 }, (_unused, index) => {
    const date = new Date(selected);
    date.setUTCDate(selected.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function weeklyRankingPayload(data, ironMode) {
  const category = typeof data?.category === "string" && WEEKLY_RANKING_CATEGORIES.has(data.category) ? data.category : "goldEarned";
  const date = normalizeRankingDate(data?.date);
  const dateKeys = rankingWeekDateKeys(date);
  const entries = [...players.values()]
    .filter((player) => isIronPlayer(player) === ironMode)
    .map((player) => ({
      userUuid: player.uuid,
      value: Math.round(dateKeys.reduce((sum, key) => sum + (Number(player.weeklyRanking?.[key]?.[category]) || 0), 0) * 100) / 100,
      createdAt: player.createdAt
    }))
    .filter((entry) => entry.value > 0)
    .sort((left, right) => right.value - left.value || String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.userUuid.localeCompare(right.userUuid))
    .map(({ userUuid, value }) => ({ userUuid, value }));
  return { category, date, entries, totalCount: entries.length };
}

function handleRankingEvent(socket, event, data) {
  if (event === "requestRankingList") {
    emitGameEvent(socket, "rankingList", totalRankingPayload(false));
    return true;
  }
  if (event === "requestIronRankingList") {
    emitGameEvent(socket, "ironRankingList", totalRankingPayload(true));
    return true;
  }
  if (event === "requestWeeklyRankingList") {
    emitGameEvent(socket, "weeklyRankingList", weeklyRankingPayload(data, false));
    return true;
  }
  if (event === "requestWeeklyIronRankingList") {
    emitGameEvent(socket, "weeklyIronRankingList", weeklyRankingPayload(data, true));
    return true;
  }
  return false;
}

function handleQuestEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  if (event === "quest:list") {
    if (syncQuests(player)) schedulePersist();
    emitGameEvent(socket, "quest:list:success", player.quests);
    return true;
  }
  if (event === "quest:complete") {
    const result = claimQuest(player, String(data.questId || data.questUuid || ""));
    if (result.error) {
      emitGameEvent(socket, "quest:complete:error", { message: result.error });
      return true;
    }
    emitGameEvent(socket, "quest:complete:success", { rewards: result.rewards, questUuid: result.quest.uuid });
    emitGameEvent(socket, "quest:list:success", player.quests);
    emitPlayerResources(socket);
    schedulePersist();
    return true;
  }
  if (event === "quest:completeAll") {
    const result = claimAllQuests(player);
    if (result.error) {
      emitGameEvent(socket, "quest:completeAll:error", { message: result.error });
      return true;
    }
    emitGameEvent(socket, "quest:completeAll:success", { rewards: result.rewards, count: result.quests.length });
    emitGameEvent(socket, "quest:list:success", player.quests);
    emitPlayerResources(socket);
    schedulePersist();
    return true;
  }
  if (event === "quest:reroll") {
    const result = rerollQuest(player, String(data.questUuid || data.questId || ""));
    if (result.error) {
      emitGameEvent(socket, "quest:reroll:error", { message: result.error });
      return true;
    }
    emitGameEvent(socket, "quest:reroll:success", { newQuest: result.newQuest, questUuid: result.newQuest.uuid, cost: result.cost });
    emitGameEvent(socket, "quest:list:success", player.quests);
    emitPlayerResources(socket);
    schedulePersist();
    return true;
  }
  if (event === "quest:delete") {
    const result = deleteQuest(player, String(data.questUuid || data.questId || ""));
    if (result.error) {
      emitGameEvent(socket, "quest:delete:error", { message: result.error });
      return true;
    }
    emitGameEvent(socket, "quest:delete:success", { questUuid: result.quest.uuid });
    emitGameEvent(socket, "quest:list:success", player.quests);
    schedulePersist();
    return true;
  }
  return false;
}

// ── 种植（farm） ───────────────────────────────────────────────────────────────
// 契约取自前端 farm store（index-CnYosZ2K.js @427442 起）：
//   farm:plots                         -> farm:plots:success          { list: [plot] }
//   farm:plot:unlock|plant|harvest|shovel|autoReplant|create
//                                      -> farm:plot:*:success         { plot }
//   farm:plot:*:fail                   -> { msg }        ← 字段名是 msg，不是 message
// 前端按 plot.id 合并单条更新（f_()），因此 id 必须稳定；地块总数固定 9（前端 fl=9）。
// 作物/肥料配置直接复用 game-jresource 的 farmingCatalog，不另建副本。
const FARM_PLOT_COUNT = 9;
const FARM_LEVEL_KEY = "farmingPlant";
// 开垦基础成本，实际消耗 = count * min(5, plotIndex)，即第 1 块地免费。
const FARM_UNLOCK_BASE_COST = [
  { id: "gold", count: 200000 },
  { id: "wood", count: 2000 },
  { id: "stone", count: 1500 },
  { id: "nutrientEssence", count: 2500 }
];

const farmCrops = new Map((farmingCatalog?.crops || []).map((crop) => [crop.seedId, crop]));
const farmFertilizers = new Map((farmingCatalog?.fertilizers || []).map((item) => [item.id, item]));

function farmResourceName(resourceId) {
  return resourceCatalog?.[resourceId]?.name || resourceId;
}

function farmRandomInt(range = {}) {
  const min = Math.floor(Number(range.min) || 0);
  const max = Math.floor(Number(range.max) || min);
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 肥料效果换算与前端 Kh() 对齐：时长按 percent 连乘，异变率按 percentPoint 相加，产量按 percent 放大。
function farmPlantPlan(seedId, fertilizers) {
  const crop = farmCrops.get(seedId);
  if (!crop) return null;
  const allowed = crop.fertilizerIds?.length ? new Set(crop.fertilizerIds) : null;
  const normalized = [];
  for (const item of Array.isArray(fertilizers) ? fertilizers : []) {
    if (!item?.id) continue;
    if (allowed && !allowed.has(item.id)) continue;
    const definition = farmFertilizers.get(item.id);
    if (!definition) continue;
    const maxStacks = Math.max(1, Number(definition.maxStacks) || 1);
    normalized.push({ id: item.id, stacks: Math.min(Math.max(1, Math.floor(Number(item.stacks) || 1)), maxStacks) });
  }
  let growthSeconds = Math.max(1, Number(crop.baseGrowthSeconds) || 0);
  let mutationChance = Number(crop.baseMutationChance) || 0;
  let yieldPercent = 0;
  for (const entry of normalized) {
    for (const effect of farmFertilizers.get(entry.id)?.effects || []) {
      if (effect.type === "shortenDuration") {
        if (typeof effect.seconds === "number") growthSeconds = Math.max(1, growthSeconds - effect.seconds);
        if (typeof effect.percent === "number") growthSeconds = Math.max(1, Math.floor(growthSeconds * (1 - effect.percent)));
      } else if (effect.type === "increaseMutationChance" || effect.type === "adjustMutationChance") {
        if (typeof effect.percentPoint === "number") mutationChance += effect.percentPoint;
        if (typeof effect.multiply === "number") mutationChance *= effect.multiply;
      } else if (effect.type === "increaseYield") {
        if (typeof effect.percent === "number") yieldPercent += effect.percent;
      }
    }
  }
  return {
    crop,
    fertilizers: normalized,
    growthSeconds,
    mutationChance: Math.max(0, Math.min(1, mutationChance)),
    yieldPercent
  };
}

function farmPlantCosts(plan) {
  const merged = new Map();
  const add = (id, count) => {
    const amount = Math.floor(Number(count) || 0);
    if (!id || amount <= 0) return;
    merged.set(id, (merged.get(id) || 0) + amount);
  };
  for (const item of plan.crop.plantCost || []) add(item.id, item.count);
  for (const item of plan.fertilizers) add(item.id, item.stacks);
  return [...merged.entries()].map(([id, count]) => ({ id, count }));
}

function farmRollYields(plan) {
  const gained = {};
  const add = (id, count) => {
    const amount = Math.floor(Number(count) || 0);
    if (!id || amount <= 0) return;
    gained[id] = (gained[id] || 0) + amount;
  };
  for (const entry of plan.crop.yields || []) {
    if (Math.random() > Math.min(1, Number(entry.percent ?? 1) || 0)) continue;
    const base = entry.range ? farmRandomInt(entry.range) : Number(entry.count) || 0;
    add(entry.id, Math.round(base * (1 + plan.yieldPercent)));
  }
  for (const entry of plan.crop.mutationYields || []) {
    const chance = plan.mutationChance * (Number(entry.percent ?? 1) || 0);
    if (Math.random() > chance) continue;
    add(entry.id, entry.range ? farmRandomInt(entry.range) : Number(entry.count) || 1);
  }
  return gained;
}

function farmUnlockCost(plotIndex) {
  const multiplier = Math.min(5, Math.max(0, Math.floor(Number(plotIndex) || 0)));
  return FARM_UNLOCK_BASE_COST.map((item) => ({ id: item.id, count: Math.floor(item.count * multiplier) })).filter((item) => item.count > 0);
}

function farmEnsurePlots(player) {
  if (!Array.isArray(player.farmPlots)) player.farmPlots = [];
  return player.farmPlots;
}

function farmFindPlot(player, plotIndex) {
  const index = Math.floor(Number(plotIndex));
  if (!Number.isInteger(index)) return null;
  return farmEnsurePlots(player).find((plot) => Number(plot.plotIndex) === index) || null;
}

function farmLevel(player) {
  return normalizeStatus(player.status?.[FARM_LEVEL_KEY] || {}).level;
}

function farmAddExp(player, amount) {
  addStatusExp(player, FARM_LEVEL_KEY, Math.floor(Number(amount) || 0));
}

// 成熟按时间惰性结算：读列表 / 收获前把到点的 GROWING 翻成 READY。
function farmRefreshPlots(player) {
  const now = Date.now();
  let changed = false;
  for (const plot of farmEnsurePlots(player)) {
    if (plot.state !== "GROWING") continue;
    const due = Date.parse(plot.expectedHarvestAt || "");
    if (!Number.isFinite(due) || due > now) continue;
    plot.state = "READY";
    changed = true;
  }
  return changed;
}

function farmTakeCosts(player, costs) {
  const missing = costs.filter((item) => getAssetCount(player, item.id) < item.count);
  if (missing.length) return missing;
  for (const item of costs) removeAsset(player, item.id, item.count);
  return null;
}

function farmStartGrowing(plot, seedId, plan) {
  const now = Date.now();
  plot.state = "GROWING";
  plot.seedId = seedId;
  plot.fertilizers = plan.fertilizers;
  plot.yieldMultiplier = plan.yieldPercent;
  plot.mutationChance = plan.mutationChance;
  plot.plantedAt = new Date(now).toISOString();
  plot.expectedHarvestAt = new Date(now + plan.growthSeconds * 1000).toISOString();
  plot.harvestAt = now + plan.growthSeconds * 1000;
}

// 字段形状对齐参考站：空值用 "" / 0，不用 null —— 前端 PlantedAt 分支按真值判断，但保持同一形状便于比对。
function farmClearPlot(plot) {
  plot.state = "EMPTY";
  plot.seedId = "";
  plot.plantedAt = "";
  plot.expectedHarvestAt = "";
  plot.harvestAt = 0;
  plot.fertilizers = [];
  plot.yieldMultiplier = 0;
  plot.mutationChance = 0;
}

function farmSyncInventory(socket, changes) {
  emitGameEvent(socket, "dispatchInventoryInfo", socket.player.inventory);
  emitGameEvent(socket, "inventoryUpdated", socket.player.inventory);
  const payload = {};
  for (const [resourceId, delta] of Object.entries(changes || {})) {
    if (!delta) continue;
    payload[resourceId] = { count: delta };
  }
  if (Object.keys(payload).length) emitGameEvent(socket, "inventoryModify", payload);
}

function harvestBoxes(player) {
  if (!Array.isArray(player.harvestBoxes)) player.harvestBoxes = [];
  return player.harvestBoxes;
}

function addHarvestBox(player, title, rewards) {
  const items = Object.entries(rewards || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([resourceId, amount]) => ({ id: crypto.randomUUID(), resourceId, amount: Math.max(1, Math.floor(Number(amount))), claimed: false }));
  if (!items.length) return null;
  // 相邻的自动收获合并到同一个未领取箱，避免一分钟巡检产生大量卡片。
  let box = harvestBoxes(player).find((entry) => !entry.claimed && entry.title === title);
  if (!box) {
    box = { id: crypto.randomUUID(), title, createdAt: new Date().toISOString(), claimed: false, items: [] };
    player.harvestBoxes.unshift(box);
  }
  for (const item of items) {
    const existing = box.items.find((entry) => !entry.claimed && entry.resourceId === item.resourceId);
    if (existing) existing.amount += item.amount;
    else box.items.push(item);
  }
  return box;
}

function claimHarvestItems(player, predicate) {
  const gained = {};
  const claimedItems = [];
  for (const box of harvestBoxes(player)) {
    for (const item of Array.isArray(box.items) ? box.items : []) {
      if (item.claimed || !predicate(box, item)) continue;
      const amount = Math.max(0, Math.floor(Number(item.amount) || 0));
      if (amount > 0) {
        addAsset(player, item.resourceId, amount);
        gained[item.resourceId] = (gained[item.resourceId] || 0) + amount;
        claimedItems.push({ resourceId: item.resourceId, amount });
      }
      item.claimed = true;
    }
    box.claimed = (box.items || []).every((item) => item.claimed);
  }
  return { gained, claimedItems };
}

function handleHarvestBoxEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  const fail = (msg) => {
    emitGameEvent(socket, `${event}:fail`, { msg });
    return true;
  };
  if (event === "harvestBox:list") {
    const includeClaimed = Boolean(data?.includeClaimed);
    const take = Math.max(1, Math.min(50, Math.floor(Number(data?.take) || 5)));
    const source = harvestBoxes(player).filter((box) => includeClaimed || !box.claimed);
    let start = 0;
    if (data?.beforeId) {
      const index = source.findIndex((box) => box.id === data.beforeId);
      if (index < 0) return fail("分页游标无效");
      start = index + 1;
    }
    const list = source.slice(start, start + take);
    emitGameEvent(socket, "harvestBox:list:success", {
      list,
      hasMore: start + take < source.length,
      nextCursor: list.at(-1)?.id || null
    });
    return true;
  }
  let result;
  if (event === "harvestBox:claim") {
    const boxId = String(data?.boxId || "");
    if (!harvestBoxes(player).some((box) => box.id === boxId)) return fail("收获箱不存在");
    result = claimHarvestItems(player, (box) => box.id === boxId);
  } else if (event === "harvestBox:claimItem") {
    const itemId = String(data?.itemId || "");
    if (!harvestBoxes(player).some((box) => (box.items || []).some((item) => item.id === itemId))) return fail("物品不存在");
    result = claimHarvestItems(player, (_box, item) => item.id === itemId);
  } else if (event === "harvestBox:claimAll") {
    result = claimHarvestItems(player, () => true);
  } else {
    return false;
  }
  const { gained, claimedItems } = result;
  emitGameEvent(socket, `${event}:success`, { gained, claimedItems, alreadyClaimed: !claimedItems.length });
  for (const connected of marketPlayerSockets(player.uuid)) {
    emitGameEvent(connected, "dispatchInventoryInfo", player.inventory);
    emitGameEvent(connected, "inventoryUpdated", player.inventory);
    emitGameEvent(connected, "inventoryModify", Object.fromEntries(Object.entries(gained).map(([id, count]) => [id, { count }])));
  }
  schedulePersist();
  return true;
}

function handleFarmEvent(socket, event, data) {
  const player = socket.player;
  if (!player) return true;
  farmEnsurePlots(player);
  const payload = data && typeof data === "object" ? data : {};
  const fail = (message) => {
    emitGameEvent(socket, `${event}:fail`, { msg: message });
    return true;
  };

  if (event === "farm:plots") {
    const changed = farmRefreshPlots(player);
    const area = payload.area ? String(payload.area) : "";
    const list = player.farmPlots
      .filter((plot) => !area || plot.area === area)
      .sort((left, right) => String(left.area || "").localeCompare(String(right.area || "")) || Number(left.plotIndex) - Number(right.plotIndex));
    emitGameEvent(socket, "farm:plots:success", { list });
    if (changed) schedulePersist();
    return true;
  }

  if (event === "farm:plot:unlock" || event === "farm:plot:create") {
    let plotIndex = Math.floor(Number(payload.plotIndex));
    if (!Number.isInteger(plotIndex) || plotIndex < 0) {
      if (event === "farm:plot:create") {
        const used = new Set(player.farmPlots.map((plot) => Number(plot.plotIndex)));
        plotIndex = [...Array(FARM_PLOT_COUNT).keys()].find((index) => !used.has(index)) ?? -1;
      }
    }
    if (!Number.isInteger(plotIndex) || plotIndex < 0 || plotIndex >= FARM_PLOT_COUNT) return fail("田地编号无效");
    if (farmFindPlot(player, plotIndex)) return fail("该田地已经开垦");
    const costs = farmUnlockCost(plotIndex);
    const missing = farmTakeCosts(player, costs);
    if (missing) return fail(`资源不足：${missing.map((item) => `${farmResourceName(item.id)} x${item.count}`).join("、")}`);
    const plot = {
      id: plotIndex + 1,
      area: "default",
      plotIndex,
      state: "EMPTY",
      seedId: "",
      autoReplant: false,
      plantedAt: "",
      expectedHarvestAt: "",
      harvestAt: 0,
      fertilizers: [],
      yieldMultiplier: 0,
      mutationChance: 0
    };
    player.farmPlots.push(plot);
    emitGameEvent(socket, `${event}:success`, { plot: { ...plot } });
    farmSyncInventory(socket, Object.fromEntries(costs.map((item) => [item.id, -item.count])));
    schedulePersist();
    return true;
  }

  if (event === "farm:plot:plant") {
    const plot = farmFindPlot(player, payload.plotIndex);
    if (!plot) return fail("该田地尚未开垦");
    if (plot.state === "GROWING") return fail("田地正在生长中");
    if (plot.state === "READY") return fail("作物已成熟，请先收获");
    const seedId = String(payload.seedId || "");
    const plan = farmPlantPlan(seedId, payload.fertilizers);
    if (!plan) return fail("未知的种子");
    const level = farmLevel(player);
    const required = Number(plan.crop.farmingPlantLevelRequired) || 0;
    if (level < required) return fail(`种植等级不足：需要 ${required} 级，当前 ${level} 级`);
    const costs = farmPlantCosts(plan);
    const missing = farmTakeCosts(player, costs);
    if (missing) return fail(`资源不足：${missing.map((item) => `${farmResourceName(item.id)} x${item.count}`).join("、")}`);
    farmStartGrowing(plot, seedId, plan);
    emitGameEvent(socket, "farm:plot:plant:success", { plot: { ...plot } });
    farmSyncInventory(socket, Object.fromEntries(costs.map((item) => [item.id, -item.count])));
    schedulePersist();
    return true;
  }

  if (event === "farm:plot:harvest") {
    const plot = farmFindPlot(player, payload.plotIndex);
    if (!plot) return fail("该田地尚未开垦");
    farmRefreshPlots(player);
    if (plot.state !== "READY") return fail("作物尚未成熟");
    const plan = farmPlantPlan(plot.seedId, plot.fertilizers);
    if (!plan) return fail("作物数据异常，无法收获");
    const changes = {};
    for (const [resourceId, count] of Object.entries(farmRollYields(plan))) {
      addAsset(player, resourceId, count);
      changes[resourceId] = count;
    }
    farmAddExp(player, plan.crop.farmingPlantExpGainWhenHarvest);
    // 手动收获不受欠费影响；只有仍在生效的 2 级家政服务才能顺带自动补种。
    const replantCosts = plot.autoReplant && homeServiceCan(2) ? farmPlantCosts(plan) : null;
    const replantMissing = replantCosts ? farmTakeCosts(player, replantCosts) : null;
    if (replantCosts && !replantMissing) {
      for (const item of replantCosts) changes[item.id] = (changes[item.id] || 0) - item.count;
      farmStartGrowing(plot, plot.seedId, plan);
    } else {
      farmClearPlot(plot);
    }
    emitGameEvent(socket, "farm:plot:harvest:success", { plot: { ...plot } });
    farmSyncInventory(socket, changes);
    emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(player).status);
    schedulePersist();
    return true;
  }

  if (event === "farm:plot:shovel") {
    const plot = farmFindPlot(player, payload.plotIndex);
    if (!plot) return fail("该田地尚未开垦");
    if (plot.state === "EMPTY") return fail("该田地没有作物");
    farmClearPlot(plot);
    emitGameEvent(socket, "farm:plot:shovel:success", { plot: { ...plot } });
    schedulePersist();
    return true;
  }

  if (event === "farm:plot:autoReplant") {
    const plot = farmFindPlot(player, payload.plotIndex);
    if (!plot) return fail("该田地尚未开垦");
    const enabled = Boolean(payload.value);
    if (enabled && !homeServiceCan(2)) return fail("需要已缴费且达到 2 级的家政服务中心");
    plot.autoReplant = enabled;
    emitGameEvent(socket, "farm:plot:autoReplant:success", { plot: { ...plot } });
    schedulePersist();
    return true;
  }

  return false;
}

function applyActionImprovements(player, actionId) {
  let updated = false;
  for (const improvement of actionImprovements[actionId] || []) {
    addStatusExp(player, improvement.status, improvement.increaseExp);
    updated = true;
  }
  return updated;
}

function stopTaskRunner(player) {
  const runner = taskRunners.get(player.uuid);
  if (!runner) return;
  if (runner.timer) clearTimeout(runner.timer);
  taskRunners.delete(player.uuid);
}

function runTaskQueue(socket) {
  const player = socket.player;
  const runner = taskRunners.get(player.uuid);
  if (!runner) return;
  runner.timer = null;
  const task = player.taskQueue[0];
  if (!task) {
    stopTaskRunner(player);
    dispatchTaskQueue(socket);
    return;
  }
  // 上线/换装后队列里的时长要跟着生活装备走（这里幂等：没变化时直接跳过）
  if (refreshWorkTaskDurations(player)) {
    dispatchTaskQueue(socket);
    schedulePersist();
  }
  if (task.paused) {
    // 「材料不足」的暂停要能自己醒过来：玩家补货后不必重启服务/重排任务。
    // 这里每秒探一次，材料齐了就当场解除暂停继续跑；其它暂停原因（手动）保持不动。
    if (task.pauseReason === "insufficient_resource" && !taskRequirementError(player, task.actionId)) {
      task.paused = false;
      task.pauseReason = null;
      task.lastSubtaskDoneTime = Date.now();
      emitGameEvent(socket, "taskUpdated", task);
      dispatchTaskQueue(socket);
      schedulePersist();
    } else {
      runner.timer = setTimeout(() => runTaskQueue(socket), 1000);
      return;
    }
  }
  const now = Date.now();
  if (!task.lastSubtaskDoneTime || task.lastSubtaskDoneTime > now) task.lastSubtaskDoneTime = now;
  const completionTime = task.lastSubtaskDoneTime + (Number(task.duration) || actionDurationMs[task.actionId] || 24e3);
  const remaining = completionTime - now;
  if (remaining > 0) {
    runner.timer = setTimeout(() => runTaskQueue(socket), Math.min(remaining, 1000));
    return;
  }
  const requirementError = consumeTaskRequirements(player, task.actionId);
  if (requirementError) {
    // 饱食度是每个生活动作的固定消耗，等不到补充就会永远卡在队首（前端也没有暂停原因提示，
    // 表现就是队列不动）。这种情况直接结束这一项，让队列继续往下走。
    // 其它材料不足仍保持暂停：玩家补货后能自动接上，不需要重新排任务。
    if (requirementError.resourceId === "__satiety") {
      player.taskQueue.shift();
      console.log(`[task] ${player.name || player.uuid} 饱食度不足（需要 ${requirementError.required}，持有 ${requirementError.available}），结束任务 ${task.actionId}`);
      emitGameEvent(socket, "needResetCurrentActionProgress", null);
      if (player.taskQueue[0]) player.taskQueue[0].lastSubtaskDoneTime = now;
      dispatchTaskQueue(socket);
      schedulePersist();
      if (player.taskQueue.length) runner.timer = setTimeout(() => runTaskQueue(socket), 0);
      else stopTaskRunner(player);
      return;
    }
    task.paused = true;
    task.pauseReason = "insufficient_resource";
    task.lastSubtaskDoneTime = now;
    emitGameEvent(socket, "taskUpdated", task);
    dispatchTaskQueue(socket);
    schedulePersist();
    runner.timer = setTimeout(() => runTaskQueue(socket), 1000);
    return;
  }
  task.currentRepeat = Math.min(task.repeatCount, task.currentRepeat + 1);
  task.lastSubtaskDoneTime = now;
  const gained = applyActionRewards(player, task.actionId);
  if (Object.keys(gained).length) {
    emitGameEvent(socket, "dispatchInventoryInfo", player.inventory);
    emitGameEvent(socket, "inventoryUpdated", player.inventory);
    emitGameEvent(socket, "inventory:increase:success", gained);
  }
  if (applyActionImprovements(player, task.actionId)) {
    emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(player).status);
  }
  // 建造任务完成：写成 BUILT。前端只在 characterInitData 里合并 building，
  // 而它定义的 dispatchCharacterBuildingInfo 事件并没有监听者，所以只能重发整包初始数据。
  if (completeBuildingAction(player, task.actionId)) {
    emitGameEvent(socket, "characterInitData", { data: characterInitData(player) });
  }
  for (const quest of advanceQuests(player, task.actionId)) emitGameEvent(socket, "quest:updated", quest);
  schedulePersist();
  if (task.currentRepeat >= task.repeatCount) {
    player.taskQueue.shift();
    emitGameEvent(socket, "taskDone", task);
    if (player.taskQueue[0]) player.taskQueue[0].lastSubtaskDoneTime = now;
  } else {
    emitGameEvent(socket, "taskUpdated", task);
  }
  dispatchTaskQueue(socket);
  if (player.taskQueue.length) {
    runner.timer = setTimeout(() => runTaskQueue(socket), 0);
  } else {
    stopTaskRunner(player);
  }
}

function startTaskRunner(socket) {
  const player = socket.player;
  if (!player) return;
  let runner = taskRunners.get(player.uuid);
  if (!runner) {
    runner = { socket, timer: null };
    taskRunners.set(player.uuid, runner);
  } else {
    runner.socket = socket;
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = null;
  }
  runTaskQueue(socket);
}

// 在线玩家每分钟巡检：按玩家 UUID 去重（同一账号多标签页不能把自动化跑两次）。
setInterval(() => {
  let changed = false;
  const processedPlayers = new Set();
  for (const socket of io.sockets.sockets.values()) {
    const player = socket.player;
    if (!player || processedPlayers.has(player.uuid)) continue;
    processedPlayers.add(player.uuid);
    let playerChanged = false;
    if (syncQuests(player)) {
      emitToPlayer(player.uuid, "quest:list:success", player.quests);
      changed = true;
      playerChanged = true;
    }
    if (farmRefreshPlots(player)) {
      changed = true;
      playerChanged = true;
    }
    // Lv2 且服务生效时才自动收获；欠费不会修改 autoReplant 配置，续费后继续执行。
    if (homeServiceCan(2)) {
      for (const plot of farmEnsurePlots(player)) {
        if (plot.state !== "READY" || !plot.autoReplant) continue;
        const seedId = plot.seedId;
        const plan = farmPlantPlan(seedId, plot.fertilizers);
        if (!plan) continue;
        const rawRewards = farmRollYields(plan);
        const rewards = Object.fromEntries(Object.entries(rawRewards).map(([id, count]) => [id, Math.ceil(count * 0.8)]).filter(([, count]) => count > 0));
        addHarvestBox(player, "家政服务自动收获", rewards);
        farmAddExp(player, plan.crop.farmingPlantExpGainWhenHarvest);
        const replantCosts = farmPlantCosts(plan);
        const replantMissing = farmTakeCosts(player, replantCosts);
        if (!replantMissing) farmStartGrowing(plot, seedId, plan);
        else farmClearPlot(plot);
        changed = true;
        playerChanged = true;
      }
    }
    if (playerChanged) {
      emitToPlayer(player.uuid, "farm:plots:success", { list: player.farmPlots });
      emitToPlayer(player.uuid, "dispatchCharacterStatusInfo", characterInitData(player).status);
      for (const connected of marketPlayerSockets(player.uuid)) emitPlayerResources(connected);
    }
  }
  if (changed) schedulePersist();
}, 60 * 1000);

const KNOWN_UNSUPPORTED_SOCKET_EVENTS = new Map([
  ["kitty:getAllFriend", { feature: "kittyFriendProfile", suffix: "error", message: "其他猫咪档案尚未实现" }],
  ["kitty:getAllTask", { feature: "kittyTaskQueue", suffix: "error", message: "猫咪独立任务队列尚未实现" }],
  ["worldBoss:listAvailable", { feature: "worldBoss", suffix: "fail", message: "世界 Boss 尚未实现" }],
  ["battle:battleInfoDetail", { feature: "battleInfoDetailQuery", suffix: "error", message: "主动查询战斗统计尚未实现；战斗结束时仍会推送统计" }]
]);

function handleKnownUnsupportedEvent(socket, event) {
  const contract = KNOWN_UNSUPPORTED_SOCKET_EVENTS.get(event);
  if (!contract) return false;
  if (contract.responseEvent) {
    emitGameEvent(socket, contract.responseEvent, unsupportedFeaturePayload(contract.feature, event, contract.message));
    return true;
  }
  return emitUnsupportedFeature(socket, event, contract.feature, contract.suffix, contract.message);
}

const PHASE_ONE_SOCKET_EVENTS = new Set([
  "userPersonalization:get", "userPersonalization:setFavorites", "style:get", "style:setAll"
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseStrictClientEnvelope(payload, { allowNullData = false } = {}) {
  if (typeof payload !== "string") return { ok: false };
  let outer;
  try { outer = JSON.parse(payload); } catch { return { ok: false }; }
  if (!isPlainObject(outer) || Object.keys(outer).length !== 1 || !Object.hasOwn(outer, "data")) return { ok: false };
  if (outer.data === null && allowNullData) return { ok: true, data: null };
  if (!isPlainObject(outer.data)) return { ok: false };
  return { ok: true, data: outer.data };
}

function invalidPayload(message = "请求格式无效") {
  return { code: "INVALID_PAYLOAD", message };
}

function versionConflict(state, message = "数据版本已变化，请刷新后重试") {
  return { code: "VERSION_CONFLICT", message, version: state.version, state };
}

function validateExpectedVersion(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function validatePhaseOneRequestId(value) {
  return value === undefined || (typeof value === "string" && value.length >= 1 && value.length <= 100);
}

function withPhaseOneRequestId(payload, requestId) {
  return requestId === undefined ? payload : { ...payload, requestId };
}

function validatePersonalizationMutation(data) {
  if (!isPlainObject(data) || Object.keys(data).some((key) => !["favorites", "categoryOrder", "expectedVersion", "requestId"].includes(key))
    || (!Object.hasOwn(data, "favorites") && !Object.hasOwn(data, "categoryOrder"))
    || !validateExpectedVersion(data.expectedVersion) || !validatePhaseOneRequestId(data.requestId)) return invalidPayload();
  let favorites;
  if (Object.hasOwn(data, "favorites")) {
    if (!Array.isArray(data.favorites) || data.favorites.length > PERSONALIZATION_FAVORITES_LIMIT) return invalidPayload();
    const seen = new Set();
    favorites = [];
    for (const id of data.favorites) {
      if (typeof id !== "string" || FORBIDDEN_OBJECT_KEYS.has(id) || seen.has(id) || !RESOURCE_ID_CATALOG.has(id)) return invalidPayload();
      seen.add(id);
      favorites.push(id);
    }
  }
  let categoryOrder;
  if (Object.hasOwn(data, "categoryOrder")) {
    if (!Array.isArray(data.categoryOrder) || data.categoryOrder.length > PERSONALIZATION_CATEGORY_LIMIT) return invalidPayload();
    const seen = new Set();
    categoryOrder = [];
    for (const category of data.categoryOrder) {
      if (typeof category !== "string" || category.length === 0 || category.length > PERSONALIZATION_CATEGORY_LENGTH_LIMIT
        || FORBIDDEN_OBJECT_KEYS.has(category) || seen.has(category)) return invalidPayload();
      seen.add(category);
      categoryOrder.push(category);
    }
  }
  return { favorites, categoryOrder, expectedVersion: data.expectedVersion, requestId: data.requestId };
}

function validateDiyMutation(value) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !["bgColor", "textColor", "textShadow"].includes(key))) return null;
  if (!Array.isArray(value.bgColor) || !Array.isArray(value.textColor) || !Array.isArray(value.textShadow)
    || value.bgColor.length > DIY_COLOR_LIMIT || value.textColor.length > DIY_COLOR_LIMIT || value.textShadow.length > DIY_TEXT_SHADOW_LIMIT) return null;
  const colors = (values) => {
    const seen = new Set();
    const result = [];
    for (const color of values) {
      if (typeof color !== "string" || !SAFE_CSS_HEX.test(color)) return null;
      const key = color.toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(color); }
    }
    return result;
  };
  const bgColor = colors(value.bgColor);
  const textColor = colors(value.textColor);
  if (!bgColor || !textColor) return null;
  const shadowSeen = new Set();
  const textShadow = [];
  for (const shadow of value.textShadow) {
    if (!isPlainObject(shadow) || Object.keys(shadow).sort().join(",") !== "blur,color" || typeof shadow.color !== "string"
      || !SAFE_CSS_HEX.test(shadow.color) || !Number.isInteger(shadow.blur) || shadow.blur < 1 || shadow.blur > 10) return null;
    const key = `${shadow.color.toLowerCase()}\u0000${shadow.blur}`;
    if (!shadowSeen.has(key)) { shadowSeen.add(key); textShadow.push({ color: shadow.color, blur: shadow.blur }); }
  }
  return { bgColor, textColor, textShadow };
}

function validateStyleMutation(player, data) {
  if (!isPlainObject(data) || Object.keys(data).some((key) => !["style", "expectedVersion", "requestId"].includes(key))
    || !Object.hasOwn(data, "style") || !validateExpectedVersion(data.expectedVersion)
    || !validatePhaseOneRequestId(data.requestId) || !isPlainObject(data.style)) return invalidPayload();
  const style = data.style;
  const acceptedEchoes = new Set(["version", "updatedAt", "diyChatBubbleStyle", ...STYLE_FIELDS.flatMap(([, available, current]) => [available, current])]);
  if (Object.keys(style).some((key) => !acceptedEchoes.has(key))) return invalidPayload();
  const current = normalizeStyleState(player.style, player.uniqueFlag);
  const selected = {};
  for (const [category, , currentField] of STYLE_FIELDS) {
    if (!Object.hasOwn(style, currentField) || typeof style[currentField] !== "string") return invalidPayload();
    const choice = style[currentField];
    if (choice === "diy" || (choice !== "" && !current.owned[category].includes(choice))) return { code: "STYLE_NOT_OWNED", message: "所选样式尚未拥有" };
    selected[category] = choice;
  }
  let diy = freshStyleState().diyChatBubbleStyle;
  if (Object.hasOwn(style, "diyChatBubbleStyle")) {
    diy = validateDiyMutation(style.diyChatBubbleStyle);
    if (!diy) return invalidPayload();
  }
  const nonemptyDiy = diy.bgColor.length || diy.textColor.length || diy.textShadow.length;
  if (nonemptyDiy && !hasDiyStyleEntitlement(player)) return { code: "STYLE_NOT_OWNED", message: "尚未解锁自定义聊天气泡" };
  return { selected, diy, expectedVersion: data.expectedVersion, requestId: data.requestId };
}

function persistPlayersNow() {
  const hadPendingFullFlush = Boolean(persistTimer) || persistRequested;
  if (phaseOneTestHooksEnabled) {
    testPersistenceCounters.phaseOnePersistCalls += 1;
    if (hadPendingFullFlush) testPersistenceCounters.phaseOnePendingBranchStarted += 1;
  }
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (persistInProgress) throw new Error("persistence busy");
  if (hadPendingFullFlush) {
    persistRequested = false;
    persistInProgress = true;
    try {
      writeJsonAtomic(marketDataFile, [...marketTrades.values()].map(marketPersistenceView));
      writeJsonAtomic(socialDataFile, socialPersistenceView());
      writeJsonAtomic(auctionDataFile, auctionPersistenceView());
      writeJsonAtomic(shopDataFile, shopPersistenceView());
      writeJsonAtomic(villageDataFile, villagePersistenceView());
      writeJsonAtomic(battleRoomFile, { version: 1, savedAt: new Date().toISOString(), rooms: [...battleRooms.values()].map(battleRoomPersistenceView) });
      writePlayersJsonNow({ injectFailure: true });
      if (phaseOneTestHooksEnabled) testPersistenceCounters.phaseOnePendingBranchCompleted += 1;
    } catch (error) {
      if (phaseOneTestHooksEnabled) {
        testPersistenceCounters.phaseOnePendingBranchFailed += 1;
        testPersistenceCounters.phaseOneRetryScheduled += 1;
        testPhaseOneRetriesPending += 1;
      }
      persistRequested = false;
      setTimeout(() => {
        if (phaseOneTestHooksEnabled) {
          testPersistenceCounters.phaseOneRetryStarted += 1;
          testPhaseOneRetryReady = true;
        }
        persistRequested = false;
        schedulePersist();
      }, 0).unref?.();
      throw error;
    } finally {
      persistInProgress = false;
      if (persistRequested) { persistRequested = false; schedulePersist(); }
    }
    return;
  }
  persistInProgress = true;
  try { writePlayersJsonNow({ injectFailure: true }); }
  finally { persistInProgress = false; }
}

function phaseOneSockets(uuid) {
  return [...io.sockets.sockets.values()].filter((candidate) => candidate.player?.uuid === uuid);
}

function emitPhaseOneSuccess(socket, uuid, event, payload, requestId) {
  for (const target of phaseOneSockets(uuid)) {
    emitGameEvent(target, event, target === socket ? withPhaseOneRequestId(payload, requestId) : payload);
  }
}

function handlePhaseOneSocketEvent(socket, event, payload) {
  if (!PHASE_ONE_SOCKET_EVENTS.has(event)) return false;
  if (event === "userPersonalization:get") {
    const parsed = parseStrictClientEnvelope(payload, { allowNullData: true });
    if (!parsed.ok) {
      emitGameEvent(socket, "userPersonalization:error", invalidPayload());
      return true;
    }
    const requestId = parsed.data?.requestId;
    if ((parsed.data !== null && Object.keys(parsed.data).some((key) => key !== "requestId"))
      || !validatePhaseOneRequestId(requestId)) {
      emitGameEvent(socket, "userPersonalization:error", withPhaseOneRequestId(invalidPayload(), validatePhaseOneRequestId(requestId) ? requestId : undefined));
      return true;
    }
    const state = normalizePersonalizationState(socket.player.personalization);
    socket.player.personalization = state;
    emitGameEvent(socket, "userPersonalization:get:success", withPhaseOneRequestId(state, requestId));
    return true;
  }
  if (event === "style:get") {
    const parsed = parseStrictClientEnvelope(payload, { allowNullData: true });
    if (!parsed.ok) { emitGameEvent(socket, "style:get:fail", invalidPayload()); return true; }
    const data = parsed.data ?? {};
    if (Object.keys(data).some((key) => !["uuid", "requestId"].includes(key)) || !validatePhaseOneRequestId(data.requestId)
      || (Object.hasOwn(data, "uuid") && (typeof data.uuid !== "string" || !data.uuid || !UUID_PATTERN.test(data.uuid)))) {
      emitGameEvent(socket, "style:get:fail", withPhaseOneRequestId(invalidPayload(), validatePhaseOneRequestId(data.requestId) ? data.requestId : undefined));
      return true;
    }
    const uuid = data.uuid || socket.player.uuid;
    const target = players.get(uuid);
    if (!target) {
      emitGameEvent(socket, "style:get:fail", withPhaseOneRequestId({ code: "PLAYER_NOT_FOUND", message: "玩家不存在", uuid }, data.requestId));
      return true;
    }
    emitGameEvent(socket, "style:get:success", withPhaseOneRequestId({ uuid, style: uuid === socket.player.uuid ? styleWireView(target) : publicStyleView(target) }, data.requestId));
    return true;
  }
  const parsed = parseStrictClientEnvelope(payload);
  const errorEvent = event === "style:setAll" ? "style:setAll:fail" : "userPersonalization:error";
  if (!parsed.ok) { emitGameEvent(socket, errorEvent, invalidPayload()); return true; }
  const rawRequestId = validatePhaseOneRequestId(parsed.data.requestId) ? parsed.data.requestId : undefined;
  serializePhaseOneMutation(socket.player.uuid, () => {
    const player = players.get(socket.player.uuid);
    if (!player) return;
    if (event === "userPersonalization:setFavorites") {
      const checked = validatePersonalizationMutation(parsed.data);
      if (checked.code) { emitGameEvent(socket, errorEvent, withPhaseOneRequestId(checked, rawRequestId)); return; }
      const oldState = normalizePersonalizationState(player.personalization);
      if (checked.expectedVersion !== undefined && checked.expectedVersion !== oldState.version) {
        emitGameEvent(socket, errorEvent, withPhaseOneRequestId(versionConflict(oldState), checked.requestId)); return;
      }
      const next = { ...oldState, favoriteItems: checked.favorites ?? oldState.favoriteItems, categoryOrder: checked.categoryOrder ?? oldState.categoryOrder,
        version: oldState.version + 1, updatedAt: nextUpdatedAt(oldState.updatedAt) };
      player.personalization = next;
      try { persistPlayersNow(); } catch {
        player.personalization = oldState;
        emitGameEvent(socket, errorEvent, withPhaseOneRequestId({ code: "PERSISTENCE_ERROR", message: "保存失败，请稍后重试" }, checked.requestId));
        return;
      }
      emitPhaseOneSuccess(socket, player.uuid, "userPersonalization:setFavorites:success", {
        favoriteItems: [...next.favoriteItems], categoryOrder: [...next.categoryOrder], version: next.version, updatedAt: next.updatedAt
      }, checked.requestId);
      return;
    }
    const checked = validateStyleMutation(player, parsed.data);
    if (checked.code) { emitGameEvent(socket, errorEvent, withPhaseOneRequestId(checked, rawRequestId)); return; }
    const oldState = normalizeStyleState(player.style, player.uniqueFlag);
    if (checked.expectedVersion !== undefined && checked.expectedVersion !== oldState.version) {
      emitGameEvent(socket, errorEvent, withPhaseOneRequestId(versionConflict(styleWireView(player)), checked.requestId)); return;
    }
    const next = { ...oldState, selected: checked.selected, diyChatBubbleStyle: checked.diy,
      version: oldState.version + 1, updatedAt: nextUpdatedAt(oldState.updatedAt) };
    player.style = next;
    try { persistPlayersNow(); } catch {
      player.style = oldState;
      emitGameEvent(socket, errorEvent, withPhaseOneRequestId({ code: "PERSISTENCE_ERROR", message: "保存失败，请稍后重试" }, checked.requestId));
      return;
    }
    emitPhaseOneSuccess(socket, player.uuid, "style:setAll:success", { style: styleWireView(player) }, checked.requestId);
  }).catch((error) => {
    console.error("phase-one mutation failed", error);
    emitGameEvent(socket, errorEvent, withPhaseOneRequestId({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" }, rawRequestId));
  });
  return true;
}

io.on("connection", (socket) => {
  if (!socket.player) {
    emitGameEvent(socket, "authRequired", { code: 401, msg: "未登录" });
    return;
  }
  // 老存档可能在被禁用的槽位上还挂着装备，进游戏时先收拾干净
  sanitizeDisabledBattleEquipment(socket.player);
  const sendCharacterInit = () => {
    if (syncQuests(socket.player)) schedulePersist();
    emitGameEvent(socket, "characterInitData", { data: characterInitData(socket.player) });
    emitGameEvent(socket, "quest:list:success", socket.player.quests);
    emitGameEvent(socket, "join-room:success", { uuid: socket.player.uuid });
    startTaskRunner(socket);
  };
  emitGameEvent(socket, "gameInited", { uuid: socket.player.uuid });
  setTimeout(() => {
    if (socket.connected) sendCharacterInit();
  }, 500);
  socket.onAny((event, payload) => {
    if (PHASE_ONE_SOCKET_EVENTS.has(event)) {
      handlePhaseOneSocketEvent(socket, event, payload);
      return;
    }
    if (["connect", "disconnect"].includes(event)) return;
    if (event === "joinRoom") {
      sendCharacterInit();
      return;
    }
    if (["connect", "disconnect"].includes(event)) return;
    let data = payload;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = {};
      }
    }
    data = data?.data ?? data ?? {};
    if (event === "character:getEquipment") {
      const equipmentType = data.type === "battle" ? "battle" : "work";
      const equipment = equipmentType === "battle" ? socket.player.battleEquipment : socket.player.workEquipment;
      emitGameEvent(socket, `character:getEquipment:${equipmentType}:success`, equipment);
      return;
    }
    if (handleRankingEvent(socket, event, data)) return;
    if (event.startsWith("market:") || event.startsWith("buyerMarket:") || event.startsWith("newMarket:")) {
      const handled = handleMarketEvent(socket, event, payload);
      if (handled !== false) return;
    }
    if (event === "requestShopBuyResource") {
      const result = shopBuy(socket.player, data);
      if (result.error) {
        emitGameEvent(socket, "requestShopBuyResource:fail", { message: result.error });
        return;
      }
      emitPlayerResources(socket);
      emitGameEvent(socket, "shopBuySuccess", { tradeInfo: result.tradeInfo });
      return;
    }
    if (event === "requestShopSellResource") {
      const result = shopSell(socket.player, data);
      if (result.error) {
        emitGameEvent(socket, "requestShopSellResource:fail", { message: result.error });
        return;
      }
      emitPlayerResources(socket);
      emitGameEvent(socket, "shopSellSuccess", { tradeInfo: result.tradeInfo });
      return;
    }
    if (event === "requestInventoryInfo") {
      // 商店/市场成交后前端会发这个主动拉一次库存
      emitPlayerResources(socket);
      return;
    }
    if (event === "sponsorPoint:get") {
      emitGameEvent(socket, "sponsorPoint:get:success", socket.player.sponsorPoint || { current: 0, max: 0 });
      return;
    }
    if (handleKnownUnsupportedEvent(socket, event)) return;
    if (event.startsWith("battleRoom:") || event.startsWith("battle:")) {
      const handled = handleBattleRoomEvent(socket, event, data);
      if (handled !== false) return;
    }
    if (event === "task:reorder") {
      const queue = socket.player.taskQueue;
      const requestedIds = Array.isArray(data.taskUUIDs) ? data.taskUUIDs.map(String) : [];
      const currentHead = queue[0]?.uuid || "";
      if (data.headUUID && data.headUUID !== currentHead) {
        emitGameEvent(socket, "task:reorder:failed", { message: "当前任务已变化，请刷新队列" });
        return;
      }
      const byId = new Map(queue.map((task) => [task.uuid, task]));
      const expectedTailLength = Math.max(0, queue.length - 1);
      if (requestedIds.length !== expectedTailLength || requestedIds.some((uuid) => !byId.has(uuid)) || requestedIds.includes(currentHead) || new Set(requestedIds).size !== requestedIds.length) {
        emitGameEvent(socket, "task:reorder:failed", { message: "任务队列参数无效" });
        return;
      }
      socket.player.taskQueue = queue.length ? [queue[0], ...requestedIds.map((uuid) => byId.get(uuid))] : [];
      dispatchTaskQueue(socket);
      schedulePersist();
      emitGameEvent(socket, "task:reorder:success", { message: "队列排序已保存", taskQueue: socket.player.taskQueue });
      return;
    }
    if (event === "removeTaskFromQueue") {
      const taskUuid = String(data.uuid || "");
      const index = socket.player.taskQueue.findIndex((task) => task.uuid === taskUuid);
      if (index < 0) {
        emitGameEvent(socket, "removeTaskFromQueue:fail", { message: "任务不存在" });
        return;
      }
      const [removedTask] = socket.player.taskQueue.splice(index, 1);
      if (index === 0) {
        emitGameEvent(socket, "needResetCurrentActionProgress", null);
        if (socket.player.taskQueue[0]) socket.player.taskQueue[0].lastSubtaskDoneTime = Date.now();
      }
      dispatchTaskQueue(socket);
      startTaskRunner(socket);
      schedulePersist();
      emitGameEvent(socket, "removeTaskFromQueue:success", removedTask);
      return;
    }
    if (event === "task:pause" || event === "task:resume") {
      const taskUuid = String(data.uuid || socket.player.taskQueue[0]?.uuid || "");
      const task = socket.player.taskQueue.find((item) => item.uuid === taskUuid);
      if (!task) {
        emitGameEvent(socket, `${event}:failed`, { message: "任务不存在" });
        return;
      }
      task.paused = event === "task:pause";
      task.pauseReason = task.paused ? "manual" : null;
      if (!task.paused) task.lastSubtaskDoneTime = Date.now();
      dispatchTaskQueue(socket);
      startTaskRunner(socket);
      schedulePersist();
      emitGameEvent(socket, `${event}:success`, task);
      return;
    }
    if (event === "addTaskToQueue" || event === "task:immediatelyStart") {
      const failureEvent = event === "task:immediatelyStart" ? `${event}:failed` : `${event}:fail`;
      if (!data.actionId) {
        emitGameEvent(socket, failureEvent, { message: "missing action" });
        return;
      }
      if (!taskActionExists(data.actionId)) {
        emitGameEvent(socket, failureEvent, { message: "unknown action" });
        return;
      }
      // 建造动作：已建成的不能再排；一次只建一栋（前端固定发 repeatCount:1，这里兜一层）
      const buildingAction = buildingActions[data.actionId];
      if (buildingAction) {
        if (isBuildingBuilt(socket.player, buildingAction.type)) {
          emitGameEvent(socket, failureEvent, { message: "该建筑已建造" });
          return;
        }
        if (socket.player.taskQueue.some((queued) => queued?.actionId === data.actionId)) {
          emitGameEvent(socket, failureEvent, { message: "该建筑已在队列中" });
          return;
        }
        data.repeatCount = 1;
      }
      const task = makeTask(data, socket.player);
      if (event === "task:immediatelyStart") socket.player.taskQueue.unshift(task);
      else socket.player.taskQueue.push(task);
      dispatchTaskQueue(socket);
      startTaskRunner(socket);
      emitGameEvent(socket, event + ":success", task);
      return;
    }
    if (event === "getTaskQueue") {
      dispatchTaskQueue(socket);
      startTaskRunner(socket);
      emitGameEvent(socket, "getTaskQueue:success", socket.player.taskQueue);
      return;
    }
    if (event === "effectAction:useItem") {
      serializePhaseOneMutation(socket.player.uuid, () => {
        const player = players.get(socket.player.uuid);
        if (!player) return;
        const oldInventory = structuredClone(player.inventory);
        const oldFlags = structuredClone(player.uniqueFlag);
        const oldStyle = structuredClone(player.style);
        const result = useItem(player, data.itemId, data.multiple);
        if (result.error) {
          player.inventory = oldInventory;
          player.uniqueFlag = oldFlags;
          player.style = oldStyle;
          emitGameEvent(socket, "effectAction:useItem:error", { message: result.error });
          return;
        }
        if (result.cosmetic) {
          try { persistPlayersNow(); } catch {
            player.inventory = oldInventory;
            player.uniqueFlag = oldFlags;
            player.style = oldStyle;
            emitGameEvent(socket, "effectAction:useItem:error", { code: "PERSISTENCE_ERROR", message: "保存失败，请稍后重试" });
            return;
          }
        }
        for (const target of phaseOneSockets(player.uuid)) {
          emitGameEvent(target, "dispatchInventoryInfo", player.inventory);
          emitGameEvent(target, "inventoryUpdated", player.inventory);
        }
        const gained = result.gained || {};
        if (Object.keys(gained).length) emitGameEvent(socket, "inventory:increase:success", gained);
        if (result.learnedSkill) emitToPlayer(player.uuid, "character:getSkills:success", normalizePlayerSkills(player));
        emitGameEvent(socket, "effectAction:useItem:success", { itemId: data.itemId, multiple: Math.max(1, Math.floor(Number(data.multiple) || 1)), gained, learnedSkill: result.learnedSkill });
        if (result.cosmetic) {
          const stylePayload = { uuid: player.uuid, style: styleWireView(player) };
          for (const target of phaseOneSockets(player.uuid)) emitGameEvent(target, "style:get:success", stylePayload);
        } else schedulePersist();
      }).catch((error) => {
        console.error("use item mutation failed", error);
        emitGameEvent(socket, "effectAction:useItem:error", { code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
      });
      return;
    }
    if (event === "effectAction:equipItem") {
      const resourceId = String(data.resourceId || "");
      const result = equipItem(socket.player, resourceId, data.type, data.part);
      if (result.error) {
        emitGameEvent(socket, "effectAction:equip:error", { message: result.error });
        return;
      }
      emitGameEvent(socket, "effectAction:equip:success", { equipment: result.equipment, info: { resourceId } });
      emitGameEvent(socket, "dispatchInventoryInfo", socket.player.inventory);
      emitGameEvent(socket, "inventoryUpdated", socket.player.inventory);
      // 属性面板（角色→属性）只在收到 dispatchCharacterStatusInfo 时刷新，
      // 战斗装备改力量/敏捷/攻击、生活装备改幸运，都要立刻推一份新的明细。
      emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(socket.player).status);
      // 生活装备带 actionDurationEffect / resourceRequirementModifyEffect：
      // 立刻重算已排队任务的时长并推给前端；带这类修正的装备还要重发初始数据，
      // 让前端的「⏰ 预计完成 / 😋 饱食度」模型跟着变（前端只在 characterInitData 里更新它们）。
      if (result.type === "work") {
        if (refreshWorkTaskDurations(socket.player)) {
          dispatchTaskQueue(socket);
          startTaskRunner(socket);
          schedulePersist();
        }
        if (affectsActionDetail(resourceCatalog[resourceId]) || affectsActionDetail(resourceCatalog[result.replaced])) {
          emitGameEvent(socket, "characterInitData", { data: characterInitData(socket.player) });
        }
      }
      return;
    }
    if (event === "effectAction:unequipItem") {
      const part = String(data.part || "");
      const result = unequipItem(socket.player, part, data.type);
      if (result.error) {
        emitGameEvent(socket, "effectAction:unequip:error", { message: result.error });
        return;
      }
      emitGameEvent(socket, "effectAction:unequip:success", result.equipment);
      emitGameEvent(socket, "dispatchInventoryInfo", socket.player.inventory);
      emitGameEvent(socket, "inventoryUpdated", socket.player.inventory);
      emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(socket.player).status);
      if (result.type === "work") {
        if (refreshWorkTaskDurations(socket.player)) {
          dispatchTaskQueue(socket);
          startTaskRunner(socket);
          schedulePersist();
        }
        if (affectsActionDetail(resourceCatalog[result.resourceId])) {
          emitGameEvent(socket, "characterInitData", { data: characterInitData(socket.player) });
        }
      }
      return;
    }
    if (event === "character:updateProfile") {
      const result = applyCharacterProfileUpdate(socket.player, data);
      if (result.error) {
        // 前端把 payload 直接丢给 ElMessage，所以这里必须发字符串
        emitGameEvent(socket, "character:updateProfile:error", result.error);
        return;
      }
      schedulePersist();
      emitGameEvent(socket, "character:updateProfile:success", "保存成功");
      // 名字/头像变了，房间成员列表要跟着刷
      const room = getBattleRoom(socket.player.currentBattleRoomId);
      if (room) emitRoomUpdate(room);
      return;
    }
    if (event === "requestCharacterStatusInfo") {
      // 「角色→属性」面板挂载时要一次最新明细。前端没有 requestCharacterStatusInfo:success
      // 的监听者，唯一的更新通道是 dispatchCharacterStatusInfo（index-CnYosZ2K.js 约 463268
      // 里 U.value = e，整包替换 characterStatusInfo）。
      emitGameEvent(socket, "dispatchCharacterStatusInfo", characterInitData(socket.player).status);
      return;
    }
    // 技能页的写操作：都存在 player.skillList / player.skillOutfits 上，写完重推整包技能列表
    if (
      event.startsWith("skillOutfit:") ||
      event === "character:enableSkill" ||
      event === "character:disableSkill" ||
      event === "character:reorderSkill" ||
      event === "character:updateSkillCastLogic" ||
      event === "character:copySkillLogic"
    ) {
      if (handleSkillConfigEvent(socket, event, data)) return;
    }
    // 战斗物品袋（技能&物品袋 → 战斗物品配置）
    if (
      event === "character:getBattleInventory" ||
      event === "character:addResourceToBattleInventory" ||
      event === "character:removeResourceFromBattleInventory" ||
      event === "character:refillBattleInventory" ||
      event === "character:reorderBattleInventory" ||
      event === "character:updateBattleUseItemLogic"
    ) {
      if (handleBattleInventoryEvent(socket, event, data)) return;
    }
    if (event === "user:checkBanned") {
      emitGameEvent(socket, "user:checkBanned:success", { banned: false });
      return true;
    }
    if (event.startsWith("skillTree:") && handleSkillTreeEvent(socket, event, data) === true) return;
    if (event.startsWith("friend:") && handleFriendEvent(socket, event, data) === true) return;
    if (event.startsWith("guild:") && handleGuildEvent(socket, event, data) === true) return;
    if (event.startsWith("chat:") && handleChatEvent(socket, event, data) === true) return;
    if (event.startsWith("auction:") && handleAuctionEvent(socket, event, data) === true) return;
    if (event.startsWith("playerShop:") && handlePlayerShopEvent(socket, event, data) === true) return;
    if (event.startsWith("fishing:") && handleFishingEvent(socket, event, data) === true) return;
    if (event.startsWith("outfit:") && handleOutfitEvent(socket, event, data) === true) return;
    if (event.startsWith("villageBuilding:") && handleVillageBuildingEvent(socket, event, data) === true) return;
    if (event.startsWith("homeService:") && handleHomeServiceEvent(socket, event, data) === true) return;
    if (event.startsWith("harvestBox:") && handleHarvestBoxEvent(socket, event, data) === true) return;
    if (event.startsWith("farm:") && handleFarmEvent(socket, event, data) === true) return;
    if (event === "chefSkill:get") {
      emitGameEvent(socket, "chefSkill:get:success", socket.player.chefSkill || { flavors: [], targets: [] });
      return;
    }
    if (event === "chefSkill:update") {
      const normalize = (list) => (Array.isArray(list) ? list : [])
        .filter((row) => row && typeof row.key === "string")
        .map((row) => ({ key: row.key, count: Math.max(0, Math.floor(Number(row.count) || 0)) }));
      const info = data?.info && typeof data.info === "object" ? data.info : {};
      socket.player.chefSkill = { flavors: normalize(info.flavors), targets: normalize(info.targets) };
      schedulePersist();
      emitGameEvent(socket, "chefSkill:update:success", socket.player.chefSkill);
      return;
    }
    if (event === "msgPref:battle:set") {
      socket.player.msgPref ||= { battle: false };
      socket.player.msgPref.battle = Boolean(data?.enable);
      schedulePersist();
      emitGameEvent(socket, "msgPref:battle:set:success", { enable: socket.player.msgPref.battle });
      return;
    }
    if (event.startsWith("quest:") && handleQuestEvent(socket, event, data)) return;
    const result = eventResult(event, socket.player, data);
    if (result !== undefined) {
      emitGameEvent(socket, `${event}:success`, result);
      return;
    }
    if (event === "character:getInfo" || event === "character:getProfile" || event === "character:getOtherPlayerEquipment" || event === "character:getOtherPlayerWorkEquipment") {
      const notFound = { code: "PLAYER_NOT_FOUND", message: "玩家不存在", characterUuid: String(data?.characterUuid || "") };
      emitGameEvent(socket, `${event}:error`, notFound);
      emitGameEvent(socket, `${event}:fail`, notFound);
      return;
    }
    const unsupported = { code: "UNSUPPORTED_EVENT", message: `功能尚未接入：${event}`, event };
    // error 是全局统一契约；同时保留常见 fail 后缀，让只监听模块级 fail 的旧页面也能得到明确失败。
    emitGameEvent(socket, `${event}:error`, unsupported);
    emitGameEvent(socket, `${event}:fail`, unsupported);
    console.warn(`[socket] unsupported event: ${event}`);
  });
});

app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "login.html")));
// GM 后台是独立单页（不参与 Nuxt 构建），改动后台不用重新打包前端
app.get("/gm", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "gm.html"));
});
app.use(express.static(frontendRoot, { index: "index.html", fallthrough: true }));
app.get("*splat", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io")) return next();
  return res.sendFile(path.join(frontendRoot, "index.html"));
});

function shutdown() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  let exitCode = 0;
  try {
    flushPersistedState();
  } catch (error) {
    exitCode = 1;
    console.error("failed to persist during shutdown", error);
  }
  // 必须先断开 Socket.IO 的长连接：只关 httpServer 的话 upgrade 连接不会自己结束，
  // systemd 的 stop-sigterm 会一直等到超时（90s）再 SIGKILL，每次发布白停一分半。
  try {
    io.close();
  } catch {}
  try {
    httpServer.close(() => process.exit(exitCode));
  } catch {}
  // 兜底：无论还有没有挂住的 handle，3 秒内必定退出
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// 把上次运行残留的公共建筑记录与战斗房间接回来。
ensureVillageBuildings();
reconcileVillageBuildings({ persist: true, broadcast: false });
restoreBattleRooms();

httpServer.listen(port, host, () => {
  console.log(`猫猫后端 listening on http://${host}:${port}`);
  console.log(`账号由 MAOMAO_EMAIL / MAOMAO_PASSWORD 配置，当前邮箱: ${configuredEmail}`);
});




