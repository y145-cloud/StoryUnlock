/**
 * 剧情解锁 Story Unlock — SillyTavern / TauriTavern 前端扩展
 *
 * 设计要点：
 *   - 规则按角色卡保存（extension_settings），解锁状态按聊天保存（chat_metadata）。
 *     因此同一张卡开多个聊天时，条件内容不会互相串。
 *   - 不写世界书，不依赖世界书条目。
 *   - 生成前（GENERATION_AFTER_COMMANDS）根据 MVU 变量计算，只注入已解锁的内容。
 */

import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

import {
    OPERATORS,
    applyAutoUnlocks,
    conditionSummary,
    createRule,
    describeRule,
    emptyState,
    evaluateRule,
    findStatDataInChat,
    flattenVariables,
    formatValue,
    manualLock,
    manualUnlock,
    modeLabel,
    newRuleId,
    normalizeRules,
    normalizeState,
    opLabel,
    planInjection,
    resolvePath,
} from './engine.js';

const $ = globalThis.jQuery || globalThis.$;

const MODULE = 'story_unlock';
const PROMPT_KEY = 'story_unlock_injection';
const SETTINGS_HTML_URL = 'scripts/extensions/third-party/StoryUnlock/settings.html';
const DEFAULT_HEADER = '以下设定已随剧情解锁，从现在起视为既定事实；不要在回复中复述本说明。';

const POSITION_MAP = {
    in_chat: extension_prompt_types.IN_CHAT,
    in_prompt: extension_prompt_types.IN_PROMPT,
    before_prompt: extension_prompt_types.BEFORE_PROMPT,
};

const ROLE_MAP = {
    system: extension_prompt_roles.SYSTEM,
    user: extension_prompt_roles.USER,
    assistant: extension_prompt_roles.ASSISTANT,
};

const STATUS_LABELS = {
    active: '注入中',
    ready: '条件已满足（待生成）',
    waiting: '已解锁（待注入）',
    locked: '未解锁',
    spent: '已注入过',
    expired: '窗口已结束',
    paused: '暂停注入',
    empty: '内容为空',
    disabled: '已停用',
};

let panelReady = false;
let refreshToken = 0;
let currentRoleKey = '';
let currentRules = [];
let currentState = emptyState();
let currentCtx = null;
let currentStatData = {};
let currentMvu = { available: false, source: 'message', label: '未检测', error: null, stat_data: {}, found: false };
let varsRows = [];
let editingRuleId = null;
let editorConditions = [];
let lastPathField = null;

/* ================================================================== */
/* 设置与角色                                                         */
/* ================================================================== */

function ensureSettings() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object' || Array.isArray(extension_settings[MODULE])) {
        extension_settings[MODULE] = {};
    }
    const settings = extension_settings[MODULE];

    if (!settings.profiles || typeof settings.profiles !== 'object' || Array.isArray(settings.profiles)) {
        settings.profiles = {};
    }
    if (typeof settings.enabled !== 'boolean') settings.enabled = true;
    if (!Object.prototype.hasOwnProperty.call(POSITION_MAP, settings.position)) settings.position = 'in_chat';
    if (!Object.prototype.hasOwnProperty.call(ROLE_MAP, settings.role)) settings.role = 'system';
    if (typeof settings.wrapper !== 'boolean') settings.wrapper = true;
    if (typeof settings.header !== 'string') settings.header = DEFAULT_HEADER;

    const depth = Number(settings.depth);
    settings.depth = Number.isFinite(depth) ? Math.max(0, Math.min(10000, Math.floor(depth))) : 4;

    return settings;
}

function saveSettings() {
    try {
        saveSettingsDebounced();
    } catch (err) {
        console.warn('[StoryUnlock] 保存设置失败', err);
    }
}

function ensureProfile(roleKey) {
    const settings = ensureSettings();
    if (!settings.profiles[roleKey] || typeof settings.profiles[roleKey] !== 'object') {
        settings.profiles[roleKey] = { rules: [] };
    }
    const profile = settings.profiles[roleKey];
    if (!Array.isArray(profile.rules)) profile.rules = [];
    return profile;
}

function getRules(roleKey) {
    if (!roleKey) return [];
    const profile = ensureProfile(roleKey);
    const normalized = normalizeRules(profile.rules);
    const changed = normalized.length !== profile.rules.length
        || normalized.some((rule, index) => !profile.rules[index] || rule.id !== profile.rules[index].id);

    if (changed) {
        profile.rules = normalized;
        saveSettings();
    }
    return normalized;
}

function getContextSafe() {
    try {
        return getContext();
    } catch (err) {
        console.warn('[StoryUnlock] 读取酒馆上下文失败', err);
        return null;
    }
}

function getCharacter(ctx) {
    if (!ctx || !Array.isArray(ctx.characters)) return null;
    const index = Number(ctx.characterId);
    if (!Number.isInteger(index) || index < 0 || index >= ctx.characters.length) return null;
    return ctx.characters[index] || null;
}

function getGroup(ctx) {
    if (!ctx || !ctx.groupId || !Array.isArray(ctx.groups)) return null;
    return ctx.groups.find((group) => String(group.id) === String(ctx.groupId)) || null;
}

function getRoleKey(ctx) {
    if (!ctx) return '';

    if (ctx.groupId) return `group:${ctx.groupId}`;

    const character = getCharacter(ctx);
    if (character) {
        const avatar = String(character.avatar || '').trim();
        const name = String(character.name || '').trim();
        return `char:${avatar || name || ctx.characterId || 'unknown'}`;
    }

    const chatId = String(ctx.chatId || '').trim();
    if (chatId) return `chat:${chatId}`;
    return '';
}

function describeRole(ctx) {
    if (!ctx) return '';
    if (ctx.groupId) {
        const group = getGroup(ctx);
        return group ? String(group.name || '群聊') : `群聊 ${ctx.groupId}`;
    }
    const character = getCharacter(ctx);
    if (character) return String(character.name || '角色');
    return '';
}

