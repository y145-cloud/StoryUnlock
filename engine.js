/**
 * 剧情解锁 Story Unlock — 纯函数引擎
 *
 * 这个文件不 import 任何 SillyTavern / 酒馆助手模块，因此可以直接用 Node 单测。
 * 它负责：
 *   - 从 MVU stat_data 里按路径取变量（自动解开 [值, 说明] 包装）
 *   - 判断条件、执行高级表达式
 *   - 根据规则和当前聊天状态，计算这一刻应该注入什么
 *   - 维护「按聊天隔离」的解锁状态（纯函数，返回新状态，不改入参）
 */

export const ENGINE_VERSION = 1;

export const MODES = ['sticky', 'once', 'window', 'while'];

export const OPERATORS = [
    '>=',
    '>',
    '<=',
    '<',
    '==',
    '!=',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'exists',
    'not_exists',
    'in',
    'not_in',
    'matches',
    'not_matches',
];

const OP_ALIASES = {
    '=': '==',
    '===': '==',
    '!==': '!=',
    '≠': '!=',
    '≥': '>=',
    '=>': '>=',
    '≧': '>=',
    '≤': '<=',
    '=<': '<=',
    '≦': '<=',
    '大于': '>',
    '小于': '<',
    '大于等于': '>=',
    '小于等于': '<=',
    '等于': '==',
    '不等于': '!=',
    '包含': 'contains',
    '不包含': 'not_contains',
    '存在': 'exists',
    '不存在': 'not_exists',
    '属于': 'in',
    '不属于': 'not_in',
    '匹配': 'matches',
    '不匹配': 'not_matches',
    '开头是': 'starts_with',
    '结尾是': 'ends_with',
};

const OP_LABELS = {
    '>=': '≥',
    '>': '>',
    '<=': '≤',
    '<': '<',
    '==': '=',
    '!=': '≠',
    contains: '包含',
    not_contains: '不包含',
    starts_with: '开头是',
    ends_with: '结尾是',
    exists: '存在',
    not_exists: '不存在',
    in: '属于',
    not_in: '不属于',
    matches: '匹配',
    not_matches: '不匹配',
};

