import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import SimpleEnglish from './index.mjs';
import { latestReply, markdownTargets, replyAdvice, runHook } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(ROOT, 'src/hooks/lint_hook.py');
const SLOP = 'You should simply leverage the robust tool, making it seamless.\n';

function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'simple-english-opencode-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function reply(id, text, extra = {}) {
  return {
    info: { id, role: 'assistant', time: { completed: 1 }, finish: 'stop', ...extra },
    parts: [{ type: 'text', text }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(t, options = {}, messages) {
  const logs = [];
  const calls = [];
  const history = new Map();
  const directory = temporary(t);
  const hooks = await SimpleEnglish({ directory, client: {
    app: { log: async ({ body }) => { logs.push(body); } },
    session: { messages: async (input) => {
      calls.push(input.path.id);
      return messages ? messages(input) : { data: history.get(input.path.id) || [] };
    } },
  } }, options);
  const idle = (sessionID) => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
  const system = async (sessionID, original = []) => {
    const output = { system: [...original] };
    await hooks['experimental.chat.system.transform']({ sessionID }, output);
    return output.system;
  };
  return { hooks, directory, logs, calls, history, idle, system };
}

test('loads checkout rules outside the checkout and preserves existing instructions', async (t) => {
  const h = await harness(t);
  const system = await h.system('one', ['Original instructions.']);
  assert.equal(system[0], 'Original instructions.');
  assert.match(system[1], /THE REPLY/);
  assert.ok(system[1].includes(path.join(ROOT, 'skills/simple-english/SKILL.md')));
  assert.ok(!system[1].includes('Word-budget'));
  assert.deepEqual(await h.system('one', system), system);
  // Every new request, including a resumed or compacted session, gets rules.
  assert.match((await h.system('one'))[0], /SKILL ACTIVE AUTOMATICALLY/);
  assert.match((await h.system())[0], /SKILL ACTIVE AUTOMATICALLY/);
});

test('replyStyle false omits only chat reply rules', async (t) => {
  const h = await harness(t, { replyStyle: false });
  const [context] = await h.system('one');
  assert.doesNotMatch(context, /THE REPLY/);
  assert.match(context, /THE DOCUMENT/);
  assert.ok(context.includes(path.join(ROOT, 'skills/simple-english/SKILL.md')));
});

test('registers the skill directory without replacing paths or URLs', async (t) => {
  const { hooks } = await harness(t);
  const config = { skills: { paths: ['/other/skills'], urls: ['https://example.com/skills/'] } };
  await hooks.config(config);
  await hooks.config(config);
  assert.deepEqual(config.skills.paths, ['/other/skills', path.join(ROOT, 'skills')]);
  assert.equal(config.skills.urls[0], 'https://example.com/skills/');
  const empty = {};
  await hooks.config(empty);
  assert.deepEqual(empty.skills.paths, [path.join(ROOT, 'skills')]);
});

test('extracts surviving Markdown patch targets and deduplicates destinations', () => {
  const output = { metadata: { files: [
    { type: 'add', filePath: 'new.md' },
    { type: 'update', filePath: 'new.md' },
    { type: 'move', filePath: 'old.md', movePath: 'renamed.md' },
    { type: 'delete', filePath: 'deleted.md' },
    { type: 'add', filePath: 'code.js' },
  ] } };
  assert.deepEqual(markdownTargets({ tool: 'apply_patch' }, output, '/project'), ['/project/new.md', '/project/renamed.md']);
  assert.deepEqual(markdownTargets({ tool: 'apply_patch' }, {}, '/project'), []);
  assert.deepEqual(markdownTargets({ tool: 'bash' }, output, '/project'), []);
});

test('write and edit append real Python findings while preserving the tool result', async (t) => {
  const { hooks, directory } = await harness(t);
  writeFileSync(path.join(directory, 'notes.md'), SLOP);
  for (const tool of ['write', 'edit']) {
    const output = { output: 'Success.', title: 'notes.md', metadata: { existing: true } };
    await hooks['tool.execute.after']({ tool, args: { filePath: 'notes.md' } }, output);
    assert.match(output.output, /^Success\.\n\nsimple-english: notes.md/);
    assert.match(output.output, /line 1, banned_modal: should/);
    assert.equal(output.title, 'notes.md');
    assert.deepEqual(output.metadata, { existing: true });
  }
});

test('checks each surviving file of a patch, including a renamed file', async (t) => {
  const { hooks, directory } = await harness(t);
  writeFileSync(path.join(directory, 'new.md'), SLOP);
  writeFileSync(path.join(directory, 'renamed.md'), SLOP);
  const output = { output: 'Patched.', metadata: { files: [
    { type: 'add', filePath: 'new.md' },
    { type: 'update', filePath: 'new.md' },
    { type: 'move', filePath: 'old.md', movePath: 'renamed.md' },
    { type: 'delete', filePath: 'deleted.md' },
  ] } };
  await hooks['tool.execute.after']({ tool: 'apply_patch' }, output);
  assert.equal((output.output.match(/STE violations/g) || []).length, 2);
  assert.match(output.output, /renamed\.md has/);
  assert.ok(!output.output.includes('deleted.md'));
});

test('clean, missing, non-Markdown, and internal files leave the result unchanged', async (t) => {
  const { hooks, directory } = await harness(t);
  writeFileSync(path.join(directory, 'clean.md'), 'Run the migration. Then restart the service.\n');
  writeFileSync(path.join(directory, 'code.js'), SLOP);
  mkdirSync(path.join(directory, '.opencode'));
  writeFileSync(path.join(directory, '.opencode', 'notes.md'), SLOP);
  symlinkSync(path.join(directory, '.opencode', 'notes.md'), path.join(directory, 'linked.md'));
  for (const filePath of ['clean.md', 'missing.md', 'code.js', '.opencode/notes.md', 'linked.md']) {
    const output = { output: 'Success.' };
    await hooks['tool.execute.after']({ tool: 'write', args: { filePath } }, output);
    assert.equal(output.output, 'Success.', filePath);
  }
});

test('disabled checks and missing Python preserve successful tools', async (t) => {
  for (const options of [{ fileChecks: false }, { pythonCommand: '/nonexistent/python' }]) {
    const { hooks, directory } = await harness(t, options);
    writeFileSync(path.join(directory, 'notes.md'), SLOP);
    const output = { output: 'Success.' };
    await hooks['tool.execute.after']({ tool: 'edit', args: { filePath: 'notes.md' } }, output);
    assert.equal(output.output, 'Success.');
  }
});

test('Python processes time out and oversized output is discarded', async (t) => {
  const directory = temporary(t);
  const script = path.join(directory, 'fake-hook.cjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  assert.equal(await runHook(process.execPath, script, {}, directory, { timeout: 100 }), null);
  writeFileSync(script, 'process.stdout.write("x".repeat(10000));');
  assert.equal(await runHook(process.execPath, script, {}, directory, { maxBuffer: 100 }), null);
  writeFileSync(script, 'process.exit(1);');
  assert.equal(await runHook(process.execPath, script, {}, directory), null);
  assert.equal(await runHook('/nonexistent/python', SCRIPT, {}, directory), null);
});

test('malformed reply-check results produce no advice', () => {
  for (const result of [null, { code: 0, stdout: '' }, { code: 0, stdout: 'invalid' },
    { code: 0, stdout: '{"systemMessage": 5}' }, { code: 2, stdout: '{"systemMessage": "bad"}' }]) {
    assert.equal(replyAdvice(result), '');
  }
});

test('aggregates reply text but skips summaries, synthetic text, and failed responses', () => {
  const message = reply('one', 'The build failed.');
  message.parts.push({ type: 'reasoning', text: 'Private.' }, { type: 'text', synthetic: true, text: 'Synthetic.' },
    { type: 'text', text: 'Free disk space.' });
  assert.deepEqual(latestReply([message, reply('summary', 'Summary.', { summary: true })]),
    { id: 'one', text: 'The build failed.\n\nFree disk space.' });
  for (const extra of [{ time: {} }, { error: { name: 'Error' } }, { finish: 'tool-calls' }, { role: 'user' }]) {
    assert.equal(latestReply([message, reply('two', 'Skipped.', extra)]), null);
  }
  assert.equal(latestReply(undefined), null);
});

test('reply advice is logged once, scoped by session, and consumed once', async (t) => {
  const h = await harness(t);
  h.history.set('one', [reply('one-message', '**A robust tool.**')]);
  await h.idle('one');
  await h.idle('one');
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0].message, /bold span/);
  assert.equal((await h.system('two')).length, 1);
  assert.match((await h.system('one'))[1], /reply check/);
  assert.equal((await h.system('one')).length, 1);
  assert.deepEqual(h.calls, ['one', 'one']);
});

test('a newer clean reply clears queued advice', async (t) => {
  const h = await harness(t);
  h.history.set('one', [reply('bad', '**A robust tool.**')]);
  await h.idle('one');
  h.history.set('one', [reply('clean', 'The build passed.')]);
  await h.idle('one');
  assert.equal((await h.system('one')).length, 1);
});

test('system transformation joins the in-flight idle check', async (t) => {
  const pending = deferred();
  const h = await harness(t, {}, () => pending.promise);
  const idle = h.idle('one');
  const system = h.system('one');
  pending.resolve({ data: [reply('bad', '**A robust tool.**')] });
  await idle;
  assert.match((await system)[1], /reply check/);
});

test('concurrent duplicate idle events produce one advisory', async (t) => {
  const h = await harness(t);
  h.history.set('one', [reply('bad', '**A robust tool.**')]);
  await Promise.all([h.idle('one'), h.idle('one')]);
  assert.equal(h.logs.length, 1);
  assert.equal((await h.system('one')).length, 2);
  assert.equal((await h.system('one')).length, 1);
});

test('system transformation follows a newer check started while it waits', async (t) => {
  const old = deferred();
  const newer = deferred();
  let calls = 0;
  const h = await harness(t, {}, () => ++calls === 1 ? old.promise : newer.promise);
  const first = h.idle('one');
  const system = h.system('one');
  const second = h.idle('one');
  old.resolve({ data: [reply('clean', 'The build passed.')] });
  await first;
  newer.resolve({ data: [reply('bad', '**A robust tool.**')] });
  await second;
  assert.match((await system)[1], /reply check/);
});

test('late idle results cannot overwrite feedback from a newer check', async (t) => {
  const old = deferred();
  let calls = 0;
  const h = await harness(t, {}, () => ++calls === 1 ? old.promise : { data: [reply('clean', 'The build passed.')] });
  const first = h.idle('one');
  await h.idle('one');
  old.resolve({ data: [reply('bad', '**A robust tool.**')] });
  await first;
  assert.equal((await h.system('one')).length, 1);
  assert.equal(h.logs.length, 0);
});

test('deletion invalidates a running check and disposal ignores future events', async (t) => {
  const pending = deferred();
  const h = await harness(t, {}, () => pending.promise);
  const idle = h.idle('one');
  await h.hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'one' } } } });
  pending.resolve({ data: [reply('bad', '**A robust tool.**')] });
  await idle;
  assert.equal(h.logs.length, 0);
  assert.equal((await h.system('one')).length, 1);
  await h.hooks.dispose();
  await h.idle('two');
  assert.deepEqual(h.calls, ['one']);
});

test('reply checks can be disabled and SDK or Python failures never reject hooks', async (t) => {
  const disabled = await harness(t, { replyChecks: false });
  await disabled.idle('one');
  assert.equal(disabled.calls.length, 0);
  const failed = await harness(t, {}, () => { throw new Error('SDK unavailable'); });
  await failed.idle('one');
  assert.equal((await failed.system('one')).length, 1);
  const missing = await harness(t, { pythonCommand: '/nonexistent/python' });
  missing.history.set('one', [reply('bad', '**A robust tool.**')]);
  await missing.idle('one');
  assert.equal((await missing.system('one')).length, 1);
});

test('logging errors do not lose reply advice', async (t) => {
  const hooks = await SimpleEnglish({ directory: temporary(t), client: {
    session: { messages: async () => ({ data: [reply('bad', '**A robust tool.**')] }) },
    app: { log: async () => { throw new Error('Log unavailable'); } },
  } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'one' } } });
  const output = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'one' }, output);
  assert.match(output.system[1], /reply check/);
});