/* ================================================================== */
/* 聊天状态                                                           */
/* ================================================================== */

function getChatState() {
    const ctx = getContextSafe();
    if (!ctx || !ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') return emptyState();
    return normalizeState(ctx.chatMetadata[MODULE]);
}

function saveChatState(state) {
    const ctx = getContextSafe();
    if (!ctx || !ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') return false;
    ctx.chatMetadata[MODULE] = state;
    try {
        saveMetadataDebounced();
    } catch (err) {
        try {
            if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
        } catch (inner) {
            console.warn('[StoryUnlock] 保存聊天状态失败', inner);
        }
    }
    return true;
}

/* ================================================================== */
/* 生成上下文                                                         */
/* ================================================================== */

function buildContext() {
    const ctx = getContextSafe() || {};
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const found = findStatDataInChat(chat);

    let lastMessage = '';
    let lastUserMessage = '';
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (!message || typeof message.mes !== 'string') continue;
        if (message.is_user) {
            if (!lastUserMessage) lastUserMessage = message.mes;
        } else if (!lastMessage) {
            lastMessage = message.mes;
        }
        if (lastMessage && lastUserMessage) break;
    }

    return {
        ctx,
        chat,
        floor: chat.length,
        messageCount: chat.length,
        stat_data: found && found.stat_data ? found.stat_data : {},
        mvuFound: Boolean(found),
        mvuMessageIndex: found ? found.messageIndex : null,
        lastMessage,
        lastUserMessage,
        chatName: describeRole(ctx),
    };
}

function isEmptyObject(value) {
    return !value || typeof value !== 'object' || Object.keys(value).length === 0;
}

/* ================================================================== */
/* MVU 读取                                                           */
/* ================================================================== */

function getMvuApi() {
    const candidates = [];

    try {
        if (globalThis.Mvu && typeof globalThis.Mvu.getMvuData === 'function') {
            candidates.push({ label: '当前页面 Mvu', api: globalThis.Mvu });
        }
    } catch {
        /* 忽略 */
    }

    try {
        const parent = globalThis.parent;
        if (parent && parent !== globalThis && parent.Mvu && typeof parent.Mvu.getMvuData === 'function') {
            candidates.push({ label: '父页面 Mvu', api: parent.Mvu });
        }
    } catch {
        /* 跨域时忽略 */
    }

    try {
        if (globalThis.TavernHelper && globalThis.TavernHelper.Mvu && typeof globalThis.TavernHelper.Mvu.getMvuData === 'function') {
            candidates.push({ label: 'TavernHelper.Mvu', api: globalThis.TavernHelper.Mvu });
        }
    } catch {
        /* 忽略 */
    }

    return candidates[0] || null;
}

function extractStatData(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.stat_data && typeof payload.stat_data === 'object' && !Array.isArray(payload.stat_data)) {
        return payload.stat_data;
    }
    if (payload.data && payload.data.stat_data && typeof payload.data.stat_data === 'object') {
        return payload.data.stat_data;
    }
    if (payload.variables && payload.variables.stat_data && typeof payload.variables.stat_data === 'object') {
        return payload.variables.stat_data;
    }
    return null;
}

async function resolveMvuData(ctxData) {
    const mvuApi = getMvuApi();
    if (!mvuApi) {
        return {
            available: false,
            source: 'message',
            label: '仅消息变量',
            error: null,
            stat_data: ctxData.stat_data,
            found: ctxData.mvuFound,
        };
    }

    let payload = null;
    let error = null;
    try {
        payload = await mvuApi.api.getMvuData({ type: 'message', message_id: 'latest' });
    } catch (err) {
        error = String(err && err.message ? err.message : err);
    }

    const statData = extractStatData(payload);
    if (statData && !isEmptyObject(statData)) {
        return {
            available: true,
            source: 'live',
            label: `已连接（${mvuApi.label}）`,
            error,
            stat_data: statData,
            found: true,
        };
    }

    return {
        available: true,
        source: 'message',
        label: error ? `读取失败，改用消息变量（${mvuApi.label}）` : `已检测（${mvuApi.label}）`,
        error,
        stat_data: ctxData.stat_data,
        found: ctxData.mvuFound,
    };
}

/* ================================================================== */
/* 注入                                                               */
/* ================================================================== */

function applyPrompt(text) {
    try {
        if (!text) {
            setExtensionPrompt(
                PROMPT_KEY,
                '',
                extension_prompt_types.IN_CHAT,
                0,
                false,
                extension_prompt_roles.SYSTEM,
            );
            return;
        }

        const settings = ensureSettings();
        const position = POSITION_MAP[settings.position] ?? extension_prompt_types.IN_CHAT;
        const role = ROLE_MAP[settings.role] ?? extension_prompt_roles.SYSTEM;
        const depth = Math.max(0, Math.min(10000, Number(settings.depth) || 0));

        setExtensionPrompt(PROMPT_KEY, text, position, depth, false, role);
    } catch (err) {
        console.error('[StoryUnlock] 注入提示词失败', err);
    }
}

function onGenerationAfterCommands(_eventType, _options, dryRun) {
    if (dryRun) return;

    try {
        const ctxData = buildContext();
        const roleKey = getRoleKey(ctxData.ctx);
        if (!roleKey) {
            applyPrompt('');
            return;
        }

        const settings = ensureSettings();
        const rules = getRules(roleKey);
        if (!settings.enabled || !rules.length) {
            applyPrompt('');
            return;
        }

        const state = getChatState();
        const plan = planInjection(rules, state, ctxData, {
            wrapper: settings.wrapper,
            header: settings.header,
        });

        const changed = plan.text !== '' || plan.details.some((detail) => detail.unlockedNow);
        if (changed && ctxData.ctx.chatMetadata) {
            ctxData.ctx.chatMetadata[MODULE] = plan.state;
            try {
                saveMetadataDebounced();
            } catch {
                /* 忽略 */
            }
        }

        applyPrompt(plan.text);

        currentRoleKey = roleKey;
        currentRules = rules;
        currentState = plan.state;

        const unlockedNow = plan.details.filter((detail) => detail.unlockedNow).map((detail) => detail.title);
        if (unlockedNow.length) {
            notify(`剧情解锁：${unlockedNow.join('、')}`, 'success');
        }

        if (panelReady && $('#story-unlock-settings').is(':visible')) {
            renderRules(ctxData);
        }
    } catch (err) {
        console.error('[StoryUnlock] 生成前计算失败', err);
    }
}

