'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseChatSkill } = require('../../core/skills');

test('chat: a name=value line becomes a query, quoted values survive', () => {
  const p = parseChatSkill('/run-merge action=accept keys=A-1,A-2');
  assert.strictEqual(p.route, '/run-merge');
  assert.deepStrictEqual(p.query, { action: 'accept', keys: 'A-1,A-2' });
  assert.deepStrictEqual(parseChatSkill('/run-find q="hello world"').query, { q: 'hello world' });
});

test('chat: a bare route parses with no params rather than guessing', () => {
  assert.deepStrictEqual(parseChatSkill('/queue'), { route: '/queue', query: {}, rest: '' });
});

test('chat: a positional value is NOT bound to a param -- unconstrained pass-through is refused', () => {
  // '/run-find hello' must not silently become q=hello: which param it meant is a guess, and a
  // param only reaches argv after passing enum or pattern.
  assert.deepStrictEqual(parseChatSkill('/run-find hello').query, {});
});

test('chat: prose and non-slash text are not skills', () => {
  assert.strictEqual(parseChatSkill('what is the portfolio status'), null);
  assert.strictEqual(parseChatSkill(''), null);
  assert.strictEqual(parseChatSkill(null), null);
});

test('chat: a Claude Code command still parses as a route, so chatSkill can decline it', () => {
  // /draft is a .claude/commands entry, not a declared skill -- parse succeeds, lookup fails,
  // and the caller hands it to the model. The two namespaces must not collide silently.
  assert.strictEqual(parseChatSkill('/draft the thing').route, '/draft');
});
