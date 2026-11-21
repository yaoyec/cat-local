import fs from "node:fs";
import path from "node:path";

// 专精（技能树）数据只存在于前端 game-battle-skill 包里，后端不能直接 import：
// 那个模块的依赖链会碰到 document。这里在启动时从源码里取出两棵树的字面量，
// 用 Function 求值（节点里的 getRequires / getLevelDef 都只依赖槽位枚举 G），
// 这样后端也能拿到 maxLevel、每级消耗和前置条件，加点校验就不会和界面脱节。

const SLOT_KEYS = [
  "head",
  "body",
  "arm",
  "leg",
  "foot",
  "leftHand",
  "leftHand2",
  "rightHand",
  "rightHand2",
  "cloak",
  "decorate1",
  "decorate2",
  "decorate3",
  "decorate4",
  "decorate5",
  "decorate6",
  "decorate7",
  "decorate8",
  "decorate9"
];
const SLOT_ENUM = Object.fromEntries(SLOT_KEYS.map((key) => [key, key]));

function sliceBalanced(text, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("无法解析技能树字面量（括号不配对）");
}

function readTreeSource(frontendRoot) {
  const dir = path.join(frontendRoot, "_nuxt");
  const file = fs
    .readdirSync(dir)
    .find((name) => name.startsWith("game-battle-skill-") && name.endsWith(".js"));
  if (!file) throw new Error("未找到 game-battle-skill 包");
  return fs.readFileSync(path.join(dir, file), "utf8");
}

// 战斗树：bt=[...]；生活树：由 pt 派生的 ht/yt/It/St 展开而成，需要连同一小段依赖一起求值
function parseTrees(source) {
  const battleStart = source.indexOf(",bt=[");
  if (battleStart < 0) throw new Error("未找到战斗技能树定义");
  const battleLiteral = sliceBalanced(source, battleStart + ",bt=".length, "[", "]");
  const battleNodes = new Function("G", `return (${battleLiteral});`)(SLOT_ENUM);

  const ptStart = source.indexOf(",pt=[");
  const wtStart = source.indexOf(',wt={id:"life"');
  if (ptStart < 0 || wtStart < 0) throw new Error("未找到生活技能树定义");
  const wtLiteralStart = source.indexOf("{", wtStart);
  const wtLiteral = sliceBalanced(source, wtLiteralStart, "{", "}").replace(/Object\.freeze\(/g, "(");
  const region = source.slice(ptStart + 1, wtStart) + ",wt=" + wtLiteral;
  const lifeTree = new Function("G", `let ${region}; return wt;`)(SLOT_ENUM);

  return { battleNodes, lifeNodes: lifeTree.nodes };
}

// 默认开放槽位（$）与全部槽位（V）：和前端 SkillTreePanel 的判断保持一致
const DEFAULT_BASE_SLOTS = [
  "body", "leg", "foot", "leftHand", "rightHand", "arm", "head", "cloak",
  "decorate1", "decorate2", "decorate3", "decorate4", "decorate5", "decorate6", "decorate7", "decorate8"
];
const DEFAULT_ALL_SLOTS = [
  "body", "leg", "foot", "leftHand", "leftHand2", "rightHand", "rightHand2", "arm", "head", "cloak",
  "decorate1", "decorate2", "decorate3", "decorate4", "decorate5", "decorate6", "decorate7", "decorate8", "decorate9"
];

function parseSlots(source) {
  const match = source.match(/const \$=(\[[^\]]*\]),V=(\[[^\]]*\])/);
  if (!match) return { baseSlots: DEFAULT_BASE_SLOTS, allSlots: DEFAULT_ALL_SLOTS };
  try {
    return { baseSlots: JSON.parse(match[1]), allSlots: JSON.parse(match[2]) };
  } catch {
    return { baseSlots: DEFAULT_BASE_SLOTS, allSlots: DEFAULT_ALL_SLOTS };
  }
}

export function loadSkillTrees(frontendRoot) {
  const result = { trees: {}, baseSlots: DEFAULT_BASE_SLOTS, allSlots: DEFAULT_ALL_SLOTS, error: null };
  try {
    const source = readTreeSource(frontendRoot);
    const { battleNodes, lifeNodes } = parseTrees(source);
    const { baseSlots, allSlots } = parseSlots(source);
    result.baseSlots = baseSlots;
    result.allSlots = allSlots;
    for (const tree of [
      { id: "battle", name: "战斗", nodes: battleNodes },
      { id: "life", name: "生活", nodes: lifeNodes }
    ]) {
      const byId = {};
      for (const node of tree.nodes) byId[node.id] = node;
      result.trees[tree.id] = { id: tree.id, name: tree.name, nodes: tree.nodes, byId };
    }
  } catch (error) {
    result.error = error;
  }
  return result;
}

export function nodeCost(node, level) {
  try {
    return Math.max(0, Number(node?.getLevelDef?.(level)?.cost) || 0);
  } catch {
    return 0;
  }
}

export function nodeRequirements(node, nextLevel) {
  try {
    return node?.getRequires?.(nextLevel) || [];
  } catch {
    return [];
  }
}

// 按已学节点算出战斗装备的开放/禁用槽位（与前端 SkillTreePanel 的 enabled/disabled 算法一致）
export function battleSlotState(catalog, levels) {
  const baseSlots = catalog.baseSlots || [];
  const allSlots = catalog.allSlots || [];
  const enabled = new Set(baseSlots);
  const disabled = new Set();
  const battleLevels = levels?.battle || {};
  for (const [nodeId, rawLevel] of Object.entries(battleLevels)) {
    const node = catalog.trees?.battle?.byId?.[nodeId];
    if (!node || !(Number(rawLevel) > 0)) continue;
    for (const slot of node.enableBattleEquipSlot || []) enabled.add(slot);
    for (const slot of node.disableBattleEquipSlot || []) disabled.add(slot);
  }
  const active = new Set([...enabled].filter((slot) => !disabled.has(slot)));
  return {
    enabled: allSlots.filter((slot) => active.has(slot)),
    disabled: allSlots.filter((slot) => !active.has(slot)),
    explicitDisabled: allSlots.filter((slot) => disabled.has(slot))
  };
}

// 节点加成里唯一和属性面板相关的一类：businessEffects.statusModifyEffect
export function skillTreeStatusBonus(trees, levelsByTree) {
  const bonus = {};
  for (const [treeId, levels] of Object.entries(levelsByTree || {})) {
    const tree = trees[treeId];
    if (!tree) continue;
    for (const [nodeId, level] of Object.entries(levels || {})) {
      const node = tree.byId[nodeId];
      const amount = Math.max(0, Math.floor(Number(level) || 0));
      if (!node || !amount) continue;
      const effect = node.businessEffects?.statusModifyEffect;
      if (typeof effect !== "function") continue;
      let list = [];
      try {
        list = effect(amount) || [];
      } catch {
        continue;
      }
      for (const item of list) {
        if (!item?.status) continue;
        bonus[item.status] = (bonus[item.status] || 0) + (Number(item.modifyNumber) || 0);
      }
    }
  }
  return bonus;
}