function onChatChanged() {
    currentRoleKey = '';
    currentRules = [];
    currentState = emptyState();
    currentStatData = {};
    varsRows = [];
    applyPrompt('');
    void refreshAll({ mvu: true });
}

function onMessageReceived() {
    globalThis.setTimeout(() => {
        try {
            const ctxData = buildContext();
            const roleKey = getRoleKey(ctxData.ctx);
            if (!roleKey) return;

            const rules = getRules(roleKey);
            const state = getChatState();
            const result = applyAutoUnlocks(rules, state, ctxData);
            if (result.changed) saveChatState(result.state);

            void refreshAll({ mvu: true });
        } catch (err) {
            console.warn('[StoryUnlock] 消息后刷新失败', err);
        }
    }, 160);
}

/* ================================================================== */
/* 面板渲染                                                           */
/* ================================================================== */

function renderStatus() {
    if (!panelReady) return;

    const settings = ensureSettings();
    const ctx = currentCtx ? currentCtx.ctx : (getContextSafe() || {});
    const roleName = describeRole(ctx);
    const chatFile = String(ctx.chatId || '').split(/[\\/]/).pop() || '';

    if (currentRoleKey) {
        const suffix = chatFile ? ` · ${chatFile}` : '';
        $('#su-chat-label').text(`当前：${roleName || '未知角色'}${suffix}`);
    } else {
        $('#su-chat-label').text('当前聊天：未打开角色');
    }

    const $mvu = $('#su-mvu-state').removeClass('is-ok is-warn');
    if (currentMvu.available) {
        $mvu.addClass('is-ok').text(`MVU：${currentMvu.label}`);
    } else if (currentMvu.found) {
        $mvu.addClass('is-ok').text('MVU：消息变量');
    } else {
        $mvu.addClass('is-warn').text('MVU：未找到变量');
    }

    $('#su-floor-label').text(`楼层：${currentCtx ? currentCtx.floor : 0}`);
    $('#su-rule-count').text(currentRules.length);
    $('#su-enabled').prop('checked', settings.enabled);
    $('#su-new').prop('disabled', !currentRoleKey);

    $('#su-position').val(settings.position);
    $('#su-depth').val(settings.depth);
    $('#su-role').val(settings.role);
    $('#su-wrapper').prop('checked', settings.wrapper);
    $('#su-header').val(settings.header);
}

function renderVars() {
    if (!panelReady) return;

    const filter = String($('#su-var-filter').val() || '').trim().toLowerCase();
    const rows = varsRows.filter((row) => {
        if (!filter) return true;
        return String(row.path || '').toLowerCase().includes(filter)
            || String(row.value ?? '').toLowerCase().includes(filter);
    });

    const $list = $('#su-vars-list').empty();

    if (!rows.length) {
        $list.append($('<div class="su-var-empty">').text(
            varsRows.length
                ? '没有匹配的变量。'
                : '当前聊天还没有读到 MVU 变量。先让角色卡跑一条带 MVU 变量的 AI 消息，或点「刷新变量」。',
        ));
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(0, 400)) {
        const $row = $('<div class="su-var-row">')
            .attr('data-path', row.path)
            .attr('title', `${row.path} = ${formatValue(row.value)}`)
            .attr('role', 'button')
            .attr('tabindex', '0');

        $row.append($('<span class="su-var-path">').text(row.path || '(根)'));
        $row.append($('<span class="su-var-value">').text(formatValue(row.value, 120)));
        fragment.appendChild($row[0]);
    }
    $list.append(fragment);

    const $datalist = $('#su-path-list').empty();
    for (const row of varsRows.slice(0, 400)) {
        if (!row.path) continue;
        $datalist.append($('<option>').attr('value', row.path));
    }
}

function statusLabel(status) {
    return STATUS_LABELS[status] || status || '未知';
}

function actionButton(action, label) {
    return $('<button type="button" class="menu_button">').attr('data-act', action).text(label);
}

function renderRules(ctxData = currentCtx) {
    if (!panelReady) return;

    const $wrap = $('#su-rules').empty();
    const $empty = $('#su-empty');
    $('#su-rule-count').text(currentRules.length);

    if (!currentRoleKey) {
        $empty.text('先打开一个角色聊天。规则会按角色卡保存，解锁状态按聊天保存。').show();
        return;
    }

    if (!currentRules.length) {
        $empty.text('还没有解锁项。点击「新建解锁项」，设置触发条件和要注入的内容。').show();
        return;
    }

    $empty.hide();

    const state = getChatState();
    const context = ctxData || buildContext();
    const fragment = document.createDocumentFragment();

    for (const rule of currentRules) {
        const description = describeRule(rule, state, context);
        const status = rule.enabled === false ? 'disabled' : description.status;

        const $card = $('<div class="su-rule">')
            .attr('data-id', rule.id)
            .attr('data-status', status);

        const $head = $('<div class="su-rule-head">');

        const $title = $('<div class="su-rule-title">')
            .append($('<span>').text(rule.title || '未命名解锁项'))
            .append($('<span class="su-tag">').text(modeLabel(rule.mode)));

        if (rule.enabled === false) {
            $title.append($('<span class="su-tag">').text('已停用'));
        }

        const $actions = $('<div class="su-rule-actions">')
            .append(actionButton('test', '测试'))
            .append(actionButton('toggle', rule.enabled ? '停用' : '启用'))
            .append(actionButton('unlock', '解锁'))
            .append(actionButton('lock', '锁定'))
            .append(actionButton('edit', '编辑'));

        $head.append($title, $actions);

        const $meta = $('<div class="su-rule-meta">').text(conditionSummary(rule));
        const $content = $('<div class="su-rule-content">').text(String(rule.content || '').trim() || '（注入内容为空）');
        const $status = $('<div class="su-rule-status">')
            .append($('<span class="su-dot">'))
            .append($('<span>').text(`${statusLabel(status)}${description.reason ? ` · ${description.reason}` : ''}`));

        if (description.entry && description.entry.injectedCount > 0) {
            $status.append($('<span class="su-tag">').text(`已注入 ${description.entry.injectedCount} 次`));
        }

        $card.append($head, $meta, $content, $status);
        fragment.appendChild($card[0]);
    }

    $wrap.append(fragment);
}