const MODE_LABELS = {
    sticky: '解锁后一直注入',
    once: '只注入一次',
    window: '解锁后限时注入',
    while: '条件满足期间注入',
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const objectTag = Object.prototype.toString;

export function isPlainObject(value) {
    return objectTag.call(value) === '[object Object]';
}

/** MVU 的叶子值通常是 [值, "更新说明"]。 */
export function isValueWithDescription(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
}

export function unwrapValue(value) {
    return isValueWithDescription(value) ? value[0] : value;
}

export function newRuleId() {
    try {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return `su_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        }
    } catch {
        /* 忽略 */
    }
    return `su_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ================================================================== */
/* 变量路径                                                           */
/* ================================================================== */

/**
 * 把路径拆成 token，支持：
 *   角色.络络.好感度
 *   角色["络络"].好感度
 *   列表[0].名字
 *   stat_data.角色.络络.好感度
 */
export function tokenizePath(path) {
    let rest = String(path ?? '').trim();
    if (!rest || rest === 'stat_data') return [];
    if (rest.startsWith('stat_data.')) {
        rest = rest.slice('stat_data.'.length);
    } else if (rest.startsWith('stat_data[')) {
        rest = rest.slice('stat_data'.length);
    }

    const tokens = [];
    let buffer = '';
    let i = 0;

    while (i < rest.length) {
        const ch = rest[i];

        if (ch === '.') {
            if (buffer.trim()) tokens.push(buffer.trim());
            buffer = '';
            i += 1;
            continue;
        }

        if (ch === '[') {
            if (buffer.trim()) tokens.push(buffer.trim());
            buffer = '';
            i += 1;
            while (i < rest.length && /\s/.test(rest[i])) i += 1;

            if (rest[i] === '"' || rest[i] === "'") {
                const quote = rest[i];
                i += 1;
                let quoted = '';
                while (i < rest.length && rest[i] !== quote) {
                    if (rest[i] === '\\' && i + 1 < rest.length) i += 1;
                    quoted += rest[i];
                    i += 1;
                }
                if (rest[i] === quote) i += 1;
                while (i < rest.length && /\s/.test(rest[i])) i += 1;
                if (rest[i] === ']') i += 1;
                tokens.push(quoted);
            } else {
                let bare = '';
                while (i < rest.length && rest[i] !== ']') {
                    bare += rest[i];
                    i += 1;
                }
                if (rest[i] === ']') i += 1;
                tokens.push(bare.trim());
            }
            continue;
        }

        buffer += ch;
        i += 1;
    }

    if (buffer.trim()) tokens.push(buffer.trim());
    return tokens
        .filter((token) => token !== '')
        .map((token) => {
            const text = String(token);
            if (
                (text.startsWith('"') && text.endsWith('"'))
                || (text.startsWith("'") && text.endsWith("'"))
            ) {
                return text.slice(1, -1);
            }
            return text;
        });
}

export function joinPath(tokens) {
    let out = '';
    for (const token of tokens) {
        const key = String(token);
        if (/^\d+$/.test(key)) {
            out += `[${key}]`;
        } else if (!out) {
            out = key;
        } else {
            out += `.${key}`;
        }
    }
    return out;
}

export function looksLikePseudoPath(path) {
    return String(path ?? '').trim().startsWith('$');
}

export function pseudoValue(path, ctx = {}) {
    const floor = Number(ctx.floor ?? (Array.isArray(ctx.chat) ? ctx.chat.length : 0)) || 0;
    switch (String(path ?? '').trim()) {
        case '$floor':
        case '$messageCount':
        case '$message_count':
            return floor;
        case '$lastMessage':
        case '$last_message':
            return String(ctx.lastMessage ?? '');
        case '$lastUserMessage':
        case '$last_user_message':
            return String(ctx.lastUserMessage ?? '');
        case '$chatName':
        case '$chat_name':
            return String(ctx.chatName ?? '');
        default:
            return undefined;
    }
}

export function resolveRaw(statData, path) {
    const tokens = tokenizePath(path);
    if (!tokens.length) return statData;

    let current = statData;
    for (const token of tokens) {
        if (current === null || current === undefined) return undefined;
        if (typeof current !== 'object') return undefined;
        if (!hasOwn(current, token) && !(Array.isArray(current) && token === 'length')) {
            return undefined;
        }
        current = current[token];
    }
    return current;
}

export function resolvePath(statData, path) {
    return unwrapValue(resolveRaw(statData, path));
}

/* ================================================================== */
/* 值比较                                                             */
/* ================================================================== */

export function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return null;
        const num = Number(text);
        return Number.isFinite(num) ? num : null;
    }
    return null;
}

export function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value ?? '').trim().toLowerCase();
    if (['true', '1', 'yes', 'on', '是', '真'].includes(text)) return true;
    if (['false', '0', 'no', 'off', '否', '假'].includes(text)) return false;
    return null;
}

export function looseEqual(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
        return (a === null || a === undefined) && (b === null || b === undefined);
    }

    const numA = toNumber(a);
    const numB = toNumber(b);
    if (numA !== null && numB !== null) return numA === numB;

    if (typeof a === 'boolean' || typeof b === 'boolean') {
        const boolA = toBoolean(a);
        const boolB = toBoolean(b);
        if (boolA !== null && boolB !== null) return boolA === boolB;
    }

    if (typeof a === 'object' || typeof b === 'object') {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }

    return String(a).trim() === String(b).trim();
}

