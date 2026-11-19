import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ENGINE_VERSION,
    applyAutoUnlocks,
    conditionSummary,
    createRule,
    describeRule,
    emptyState,
    evaluateCondition,
    evaluateRule,
    findStatDataInChat,
    flattenVariables,
    joinPath,
    looseEqual,
    manualLock,
    manualUnlock,
    normalizeState,
    planInjection,
    resolvePath,
    resolveRaw,
    tokenizePath,
} from '../engine.js';

const ctx = (stat_data, overrides = {}) => ({
    stat_data,
    floor: 1,
    messageCount: 1,
    lastMessage: '',
    lastUserMessage: '',
    chatName: '测试聊天',
    chat: [],
    ...overrides,
});

const rule = (overrides = {}) => createRule({
    id: 'memory',
    title: '恢复记忆',
    content: '你其实记得失忆前的事。',
    conditions: [{ path: '事件.真相', op: '==', value: 'true' }],
    ...overrides,
});

test('路径解析支持点号、方括号和引号', () => {
    assert.deepEqual(tokenizePath('stat_data.角色.络络.好感度'), ['角色', '络络', '好感度']);
    assert.deepEqual(tokenizePath('角色["络络"].好感度'), ['角色', '络络', '好感度']);
    assert.deepEqual(tokenizePath("列表[0].'名字'"), ['列表', '0', '名字']);
    assert.deepEqual(tokenizePath(''), []);
    assert.equal(joinPath(['列表', '0', '名字']), '列表[0].名字');
    assert.equal(joinPath(['角色', '络络']), '角色.络络');
});

test('读取 MVU 值会自动解开 [值, 说明] 包装', () => {
    const stat = {
        角色: { 络络: { 好感度: [60, '剧情事件后更新'] } },
        事件: { 真相: [true, '失忆真相已揭开'] },
    };
    assert.equal(resolvePath(stat, '角色.络络.好感度'), 60);
    assert.equal(resolvePath(stat, 'stat_data.事件.真相'), true);
    assert.equal(resolvePath(stat, '角色["络络"].好感度'), 60);
    assert.equal(resolvePath(stat, '角色.不存在'), undefined);
    assert.deepEqual(resolveRaw(stat, '角色.络络.好感度'), [60, '剧情事件后更新']);
});

test('运算符：数字、字符串、数组、布尔和存在性', () => {
    const stat = {
        n: [60, ''],
        s: '失忆的旅人',
        tags: ['失忆', '旅人'],
        flag: [true, ''],
        空值: ['', ''],
    };
    const pass = (path, op, value) => evaluateCondition({ path, op, value }, ctx(stat)).pass;

    assert.equal(pass('n', '>=', '60'), true);
    assert.equal(pass('n', '>', '60'), false);
    assert.equal(pass('n', '<=', '60'), true);
    assert.equal(pass('n', '<', '60'), false);
    assert.equal(pass('n', '==', '60'), true);
    assert.equal(pass('n', '!=', '61'), true);
    assert.equal(pass('n', '>', 'abc'), false);

    assert.equal(pass('s', 'contains', '旅人'), true);
    assert.equal(pass('s', 'not_contains', '骑士'), true);
    assert.equal(pass('s', 'starts_with', '失忆'), true);
    assert.equal(pass('s', 'ends_with', '旅人'), true);
    assert.equal(pass('s', 'in', '失忆的旅人,骑士'), true);
    assert.equal(pass('s', 'not_in', '骑士,法师'), true);

    assert.equal(pass('tags', 'contains', '失忆'), true);
    assert.equal(pass('tags', 'not_contains', '骑士'), true);
    assert.equal(pass('flag', '==', 'true'), true);
    assert.equal(pass('flag', '==', true), true);

    assert.equal(pass('不存在', 'exists', ''), false);
    assert.equal(pass('不存在', 'not_exists', ''), true);
    assert.equal(pass('n', 'exists', ''), true);

    assert.equal(pass('$floor', '>=', '5'), false);
    assert.equal(evaluateCondition({ path: '$floor', op: '>=', value: '5' }, ctx(stat, { floor: 5 })).pass, true);
});

test('split 列表和宽松比较', () => {
    assert.deepEqual(evaluateCondition({ path: 'x', op: 'in', value: 'a,b，c' }, ctx({ x: 'b' })).pass, true);
    assert.equal(looseEqual('60', 60), true);
    assert.equal(looseEqual('真', true), true);
    assert.equal(looseEqual('', null), false);
});