async function refreshAll(options = {}) {
    const token = ++refreshToken;
    const ctxData = buildContext();
    const roleKey = getRoleKey(ctxData.ctx);

    const rules = roleKey ? getRules(roleKey) : [];
    const state = getChatState();

    let mvu = {
        available: false,
        source: 'message',
        label: '仅消息变量',
        error: null,
        stat_data: ctxData.stat_data,
        found: ctxData.mvuFound,
    };

    if (options.mvu !== false) {
        mvu = await resolveMvuData(ctxData);
        if (token !== refreshToken) return;
    }

    let statData = mvu.stat_data;
    if (isEmptyObject(statData) && !isEmptyObject(ctxData.stat_data)) {
        statData = ctxData.stat_data;
    }

    currentRoleKey = roleKey;
    currentRules = rules;
    currentState = state;
    currentCtx = ctxData;
    currentStatData = statData || {};
    currentMvu = mvu;
    varsRows = flattenVariables(currentStatData);

    if (panelReady) {
        renderStatus();
        renderVars();
        renderRules(ctxData);
    }
}

/* ================================================================== */
/* 编辑器                                                             */
/* ================================================================== */

function setTab(name) {
    $('#su-editor .su-tab')
        .removeClass('is-active')
        .filter(`[data-tab="${name}"]`)
        .addClass('is-active');
    $('#su-editor .su-tab-panel')
        .removeClass('is-active')
        .filter(`[data-panel="${name}"]`)
        .addClass('is-active');
}

function updateValueDisabled($op, $value) {
    const op = String($op.val() || '');
    const disabled = op === 'exists' || op === 'not_exists';
    $value.prop('disabled', disabled);
    $value.attr('placeholder', disabled ? '此运算符不需要值' : '比较值');
}

function renderConditions() {
    const $wrap = $('#su-conditions').empty();

    if (!editorConditions.length) {
        $wrap.append($('<div class="su-condition-empty">').text(
            '没有条件。这条规则会在每次生成时解锁；建议至少添加一个条件。',
        ));
        return;
    }

    for (const condition of editorConditions) {
        const $row = $('<div class="su-condition">');

        const $path = $('<input type="text" class="su-cond-path" list="su-path-list" placeholder="变量路径，如 角色.络络.好感度">')
            .val(condition.path || '');

        const $op = $('<select class="su-cond-op">');
        for (const op of OPERATORS) {
            $op.append($('<option>').attr('value', op).text(opLabel(op)));
        }
        $op.val(condition.op || '>=');

        const $value = $('<input type="text" class="su-cond-value" placeholder="比较值">')
            .val(condition.value ?? '');

        const $remove = $('<button type="button" class="su-icon-button su-cond-remove" title="删除条件">✕</button>');

        updateValueDisabled($op, $value);
        $row.append($path, $op, $value, $remove);
        $wrap.append($row);
    }
}

function collectConditionRows() {
    return $('#su-conditions .su-condition').map((_index, element) => {
        const $row = $(element);
        return {
            path: String($row.find('.su-cond-path').val() || '').trim(),
            op: String($row.find('.su-cond-op').val() || '>='),
            value: String($row.find('.su-cond-value').val() ?? '').trim(),
        };
    }).get();
}

function readEditorFields() {
    return {
        title: String($('#su-title').val() || '').trim(),
        match: String($('#su-match').val() || 'all'),
        mode: String($('#su-mode').val() || 'sticky'),
        turns: Number($('#su-turns').val()) || 3,
        order: Number($('#su-order').val()) || 0,
        content: String($('#su-content').val() || ''),
        expr: String($('#su-expr').val() || '').trim(),
        note: String($('#su-note').val() || '').trim(),
        enabled: $('#su-rule-enabled').prop('checked') !== false,
    };
}

function buildDraftRule() {
    const fields = readEditorFields();
    const conditions = collectConditionRows().filter((condition) => condition.path);
    return createRule({
        ...fields,
        id: editingRuleId || 'draft',
        conditions,
    });
}

function updateSummary() {
    try {
        const draft = buildDraftRule();
        $('#su-condition-summary').text(conditionSummary(draft));
    } catch {
        $('#su-condition-summary').text('—');
    }
}

function readEditorRule() {
    const rows = collectConditionRows();

    rows.forEach((row, index) => {
        if (!row.path && row.value.trim()) {
            throw new Error(`第 ${index + 1} 条条件缺少变量路径`);
        }
    });

    const fields = readEditorFields();
    if (!fields.content.trim()) {
        throw new Error('请填写解锁后要注入的内容');
    }

    return createRule({
        ...fields,
        id: editingRuleId || undefined,
        conditions: rows.filter((row) => row.path),
    });
}