export function parseList(value) {
    if (Array.isArray(value)) return value.map(unwrapValue);
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[') && text.endsWith(']')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed.map(unwrapValue);
        } catch {
            /* 不是 JSON，继续按分隔符拆 */
        }
    }
    return text
        .split(/[,，|]/)
        .map((part) => part.trim().replace(/^["']|["']$/g, ''))
        .filter((part) => part !== '');
}

function numericCompare(actual, expected, compare) {
    const a = toNumber(actual);
    const b = toNumber(expected);
    if (a === null || b === null) return false;
    return compare(a, b);
}

export function normalizeOp(op) {
    let key = String(op ?? '==').trim().toLowerCase();
    if (OP_ALIASES[key]) key = OP_ALIASES[key];
    if (key === '=') key = '==';
    return OPERATORS.includes(key) ? key : '==';
}

export function opLabel(op) {
    return OP_LABELS[normalizeOp(op)] || normalizeOp(op);
}

export function modeLabel(mode) {
    return MODE_LABELS[mode] || MODE_LABELS.sticky;
}

export function normalizeCondition(condition = {}) {
    let value = condition.value;
    if (value === null || value === undefined) value = '';
    else if (typeof value === 'object') {
        try {
            value = JSON.stringify(value);
        } catch {
            value = String(value);
        }
    } else {
        value = String(value);
    }
    return {
        path: String(condition.path ?? '').trim(),
        op: normalizeOp(condition.op),
        value,
    };
}

/* ================================================================== */
/* 条件判断                                                           */
/* ================================================================== */

/** 判断一个条件，返回结果和实际值（给 UI 测试用）。 */
export function evaluateCondition(condition, ctx = {}) {
    const normalized = normalizeCondition(condition);
    const path = normalized.path;
    const op = normalized.op;
    const expected = normalized.value;

    let raw;
    let fromPseudo = false;
    if (looksLikePseudoPath(path)) {
        raw = pseudoValue(path, ctx);
        fromPseudo = true;
    } else {
        raw = resolveRaw(ctx.stat_data ?? {}, path);
    }
    const actual = unwrapValue(raw);

    let pass = false;
    let error = null;

    try {
        switch (op) {
            case 'exists':
                pass = raw !== undefined && raw !== null;
                break;
            case 'not_exists':
                pass = raw === undefined || raw === null;
                break;
            case '>':
                pass = numericCompare(actual, expected, (a, b) => a > b);
                break;
            case '>=':
                pass = numericCompare(actual, expected, (a, b) => a >= b);
                break;
            case '<':
                pass = numericCompare(actual, expected, (a, b) => a < b);
                break;
            case '<=':
                pass = numericCompare(actual, expected, (a, b) => a <= b);
                break;
            case '!=':
                pass = !looseEqual(actual, expected);
                break;
            case 'contains':
                if (Array.isArray(actual)) {
                    pass = actual.some((item) => looseEqual(unwrapValue(item), expected));
                } else if (isPlainObject(actual)) {
                    pass = hasOwn(actual, String(expected));
                } else {
                    pass = String(actual ?? '').includes(String(expected));
                }
                break;
            case 'not_contains':
                if (Array.isArray(actual)) {
                    pass = !actual.some((item) => looseEqual(unwrapValue(item), expected));
                } else if (isPlainObject(actual)) {
                    pass = !hasOwn(actual, String(expected));
                } else {
                    pass = !String(actual ?? '').includes(String(expected));
                }
                break;
            case 'starts_with':
                pass = actual !== null && actual !== undefined && String(actual).startsWith(String(expected));
                break;
            case 'ends_with':
                pass = actual !== null && actual !== undefined && String(actual).endsWith(String(expected));
                break;
            case 'in':
                pass = parseList(expected).some((item) => looseEqual(actual, item));
                break;
            case 'not_in':
                pass = !parseList(expected).some((item) => looseEqual(actual, item));
                break;
            case 'matches':
                pass = new RegExp(String(expected)).test(String(actual ?? ''));
                break;
            case 'not_matches':
                pass = !new RegExp(String(expected)).test(String(actual ?? ''));
                break;
            case '==':
            default:
                pass = looseEqual(actual, expected);
                break;
        }
    } catch (err) {
        error = String(err && err.message ? err.message : err);
        pass = false;
    }

    return {
        path,
        op,
        expected,
        actual,
        raw,
        pass,
        error,
        missing: raw === undefined,
        fromPseudo,
    };
}

/* ================================================================== */
/* 高级表达式                                                         */
/* ================================================================== */

const expressionCache = new Map();

function compileExpression(expression) {
    if (expressionCache.has(expression)) return expressionCache.get(expression);

    let fn = null;
    let error = null;
    try {
        fn = new Function(
            'stat_data',
            'get',
            'value',
            'floor',
            'msgCount',
            'lastMessage',
            'lastUserMessage',
            'chatName',
            'chat',
            `"use strict"; return (${expression});`,
        );
    } catch (err) {
        error = String(err && err.message ? err.message : err);
    }

    const compiled = { fn, error };
    if (expressionCache.size >= 100) expressionCache.clear();
    expressionCache.set(expression, compiled);
    return compiled;
}

/** 评估一条规则的触发条件（条件行 + 可选高级表达式）。 */
export function evaluateRule(rule, ctx = {}) {
    const conditions = Array.isArray(rule && rule.conditions) ? rule.conditions : [];
    const rows = conditions.map((condition) => evaluateCondition(condition, ctx));
    const rowsOk = conditions.length === 0
        ? true
        : (rule.match === 'any' ? rows.some((row) => row.pass) : rows.every((row) => row.pass));

    const expression = String((rule && rule.expr) || '').trim();
    let expressionOk = true;
    let expressionError = null;
    let expressionValue = null;

    if (expression) {
        const compiled = compileExpression(expression);
        if (compiled.error) {
            expressionOk = false;
            expressionError = compiled.error;
        } else {
            try {
                const statData = ctx.stat_data ?? {};
                const get = (path) => resolvePath(statData, path);
                expressionValue = compiled.fn(
                    statData,
                    get,
                    get,
                    Number(ctx.floor ?? 0),
                    Number(ctx.messageCount ?? ctx.floor ?? 0),
                    String(ctx.lastMessage ?? ''),
                    String(ctx.lastUserMessage ?? ''),
                    String(ctx.chatName ?? ''),
                    Array.isArray(ctx.chat) ? ctx.chat : [],
                );
                expressionOk = Boolean(expressionValue);
            } catch (err) {
                expressionOk = false;
                expressionError = String(err && err.message ? err.message : err);
            }
        }
    }

    return {
        met: rowsOk && expressionOk,
        rowsOk,
        rows,
        expressionOk,
        expressionError,
        expressionValue,
    };
}

/* ================================================================== */
/* 规则与状态                                                         */
/* ================================================================== */

export function createRule(input = {}) {
    const conditions = (Array.isArray(input.conditions) ? input.conditions : [])
        .map(normalizeCondition)
        .filter((condition) => condition.path !== '');

    const title = String(input.title ?? '').trim() || '未命名解锁项';
    const mode = MODES.includes(input.mode) ? input.mode : 'sticky';
    const order = Number(input.order);
    const turns = Number(input.turns);

    return {
        id: String(input.id || newRuleId()),
        title,
        enabled: input.enabled !== false,
        order: Number.isFinite(order) ? order : 0,
        conditions,
        match: input.match === 'any' ? 'any' : 'all',
        expr: String(input.expr ?? '').trim(),
        content: String(input.content ?? ''),
        mode,
        turns: Number.isFinite(turns) ? Math.max(1, Math.min(1000, Math.floor(turns))) : 3,
        note: String(input.note ?? ''),
    };
}

export function normalizeRules(rules) {
    return (Array.isArray(rules) ? rules : []).map(createRule);
}

export function emptyState() {
    return { version: ENGINE_VERSION, rules: {} };
}

function emptyEntry() {
    return {
        unlocked: false,
        manualLocked: false,
        manual: false,
        unlockedAt: null,
        unlockedAtFloor: null,
        onceAtFloor: null,
        injectedCount: 0,
        lastInjectedFloor: null,
    };
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export function normalizeState(state) {
    const next = emptyState();
    if (!state || typeof state !== 'object') return next;
    const source = isPlainObject(state.rules) ? state.rules : {};

    for (const [id, entry] of Object.entries(source)) {
        if (!entry || typeof entry !== 'object') continue;
        const out = emptyEntry();
        out.unlocked = Boolean(entry.unlocked);
        out.manualLocked = Boolean(entry.manualLocked);
        out.manual = Boolean(entry.manual);
        out.unlockedAt = numberOrNull(entry.unlockedAt);
        out.unlockedAtFloor = numberOrNull(entry.unlockedAtFloor);
        out.onceAtFloor = numberOrNull(entry.onceAtFloor);
        out.injectedCount = Math.max(0, Math.floor(numberOrNull(entry.injectedCount) ?? 0));
        out.lastInjectedFloor = numberOrNull(entry.lastInjectedFloor);
        next.rules[id] = out;
    }

    return next;
}

export function manualUnlock(state, ruleId, floor = 0, now = Date.now()) {
    const next = normalizeState(state);
    next.rules[ruleId] = {
        ...emptyEntry(),
        unlocked: true,
        manual: true,
        unlockedAt: now,
        unlockedAtFloor: Number(floor) || 0,
    };
    return next;
}

export function manualLock(state, ruleId) {
    const next = normalizeState(state);
    next.rules[ruleId] = {
        ...emptyEntry(),
        unlocked: false,
        manualLocked: true,
    };
    return next;
}

/**
 * 只把「条件已经满足、尚未解锁」的规则标成解锁，不做注入。
 * 用于聊天加载 / 收到新消息后即时更新面板；真正的注入仍在生成前计算。
 */
export function applyAutoUnlocks(rules, state, ctx = {}, now = Date.now()) {
    const next = normalizeState(state);
    const unlocked = [];

    for (const rule of rules || []) {
        if (!rule || rule.enabled === false) continue;
        const entry = next.rules[rule.id];
        if (entry && (entry.unlocked || entry.manualLocked)) continue;
        if (!evaluateRule(rule, ctx).met) continue;

        next.rules[rule.id] = {
            ...emptyEntry(),
            unlocked: true,
            manual: false,
            unlockedAt: now,
            unlockedAtFloor: Number(ctx.floor) || 0,
        };
        unlocked.push(rule.id);
    }

    return { state: next, changed: unlocked.length > 0, unlocked };
}

/** 给 UI 用的单条规则状态说明。 */
export function describeRule(rule, state, ctx = {}) {
    const evaluation = evaluateRule(rule, ctx);
    const entry = state && state.rules ? state.rules[rule.id] : undefined;
    const floor = Number(ctx.floor) || 0;
    const content = String(rule.content ?? '').trim();
    const mode = MODES.includes(rule.mode) ? rule.mode : 'sticky';

    let status = 'locked';
    let active = false;
    let reason = '';

    if (rule.enabled === false) {
        status = 'disabled';
        reason = '已停用';
    } else if (entry && entry.manualLocked) {
        status = 'locked';
        reason = '已手动锁定；条件满足也不会自动解锁';
    } else if (!entry || !entry.unlocked) {
        status = evaluation.met ? 'ready' : 'locked';
        reason = evaluation.met ? '条件已满足，下次生成时解锁' : '条件未满足';
    } else if (!content) {
        status = 'empty';
        reason = '已解锁，但注入内容为空';
    } else if (mode === 'sticky') {
        status = 'active';
        active = true;
        reason = '已解锁，每楼持续注入';
    } else if (mode === 'once') {
        if (entry.onceAtFloor === null || entry.onceAtFloor === undefined) {
            status = 'waiting';
            active = true;
            reason = '已解锁，下次生成注入（只注入一次）';
        } else if (floor <= entry.onceAtFloor) {
            status = 'active';
            active = true;
            reason = '已解锁，本次生成注入（同楼重生成仍生效）';
        } else {
            status = 'spent';
            reason = '已注入过，不再注入';
        }
    } else if (mode === 'window') {
        const anchor = Number.isFinite(entry.unlockedAtFloor) ? entry.unlockedAtFloor : floor;
        const elapsed = Math.max(0, floor - anchor);
        const turns = Math.max(1, Number(rule.turns) || 3);
        if (elapsed < turns) {
            status = 'active';
            active = true;
            reason = `已解锁，窗口第 ${elapsed + 1}/${turns} 楼`;
        } else {
            status = 'expired';
            reason = '解锁窗口已结束';
        }
    } else if (mode === 'while') {
        if (evaluation.met) {
            status = 'active';
            active = true;
            reason = '条件满足，持续注入';
        } else {
            status = 'paused';
            reason = '条件当前不满足，暂停注入';
        }
    }

    return {
        ...evaluation,
        status,
        active,
        reason,
        unlocked: Boolean(entry && entry.unlocked),
        manualLocked: Boolean(entry && entry.manualLocked),
        entry,
    };
}

/**
 * 计算本次生成要注入的文本。
 * @returns {{state:object,text:string,parts:Array,details:Array}}
 */
export function planInjection(rules, state, ctx = {}, options = {}) {
    const next = normalizeState(state);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const floor = Number(ctx.floor) || 0;

    const sorted = (Array.isArray(rules) ? rules : [])
        .filter((rule) => rule && rule.enabled !== false)
        .slice()
        .sort((a, b) => {
            const orderA = Number(a.order) || 0;
            const orderB = Number(b.order) || 0;
            if (orderA !== orderB) return orderA - orderB;
            return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans');
        });

    const parts = [];
    const details = [];

    for (const rule of sorted) {
        const evaluation = evaluateRule(rule, ctx);
        const content = String(rule.content ?? '').trim();
        const mode = MODES.includes(rule.mode) ? rule.mode : 'sticky';

        let entry = next.rules[rule.id];
        let unlockedNow = false;

        if ((!entry || (!entry.unlocked && !entry.manualLocked)) && evaluation.met) {
            entry = next.rules[rule.id] = {
                ...emptyEntry(),
                unlocked: true,
                manual: false,
                unlockedAt: now,
                unlockedAtFloor: floor,
            };
            unlockedNow = true;
        }

        let active = false;
        let reason = '';

        if (!entry || !entry.unlocked) {
            if (entry && entry.manualLocked) {
                reason = '已手动锁定';
            } else if (evaluation.met) {
                reason = '条件已满足，但状态未解锁';
            } else {
                reason = '条件未满足';
            }
        } else if (entry.manualLocked) {
            reason = '已手动锁定';
        } else if (!content) {
            reason = '注入内容为空';
        } else if (mode === 'sticky') {
            active = true;
            reason = '持续注入';
        } else if (mode === 'once') {
            if (entry.onceAtFloor === null || entry.onceAtFloor === undefined) {
                active = true;
                reason = '只注入一次：本次生成';
            } else if (floor <= entry.onceAtFloor) {
                active = true;
                reason = '只注入一次：同楼重生成';
            } else {
                reason = '已注入过';
            }
        } else if (mode === 'window') {
            const anchor = Number.isFinite(entry.unlockedAtFloor) ? entry.unlockedAtFloor : floor;
            const elapsed = Math.max(0, floor - anchor);
            const turns = Math.max(1, Number(rule.turns) || 3);
            if (elapsed < turns) {
                active = true;
                reason = `窗口第 ${elapsed + 1}/${turns} 楼`;
            } else {
                reason = '窗口已结束';
            }
        } else if (mode === 'while') {
            if (evaluation.met) {
                active = true;
                reason = '条件满足';
            } else {
                reason = '条件不满足，暂停';
            }
        }

        if (active) {
            entry.lastInjectedFloor = floor;
            entry.injectedCount = (Number(entry.injectedCount) || 0) + 1;
            if (mode === 'once' && (entry.onceAtFloor === null || entry.onceAtFloor === undefined)) {
                entry.onceAtFloor = floor;
            }
            parts.push({
                id: rule.id,
                title: rule.title,
                content,
                mode,
            });
        }

        details.push({
            id: rule.id,
            title: rule.title,
            mode,
            met: evaluation.met,
            unlocked: Boolean(entry && entry.unlocked),
            unlockedNow,
            active,
            reason,
            evaluation,
        });
    }

    const body = parts
        .map((part) => {
            const title = String(part.title || '').trim();
            return title ? `〔${title}〕\n${part.content}` : part.content;
        })
        .join('\n\n');

    let text = '';
    if (body) {
        if (options.wrapper === false) {
            text = body;
        } else {
            const header = String(
                options.header
                ?? '以下设定已随剧情解锁，从现在起视为既定事实；不要在回复中复述本说明。',
            ).trim();
            text = `<story_unlock>\n${header ? `${header}\n` : ''}${body}\n</story_unlock>`;
        }
    }

    return { state: next, text, parts, details };
}

/* ================================================================== */
/* 聊天数据读取辅助                                                   */
/* ================================================================== */

/**
 * 从最后一条带 MVU 变量的 AI 消息里取 stat_data。
 * 只读，不依赖酒馆助手 API，作为最稳的兜底。
 */
export function findStatDataInChat(chat) {
    if (!Array.isArray(chat)) return null;

    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (!message || message.is_user) continue;

        const variables = message.variables;
        let candidates = [];

        if (Array.isArray(variables)) {
            const swipeId = Number.isInteger(Number(message.swipe_id)) ? Number(message.swipe_id) : 0;
            if (variables[swipeId]) candidates.push(variables[swipeId]);
            for (const item of variables) {
                if (item && !candidates.includes(item)) candidates.push(item);
            }
        } else if (isPlainObject(variables)) {
            candidates = [variables];
        }

        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object') continue;
            if (!isPlainObject(candidate.stat_data)) continue;
            return {
                stat_data: candidate.stat_data,
                source: 'message',
                messageIndex: index,
                swipeId: Number.isInteger(Number(message.swipe_id)) ? Number(message.swipe_id) : 0,
            };
        }
    }

    return null;
}

/** 把 stat_data 摊平成 UI 可列的路径列表。 */
export function flattenVariables(statData, options = {}) {
    const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 400;
    const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : 8;
    const out = [];

    const push = (value, raw, tokens) => {
        out.push({
            path: joinPath(tokens),
            value,
            raw,
            description: isValueWithDescription(raw) ? raw[1] : '',
            type: Array.isArray(value) ? 'array' : isPlainObject(value) ? 'object' : typeof value,
        });
    };

    const walk = (value, tokens, depth) => {
        if (out.length >= maxEntries) return;

        if (isValueWithDescription(value)) {
            push(unwrapValue(value), value, tokens);
            return;
        }

        if (isPlainObject(value)) {
            const keys = Object.keys(value);
            if (!keys.length || depth >= maxDepth) {
                push(value, value, tokens);
                return;
            }
            for (const key of keys) walk(value[key], tokens.concat(key), depth + 1);
            return;
        }

        if (Array.isArray(value)) {
            const nested = value.some((item) => isPlainObject(item) || isValueWithDescription(item));
            if (!value.length || depth >= maxDepth || !nested) {
                push(value, value, tokens);
                return;
            }
            for (let index = 0; index < value.length; index += 1) {
                walk(value[index], tokens.concat(index), depth + 1);
            }
            return;
        }

        push(value, value, tokens);
    };

    walk(statData, [], 0);
    return out;
}

export function formatValue(value, maxLength = 120) {
    let text;
    if (value === undefined) text = '—';
    else if (value === null) text = 'null';
    else if (typeof value === 'string') text = value;
    else if (typeof value === 'object') {
        try {
            text = JSON.stringify(value);
        } catch {
            text = '[无法序列化]';
        }
    } else {
        text = String(value);
    }

    if (text.length > maxLength) return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
    return text;
}

export function conditionSummary(rule) {
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    const pieces = conditions.map((condition) => {
        const op = normalizeOp(condition.op);
        if (op === 'exists' || op === 'not_exists') {
            return `${condition.path} ${opLabel(op)}`;
        }
        return `${condition.path} ${opLabel(op)} ${condition.value}`;
    });

    let head;
    if (!conditions.length) head = '无条件';
    else head = rule.match === 'any' ? '任意满足' : '全部满足';

    const expr = String(rule.expr || '').trim() ? ' + 高级表达式' : '';
    return `${head}：${pieces.join('；') || '—'}${expr}`;
}
