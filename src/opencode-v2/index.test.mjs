import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import plugin from './index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SLOP = 'You should simply leverage the robust tool, making it seamless.\n';

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'simple-english-v2-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = { sessions: [], skills: [], tools: [], logs: [] };
  let onContext;
  let onTool;
  let cleanup;
  const queue = [];
  let wake;
  const ctx = {
    location: { directory },
    options,
    app: { log: async ({ body }) => calls.logs.push(body) },
    session: {
      context: async ({ sessionID }) => {
        calls.sessions.push(sessionID);
        return [{ id: 'm1', role: 'assistant', time: { completed: 1 }, finish: 'stop', parts: [{ type: 'text', text: '**A robust tool.**' }] }];
      },
      hook: async (name, callback) => {
        if (name === 'context') onContext = callback;
      },
    },
    skill: { transform: async (callback) => callback({
      get: () => undefined,
      add: (skill) => calls.skills.push(skill),
    }) },
    tool: { hook: async (name, callback) => { if (name === 'execute.after') onTool = callback; } },
    event: { subscribe: async function* ({ signal }) {
      while (!signal.aborted) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          wake = resolve;
          signal.addEventListener('abort', resolve, { once: true });
        });
      }
    } },
  };
  const setup = plugin.setup(ctx);
  return {
    calls, directory,
    async start() { cleanup = await setup; },
    async context(sessionID = 's1') { const event = { sessionID, system: [] }; await onContext(event); return event.system; },
    async tool(event) { await onTool(event); return event; },
    emit(event) { queue.push(event); wake?.(); },
    stop() { cleanup?.(); },
  };
}

test('exports a V2 plugin definition and registers the skill and request context', async (t) => {
  const h = fixture(t);
  await h.start();
  assert.equal(plugin.id, 'simple-english');
  assert.equal(h.calls.skills[0].id, 'simple-english');
  assert.equal(h.calls.skills[0].path, path.join(ROOT, 'skills/simple-english/SKILL.md'));
  const system = await h.context();
  assert.equal(system[0].type, 'text');
  assert.match(system[0].text, /SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY/);
  h.stop();
});

test('V2 replyStyle false omits only chat reply rules', async (t) => {
  const h = fixture(t, { replyStyle: false });
  await h.start();
  const [context] = await h.context();
  assert.doesNotMatch(context.text, /THE REPLY/);
  assert.match(context.text, /THE DOCUMENT/);
  h.stop();
});

test('V2 after-tool hook appends Markdown advice to completed tool result', async (t) => {
  const h = fixture(t);
  await h.start();
  writeFileSync(path.join(h.directory, 'notes.md'), SLOP);
  const event = await h.tool({
    status: 'completed', tool: 'write', input: { filePath: 'notes.md' },
    result: { content: [{ type: 'text', text: 'Success.' }] },
  });
  assert.match(event.result.content.at(-1).text, /simple-english: notes\.md/);
  h.stop();
});

test('V2 idle event checks the reply and injects advice once on the next context', async (t) => {
  const h = fixture(t);
  await h.start();
  h.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
  // Let the async subscription process the idle event and complete its bounded check.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const system = await h.context();
  assert.equal(system.length, 2);
  assert.match(system[1].text, /reply check/);
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.logs.length, 1);
  h.stop();
});