function openEditor(ruleId) {
    if (!currentRoleKey) {
        notify('请先打开一个角色聊天', 'warning');
        return;
    }

    const rule = ruleId ? currentRules.find((item) => item.id === ruleId) : null;
    editingRuleId = rule ? rule.id : null;
    editorConditions = rule
        ? rule.conditions.map((condition) => ({ ...condition }))
        : [{ path: '', op: '>=', value: '' }];

    $('#su-editor-title').text(rule ? '编辑解锁项' : '新建解锁项');
    $('#su-editor-delete').toggle(Boolean(rule));
    $('#su-title').val(rule && rule.title !== '未命名解锁项' ? rule.title : '');
    $('#su-match').val(rule ? rule.match : 'all');
    $('#su-mode').val(rule ? rule.mode : 'sticky');
    $('#su-turns').val(rule ? rule.turns : 3);
    $('#su-order').val(rule ? rule.order : 0);
    $('#su-content').val(rule ? rule.content : '');
    $('#su-expr').val(rule ? rule.expr : '');
    $('#su-note').val(rule ? rule.note : '');
    $('#su-rule-enabled').prop('checked', rule ? rule.enabled !== false : true);

    $('#su-test-result').hide().removeClass('is-pass is-fail').empty();
    renderConditions();
    updateSummary();
    setTab('basic');

    $('#su-editor').css('display', 'flex').appendTo(document.body);
    lastPathField = null;

    globalThis.setTimeout(() => {
        $('#su-title').trigger('focus');
    }, 60);
}

function closeEditor() {
    $('#su-editor').hide();
    editingRuleId = null;
    editorConditions = [];
    lastPathField = null;
}

function showTextModal(title, text, subtitle = '只读') {
    $('#su-text-title').text(title);
    $('#su-text-sub').text(subtitle);
    $('#su-text-body').val(text);
    $('#su-text-modal').css('display', 'flex').appendTo(document.body);
}

function hideTextModal() {
    $('#su-text-modal').hide();
}

function formatEvaluation(rule, evaluation) {
    const lines = [];

    if (evaluation.rows.length) {
        for (const row of evaluation.rows) {
            const noValue = row.op === 'exists' || row.op === 'not_exists';
            const expected = noValue ? '' : ` ${row.expected}`;
            const actual = formatValue(row.actual, 80);
            const missing = row.missing ? '（缺失）' : '';
            const error = row.error ? `（错误：${row.error}）` : '';
            lines.push(`${row.pass ? '✅' : '❌'} ${row.path} ${opLabel(row.op)}${expected} → ${actual}${missing}${error}`);
        }
    } else {
        lines.push('条件行：无');
    }

    if (String(rule.expr || '').trim()) {
        lines.push(`表达式：${evaluation.expressionOk ? '✅ 为真' : '❌ 为假'}${evaluation.expressionError ? `（${evaluation.expressionError}）` : ''}`);
    }

    lines.push('');
    lines.push(evaluation.met ? '整体：条件满足' : '整体：条件不满足');
    return lines.join('\n');
}

function testEditorRule() {
    let draft;
    try {
        draft = buildDraftRule();
    } catch (err) {
        notify(String(err && err.message ? err.message : err), 'error');
        return;
    }

    const evaluation = evaluateRule(draft, buildContext());
    const text = formatEvaluation(draft, evaluation);

    $('#su-test-result')
        .show()
        .removeClass('is-pass is-fail')
        .addClass(evaluation.met ? 'is-pass' : 'is-fail')
        .text(text);

    const element = $('#su-test-result')[0];
    if (element && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'nearest' });
    }
}

function saveEditorRule() {
    let rule;
    try {
        rule = readEditorRule();
    } catch (err) {
        notify(String(err && err.message ? err.message : err), 'error');
        setTab('basic');
        return;
    }

    const profile = ensureProfile(currentRoleKey);
    const rules = normalizeRules(profile.rules);
    const index = editingRuleId ? rules.findIndex((item) => item.id === editingRuleId) : -1;

    if (index >= 0) rules[index] = rule;
    else rules.push(rule);

    profile.rules = rules;
    saveSettings();
    closeEditor();
    notify('已保存解锁项', 'success');
    void refreshAll({ mvu: false });
}

function deleteEditorRule() {
    if (!editingRuleId) return;
    if (!globalThis.confirm('确定删除这条解锁项？同聊天的解锁记录会保留，但不再注入。')) return;

    const profile = ensureProfile(currentRoleKey);
    profile.rules = normalizeRules(profile.rules).filter((rule) => rule.id !== editingRuleId);
    saveSettings();
    closeEditor();
    notify('已删除解锁项', 'info');
    void refreshAll({ mvu: false });
}

/* ================================================================== */
/* 规则操作                                                           */
/* ================================================================== */

function onRuleAction(action, ruleId) {
    const rule = currentRules.find((item) => item.id === ruleId);
    if (!rule) return;

    if (action === 'edit') {
        openEditor(rule.id);
        return;
    }

    if (action === 'test') {
        const evaluation = evaluateRule(rule, buildContext());
        showTextModal(
            `条件测试：${rule.title}`,
            formatEvaluation(rule, evaluation),
            evaluation.met ? '条件满足' : '条件不满足',
        );
        return;
    }

    if (action === 'toggle') {
        const profile = ensureProfile(currentRoleKey);
        const rules = normalizeRules(profile.rules);
        const target = rules.find((item) => item.id === ruleId);
        if (!target) return;
        target.enabled = target.enabled === false;
        profile.rules = rules;
        saveSettings();
        applyPrompt('');
        notify(target.enabled ? '已启用' : '已停用', 'info');
        void refreshAll({ mvu: false });
        return;
    }

    if (action === 'unlock') {
        const floor = buildContext().floor;
        saveChatState(manualUnlock(getChatState(), ruleId, floor));
        applyPrompt('');
        notify(`已解锁：${rule.title}`, 'success');
        void refreshAll({ mvu: false });
        return;
    }

    if (action === 'lock') {
        saveChatState(manualLock(getChatState(), ruleId));
        applyPrompt('');
        notify(`已锁定：${rule.title}`, 'info');
        void refreshAll({ mvu: false });
    }
}