test('规则 all / any 和高级表达式', () => {
    const base = rule({
        conditions: [
            { path: 'a', op: '>=', value: '10' },
            { path: 'b', op: '==', value: 'yes' },
        ],
        match: 'all',
        content: '内容',
    });

    const stat = { a: [10, ''], b: ['no', ''] };
    assert.equal(evaluateRule(base, ctx(stat)).met, false);
    assert.equal(evaluateRule({ ...base, match: 'any' }, ctx(stat)).met, true);

    const exprRule = {
        ...base,
        conditions: [],
        match: 'all',
        expr: "get('a') >= 10 && get('b') === 'no'",
    };
    const result = evaluateRule(exprRule, ctx(stat));
    assert.equal(result.met, true);
    assert.equal(result.expressionOk, true);

    const broken = evaluateRule({ ...base, expr: '(((' }, ctx(stat));
    assert.equal(broken.met, false);
    assert.ok(broken.expressionError);

    const throwing = evaluateRule({ ...base, expr: "missingFn()" }, ctx(stat));
    assert.equal(throwing.met, false);
    assert.ok(throwing.expressionError);
});

test('sticky：解锁后每楼都注入，且不修改入参', () => {
    const r = rule();
    const before = emptyState();
    const first = planInjection([r], before, ctx({ 事件: { 真相: [false, ''] } }, { floor: 3 }));

    assert.equal(first.text, '');
    assert.equal(first.state.rules.memory, undefined);
    assert.deepEqual(before, { version: ENGINE_VERSION, rules: {} });

    const unlocked = planInjection([r], before, ctx({ 事件: { 真相: [true, ''] } }, { floor: 4 }));
    assert.match(unlocked.text, /<story_unlock>/);
    assert.match(unlocked.text, /恢复记忆/);
    assert.match(unlocked.text, /你其实记得失忆前的事/);
    assert.equal(unlocked.state.rules.memory.unlocked, true);

    const nextFloor = planInjection([r], unlocked.state, ctx({ 事件: { 真相: [true, ''] } }, { floor: 5 }));
    assert.match(nextFloor.text, /恢复记忆/);
    assert.equal(nextFloor.state.rules.memory.injectedCount, 2);
});

test('once：只注入一次，同楼重新生成仍注入', () => {
    const r = rule({ mode: 'once', conditions: [] });
    const first = planInjection([r], emptyState(), ctx({}, { floor: 7 }));
    assert.match(first.text, /恢复记忆/);
    assert.equal(first.state.rules.memory.onceAtFloor, 7);

    const regenerate = planInjection([r], first.state, ctx({}, { floor: 7 }));
    assert.match(regenerate.text, /恢复记忆/);

    const later = planInjection([r], regenerate.state, ctx({}, { floor: 8 }));
    assert.equal(later.text, '');
    assert.match(describeRule(r, later.state, ctx({}, { floor: 8 })).reason, /已注入/);
});

test('window：解锁后只覆盖 N 楼', () => {
    const r = rule({ mode: 'window', turns: 2, conditions: [] });

    const floor3 = planInjection([r], emptyState(), ctx({}, { floor: 3 }));
    assert.match(floor3.text, /恢复记忆/);

    const floor4 = planInjection([r], floor3.state, ctx({}, { floor: 4 }));
    assert.match(floor4.text, /恢复记忆/);

    const floor5 = planInjection([r], floor4.state, ctx({}, { floor: 5 }));
    assert.equal(floor5.text, '');
    assert.match(describeRule(r, floor5.state, ctx({}, { floor: 5 })).reason, /窗口/);
});

test('while：只在条件满足时注入，状态保持解锁', () => {
    const r = rule({ mode: 'while' });
    const yes = planInjection([r], emptyState(), ctx({ 事件: { 真相: [true, ''] } }, { floor: 2 }));
    assert.match(yes.text, /恢复记忆/);

    const no = planInjection([r], yes.state, ctx({ 事件: { 真相: [false, ''] } }, { floor: 3 }));
    assert.equal(no.text, '');
    assert.equal(no.state.rules.memory.unlocked, true);
});