/* ================================================================== */
/* 导入导出 / 预览                                                    */
/* ================================================================== */

function sanitizeFileName(name) {
    return String(name || 'StoryUnlock').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'StoryUnlock';
}

async function copyText(text) {
    const value = String(text ?? '');
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
            notify('已复制到剪贴板', 'success');
            return;
        }
    } catch {
        /* 继续用兜底方案 */
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        notify('已复制到剪贴板', 'success');
    } catch {
        notify('复制失败，请手动选择文本', 'warning');
    }
}

function exportRules() {
    if (!currentRoleKey) {
        notify('请先打开一个角色聊天', 'warning');
        return;
    }

    const payload = {
        format: 'story-unlock',
        version: 1,
        roleKey: currentRoleKey,
        roleName: describeRole(currentCtx ? currentCtx.ctx : getContextSafe()),
        exportedAt: new Date().toISOString(),
        rules: getRules(currentRoleKey),
    };
    const text = JSON.stringify(payload, null, 2);

    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `StoryUnlock-${sanitizeFileName(payload.roleName)}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 2000);
        notify('已导出规则', 'success');
    } catch (err) {
        console.warn('[StoryUnlock] 导出失败，改为复制 JSON', err);
        void copyText(text);
    }
}

async function importRules(file) {
    if (!currentRoleKey) {
        notify('请先打开一个角色聊天', 'warning');
        return;
    }

    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const list = Array.isArray(payload) ? payload : (Array.isArray(payload.rules) ? payload.rules : null);
        if (!list) throw new Error('JSON 里没有 rules 数组');

        const imported = normalizeRules(list);
        if (!imported.length) throw new Error('没有可导入的规则');

        if (!globalThis.confirm(`追加导入 ${imported.length} 条规则到当前角色卡？不会覆盖已有规则。`)) return;

        const profile = ensureProfile(currentRoleKey);
        const existing = normalizeRules(profile.rules);
        const ids = new Set(existing.map((rule) => rule.id));

        for (const rule of imported) {
            if (ids.has(rule.id)) rule.id = newRuleId();
            ids.add(rule.id);
        }

        profile.rules = [...existing, ...imported];
        saveSettings();
        notify(`已导入 ${imported.length} 条规则`, 'success');
        void refreshAll({ mvu: false });
    } catch (err) {
        notify(`导入失败：${err && err.message ? err.message : err}`, 'error');
    }
}

function previewInjection() {
    if (!currentRoleKey) {
        notify('请先打开一个角色聊天', 'warning');
        return;
    }

    const ctxData = buildContext();
    const settings = ensureSettings();
    const plan = planInjection(currentRules, getChatState(), ctxData, {
        wrapper: settings.wrapper,
        header: settings.header,
    });

    const lines = [];
    lines.push(plan.text || '（当前不会注入任何内容）');
    lines.push('');
    lines.push('—— 判定 ——');
    if (!plan.details.length) {
        lines.push('（没有启用的解锁项）');
    } else {
        for (const detail of plan.details) {
            lines.push(`${detail.active ? '✅' : '⬜'} ${detail.title}：${detail.reason}`);
        }
    }

    showTextModal('下一次生成会注入的内容', lines.join('\n'), `当前楼层 ${ctxData.floor}`);
}

function resetChatState() {
    if (!currentRoleKey) {
        notify('请先打开一个角色聊天', 'warning');
        return;
    }
    if (!globalThis.confirm('只重置当前聊天的解锁状态，不会删除规则。确定继续？')) return;

    saveChatState(emptyState());
    currentState = emptyState();
    applyPrompt('');
    notify('已重置当前聊天的解锁状态', 'info');
    void refreshAll({ mvu: false });
}

/* ================================================================== */
/* 斜杠命令                                                           */
/* ================================================================== */

function pickRule(arg) {
    const rules = getRules(getRoleKey(getContextSafe() || {}));
    if (!rules.length) return null;

    const index = Number(arg);
    if (Number.isInteger(index) && index >= 1 && index <= rules.length) {
        return rules[index - 1];
    }

    return rules.find((rule) => rule.id === arg)
        || rules.find((rule) => rule.title === arg)
        || rules.find((rule) => rule.title.includes(arg))
        || null;
}

function slashStatus() {
    const ctxData = buildContext();
    const roleKey = getRoleKey(ctxData.ctx);
    if (!roleKey) return '当前没有打开角色聊天。';

    const rules = getRules(roleKey);
    const state = getChatState();
    const lines = [`角色：${describeRole(ctxData.ctx) || roleKey}`, `楼层：${ctxData.floor}`, `规则：${rules.length} 条`];

    for (const rule of rules) {
        const description = describeRule(rule, state, ctxData);
        lines.push(`- ${rule.title}：${statusLabel(rule.enabled === false ? 'disabled' : description.status)}${description.reason ? `（${description.reason}）` : ''}`);
    }

    return lines.join('\n');
}

function slashTest() {
    const ctxData = buildContext();
    const rules = getRules(getRoleKey(ctxData.ctx));
    if (!rules.length) return '当前角色没有解锁项。';

    return rules.map((rule) => {
        const evaluation = evaluateRule(rule, ctxData);
        return `${evaluation.met ? '✅' : '❌'} ${rule.title}${rule.enabled === false ? '（已停用）' : ''}`;
    }).join('\n');
}

async function loadSlashClasses() {
    if (globalThis.SlashCommandParser && globalThis.SlashCommand) {
        return { parser: globalThis.SlashCommandParser, SlashCommand: globalThis.SlashCommand };
    }
    try {
        const [parserModule, commandModule] = await Promise.all([
            import('../../../slash-commands/SlashCommandParser.js'),
            import('../../../slash-commands/SlashCommand.js'),
        ]);
        return {
            parser: globalThis.SlashCommandParser || parserModule.SlashCommandParser,
            SlashCommand: globalThis.SlashCommand || commandModule.SlashCommand,
        };
    } catch (err) {
        console.warn('[StoryUnlock] 无法加载斜杠命令模块，/su 将不可用', err);
        return null;
    }
}

async function registerSlashCommands() {
    try {
        const classes = await loadSlashClasses();
        if (!classes || !classes.parser || !classes.SlashCommand) return;
        const { parser, SlashCommand } = classes;
        if (globalThis.__storyUnlockSlashRegistered) return;
        globalThis.__storyUnlockSlashRegistered = true;

        const callback = (namedArgs, unnamedArgs) => {
            const words = String(unnamedArgs ?? '').trim().split(/\s+/).filter(Boolean);
            const command = (words.shift() || 'status').toLowerCase();
            const arg = words.join(' ');

            if (command === 'status') return slashStatus();
            if (command === 'test') return slashTest();
            if (command === 'list') {
                const rules = getRules(getRoleKey(getContextSafe() || {}));
                return rules.length
                    ? rules.map((rule, index) => `${index + 1}. ${rule.title} [${rule.mode}]`).join('\n')
                    : '当前角色没有解锁项。';
            }
            if (command === 'preview') {
                const ctxData = buildContext();
                const settings = ensureSettings();
                const plan = planInjection(getRules(getRoleKey(ctxData.ctx)), getChatState(), ctxData, {
                    wrapper: settings.wrapper,
                    header: settings.header,
                });
                return plan.text || '（当前不会注入任何内容）';
            }
            if (command === 'var') {
                const ctxData = buildContext();
                if (!ctxData.stat_data || !Object.keys(ctxData.stat_data).length) return '没有读到 MVU stat_data。';
                if (arg) return `${arg} = ${formatValue(resolvePath(ctxData.stat_data, arg))}`;
                return flattenVariables(ctxData.stat_data, { maxEntries: 50 })
                    .map((row) => `${row.path} = ${formatValue(row.value, 60)}`)
                    .join('\n');
            }
            if (command === 'unlock' || command === 'lock') {
                if (!arg) return `用法：/su ${command} <序号|名称|id>`;
                const rule = pickRule(arg);
                if (!rule) return `找不到解锁项：${arg}`;
                const floor = buildContext().floor;
                saveChatState(command === 'unlock'
                    ? manualUnlock(getChatState(), rule.id, floor)
                    : manualLock(getChatState(), rule.id));
                applyPrompt('');
                void refreshAll({ mvu: false });
                return `已${command === 'unlock' ? '解锁' : '锁定'}：${rule.title}`;
            }
            if (command === 'reset') {
                if (arg !== 'yes') return '这会重置当前聊天的解锁状态。确定时输入：/su reset yes';
                saveChatState(emptyState());
                currentState = emptyState();
                applyPrompt('');
                void refreshAll({ mvu: false });
                return '已重置当前聊天的解锁状态。';
            }
            return [
                '剧情解锁命令：',
                '/su status — 查看当前状态',
                '/su list — 列出解锁项',
                '/su test — 测试所有条件',
                '/su preview — 预览下一次注入',
                '/su var [路径] — 查看 MVU 变量',
                '/su unlock <序号|名称> — 手动解锁',
                '/su lock <序号|名称> — 手动锁定',
                '/su reset yes — 重置当前聊天解锁状态',
            ].join('\n');
        };

        const props = {
            name: 'su',
            helpString: '剧情解锁：查看/测试/手动解锁条件注入项。',
            callback,
        };
        parser.addCommandObject(SlashCommand.fromProps(props));
        parser.addCommandObject(SlashCommand.fromProps({ ...props, name: 'storyunlock' }));
    } catch (err) {
        console.warn('[StoryUnlock] 注册斜杠命令失败', err);
    }
}

/* ================================================================== */
/* 面板事件                                                           */
/* ================================================================== */

function bindPanelEvents() {
    $('#su-enabled').on('change', function () {
        const settings = ensureSettings();
        settings.enabled = Boolean(this.checked);
        saveSettings();
        if (!settings.enabled) applyPrompt('');
        renderRules();
    });

    $('#su-new').on('click', () => openEditor(null));
    $('#su-refresh').on('click', () => { void refreshAll({ mvu: true }); });
    $('#su-preview').on('click', previewInjection);
    $('#su-export').on('click', exportRules);
    $('#su-reset-chat').on('click', resetChatState);
    $('#su-import').on('click', () => $('#su-import-file').trigger('click'));
    $('#su-import-file').on('change', async function () {
        const file = this.files && this.files[0];
        if (file) await importRules(file);
        this.value = '';
    });

    $('#su-var-filter').on('input', renderVars);
    $('#su-copy-vars').on('click', () => copyText(JSON.stringify(currentStatData, null, 2)));
    $('#su-vars-list').on('click', '.su-var-row', function () {
        onVariableClicked(String($(this).attr('data-path') || ''));
    });
    $('#su-vars-list').on('keydown', '.su-var-row', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onVariableClicked(String($(this).attr('data-path') || ''));
        }
    });

    $('#su-position, #su-role').on('change', saveInjectionSettings);
    $('#su-depth').on('change', saveInjectionSettings);
    $('#su-wrapper').on('change', saveInjectionSettings);
    $('#su-header').on('change', saveInjectionSettings);

    $(document).on('click', '#su-editor .su-tab', function () {
        setTab(String($(this).attr('data-tab') || 'basic'));
    });

    $(document).on('click', '#su-editor-close, #su-editor-cancel, #su-editor [data-su-close]', closeEditor);
    $(document).on('click', '#su-editor-save', saveEditorRule);
    $(document).on('click', '#su-editor-delete', deleteEditorRule);
    $(document).on('click', '#su-editor-test', testEditorRule);
    $(document).on('click', '#su-add-condition', addCondition);
    $(document).on('click', '#su-conditions .su-cond-remove', removeCondition);
    $(document).on('change', '#su-conditions .su-cond-op', function () {
        const $row = $(this).closest('.su-condition');
        updateValueDisabled($(this), $row.find('.su-cond-value'));
        updateSummary();
    });
    $(document).on('input change', '#su-conditions input, #su-conditions select, #su-match, #su-expr', updateSummary);
    $(document).on('focusin', '#su-editor .su-cond-path', function () {
        lastPathField = this;
    });

    $(document).on('click', '#su-text-close, #su-text-ok, #su-text-modal [data-su-text-close]', hideTextModal);
    $(document).on('click', '#su-text-copy', () => copyText($('#su-text-body').val()));

    $(document).on('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if ($('#su-text-modal').is(':visible')) {
            hideTextModal();
            return;
        }
        if ($('#su-editor').is(':visible')) closeEditor();
    });

    $('#su-rules').on('click', '[data-act]', function () {
        const action = String($(this).attr('data-act') || '');
        const ruleId = String($(this).closest('.su-rule').attr('data-id') || '');
        onRuleAction(action, ruleId);
    });
}

function saveInjectionSettings() {
    const settings = ensureSettings();
    settings.position = String($('#su-position').val() || 'in_chat');
    settings.role = String($('#su-role').val() || 'system');
    settings.depth = Math.max(0, Math.min(10000, Number($('#su-depth').val()) || 0));
    settings.wrapper = $('#su-wrapper').prop('checked') !== false;
    settings.header = String($('#su-header').val() || '').trim();
    saveSettings();
    applyPrompt('');
}

function addCondition() {
    editorConditions = collectConditionRows();
    editorConditions.push({ path: '', op: '>=', value: '' });
    renderConditions();
    updateSummary();
    const $paths = $('#su-conditions .su-cond-path');
    $paths.last().trigger('focus');
}

function removeCondition() {
    const rows = collectConditionRows();
    const $row = $(this).closest('.su-condition');
    const index = $('#su-conditions .su-condition').index($row);
    if (index >= 0) rows.splice(index, 1);
    editorConditions = rows;
    renderConditions();
    updateSummary();
}

function onVariableClicked(path) {
    if (!path) return;

    const editorOpen = $('#su-editor').is(':visible');

    if (editorOpen && !$('#su-conditions .su-condition').length) {
        editorConditions = collectConditionRows();
        editorConditions.push({ path, op: '>=', value: '' });
        renderConditions();
        lastPathField = $('#su-conditions .su-cond-path').last()[0];
        updateSummary();
        return;
    }

    if (editorOpen) {
        if (!lastPathField || !document.body.contains(lastPathField)) {
            lastPathField = $('#su-conditions .su-cond-path')[0] || null;
        }
        if (lastPathField) {
            $(lastPathField).val(path).trigger('input').trigger('change');
            $(lastPathField).trigger('focus');
            updateSummary();
            return;
        }
    }

    void copyText(path);
}

/* ================================================================== */
/* 面板加载                                                           */
/* ================================================================== */

function moveInteractiveElements() {
    $('#su-editor, #su-text-modal, #su-path-list, #su-import-file').appendTo(document.body);
}

async function loadSettingsHtml() {
    if ($('#story-unlock-settings').length) {
        moveInteractiveElements();
        return true;
    }

    const $host = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!$host.length) return false;

    let html = '';
    try {
        html = await renderExtensionTemplateAsync('third-party/StoryUnlock', 'settings');
    } catch (err) {
        console.warn('[StoryUnlock] 模板渲染失败，改用原文加载', err);
    }

    if (!html || !html.includes('story-unlock-settings') || !html.includes('su-editor')) {
        try {
            const response = await fetch(new URL('settings.html', import.meta.url));
            if (response.ok) html = await response.text();
        } catch (err) {
            console.warn('[StoryUnlock] 相对路径加载 settings.html 失败', err);
        }
    }

    if (!html) {
        try {
            const response = await fetch(SETTINGS_HTML_URL);
            if (response.ok) html = await response.text();
        } catch (err) {
            console.warn('[StoryUnlock] 加载 settings.html 失败', err);
        }
    }

    if (!html) return false;

    $host.append(html);
    if (!$('#story-unlock-settings').length) return false;

    moveInteractiveElements();
    return true;
}

async function initPanel() {
    const loaded = await loadSettingsHtml();
    if (!loaded) {
        console.warn('[StoryUnlock] 没有找到扩展设置容器，面板未加载');
        return;
    }

    panelReady = true;
    bindPanelEvents();
    applyPrompt('');
    await refreshAll({ mvu: true });
}

/* ================================================================== */
/* 启动                                                               */
/* ================================================================== */

function bindGlobalEvents() {
    try {
        const eventName = (name) => (event_types && event_types[name]) || name;
        eventSource.on(eventName('CHAT_CHANGED'), onChatChanged);
        eventSource.on(eventName('MESSAGE_RECEIVED'), onMessageReceived);
        eventSource.on(eventName('GENERATION_AFTER_COMMANDS'), onGenerationAfterCommands);
    } catch (err) {
        console.warn('[StoryUnlock] 绑定事件失败', err);
    }
}

function notify(message, type = 'info') {
    const text = String(message ?? '');
    try {
        if (globalThis.toastr) {
            const fn = typeof globalThis.toastr[type] === 'function' ? globalThis.toastr[type] : globalThis.toastr.info;
            fn(text, '剧情解锁');
            return;
        }
    } catch {
        /* 忽略 */
    }
    console.log('[StoryUnlock]', text);
}

bindGlobalEvents();
void registerSlashCommands();

if ($) {
    $(async () => {
        await initPanel();
    });
} else {
    console.warn('[StoryUnlock] jQuery 不可用，设置面板未加载');
}