test('手动锁定优先于自动解锁，手动解锁可恢复', () => {
    const r = rule();
    const locked = manualLock(emptyState(), 'memory');
    const blocked = planInjection([r], locked, ctx({ 事件: { 真相: [true, ''] } }, { floor: 2 }));
    assert.equal(blocked.text, '');
    assert.equal(blocked.state.rules.memory.manualLocked, true);

    const unlocked = manualUnlock(locked, 'memory', 2);
    const injected = planInjection([r], unlocked, ctx({ 事件: { 真相: [true, ''] } }, { floor: 3 }));
    assert.match(injected.text, /恢复记忆/);
});

test('从聊天记录中寻找最近一条带 MVU 变量的 AI 消息', () => {
    const chat = [
        { is_user: true, mes: '你好', variables: [{ stat_data: { x: 1 } }] },
        {
            is_user: false,
            swipe_id: 1,
            variables: [
                { stat_data: { x: 2 } },
                { stat_data: { x: 3 } },
            ],
        },
        { is_user: false, mes: '没有变量' },
        {
            is_user: false,
            swipe_id: 0,
            variables: [{ stat_data: {} }],
        },
    ];

    const found = findStatDataInChat(chat);
    assert.deepEqual(found.stat_data, {});
    assert.equal(found.messageIndex, 3);

    const chat2 = [
        { is_user: false, swipe_id: 1, variables: [{ stat_data: { x: 2 } }, { stat_data: { x: 3 } }] },
    ];
    assert.deepEqual(findStatDataInChat(chat2).stat_data, { x: 3 });
    assert.equal(findStatDataInChat([]), null);
});

test('摊平变量并保留 MVU 说明', () => {
    const flat = flattenVariables({
        角色: { 络络: { 好感度: [60, '剧情事件后更新'] } },
        事件: { 真相: [true, '失忆真相已揭开'] },
        标签: ['失忆', '旅人', '向导'],
    });

    const favor = flat.find((row) => row.path === '角色.络络.好感度');
    assert.ok(favor);
    assert.equal(favor.value, 60);
    assert.equal(favor.description, '剧情事件后更新');

    const truth = flat.find((row) => row.path === '事件.真相');
    assert.equal(truth.value, true);

    const tags = flat.find((row) => row.path === '标签');
    assert.deepEqual(tags.value, ['失忆', '旅人', '向导']);
});

test('排序、拼接和关闭包装', () => {
    const rules = [
        rule({ id: 'b', title: 'B', order: 20, content: 'BBB', conditions: [] }),
        rule({ id: 'a', title: 'A', order: 10, content: 'AAA', conditions: [] }),
    ];
    const result = planInjection(rules, emptyState(), ctx({}, { floor: 1 }));
    assert.ok(result.text.indexOf('AAA') < result.text.indexOf('BBB'));
    assert.match(result.text, /〔A〕/);

    const plain = planInjection(rules, emptyState(), ctx({}, { floor: 1 }), { wrapper: false });
    assert.equal(plain.text, '〔A〕\nAAA\n\n〔B〕\nBBB');
});

test('自动解锁只标记已满足条件的规则', () => {
    const rules = [
        rule({ id: 'one', conditions: [{ path: 'a', op: '==', value: '1' }] }),
        rule({ id: 'two', conditions: [{ path: 'b', op: '==', value: '1' }] }),
    ];
    const result = applyAutoUnlocks(rules, emptyState(), ctx({ a: [1, ''] }, { floor: 6 }));
    assert.equal(result.changed, true);
    assert.deepEqual(result.unlocked, ['one']);
    assert.equal(result.state.rules.one.unlocked, true);
    assert.equal(result.state.rules.one.unlockedAtFloor, 6);
    assert.equal(result.state.rules.two, undefined);
});

test('条件摘要可读', () => {
    const r = rule({
        match: 'any',
        conditions: [
            { path: '事件.真相', op: '==', value: 'true' },
            { path: '好感度', op: '>=', value: '60' },
        ],
    });
    const summary = conditionSummary(r);
    assert.match(summary, /任意满足/);
    assert.match(summary, /事件\.真相/);
    assert.match(summary, /≥/);
});

test('状态归一化容忍脏数据', () => {
    const state = normalizeState({
        rules: {
            a: { unlocked: true, injectedCount: '3', unlockedAtFloor: 2 },
            b: null,
            c: { unlocked: false, manualLocked: true },
        },
    });
    assert.equal(state.rules.a.injectedCount, 3);
    assert.equal(state.rules.a.unlockedAtFloor, 2);
    assert.equal(state.rules.b, undefined);
    assert.equal(state.rules.c.manualLocked, true);
    assert.equal(normalizeState(null).version, ENGINE_VERSION);
});
