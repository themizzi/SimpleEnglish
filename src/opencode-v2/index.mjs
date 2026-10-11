import path from 'node:path';
import { fileURLToPath } from 'node:url';
import activation from '../hooks/simple-english-activate.js';
import { latestReply, markdownTargets, replyAdvice, runHook } from '../opencode/helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = path.join(ROOT, 'skills');
const SKILL_FILE = path.join(SKILLS, 'simple-english', 'SKILL.md');
const SCRIPT = path.join(ROOT, 'src', 'hooks', 'lint_hook.py');
const MARKER = 'SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY';

// V2 plugin definitions are plain objects with a stable ID and setup lifecycle.
export default {
  id: 'simple-english',
  async setup(ctx) {
    const directory = ctx.location.directory;
    const options = ctx.options || {};
    const context = activation.buildContext(
      activation.readFirstFile([path.join(ROOT, 'prompts', 'system-prompt.md')]),
      SKILL_FILE,
      options.replyStyle === false
        ? ''
        : activation.readFirstFile([path.join(ROOT, 'prompts', 'reply-style.md')]),
    );
    const python = typeof options.pythonCommand === 'string' ? options.pythonCommand : 'python3';
    const sessions = new Map();
    const controller = new AbortController();

    async function log(message) {
      try {
        await ctx.app.log({
          body: { service: 'simple-english', level: 'info', message },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        // Advisory logging must not prevent the next turn.
      }
    }

    async function checkReply(sessionID, state, revision) {
      try {
        const messages = await ctx.session.context({ sessionID, signal: AbortSignal.timeout(10000) });
        const reply = latestReply(messages);
        if (!reply || reply.id === state.checked) return;
        const result = await runHook(python, SCRIPT, {
          hook_event_name: 'Stop', last_assistant_message: reply.text,
        }, directory);
        if (sessions.get(sessionID) !== state || state.revision !== revision || !result) return;
        state.checked = reply.id;
        state.advice = replyAdvice(result);
        if (state.advice) await log(state.advice);
      } catch {
        // SDK and linter failures are advisory too.
      }
    }

    await ctx.skill.transform((editor) => {
      if (!editor.get('simple-english')) {
        editor.add({
          id: 'simple-english',
          name: 'Simple English',
          description: 'Write technical material in clear, concise Simplified Technical English.',
          path: SKILL_FILE,
          content: activation.readFirstFile([SKILL_FILE]),
        });
      }
    });

    await ctx.session.hook('context', async (event) => {
      if (!event.system.some((item) => item.type === 'text' && item.text.includes(MARKER))) {
        event.system.push({ type: 'text', text: context });
      }
      const state = sessions.get(event.sessionID);
      if (!state) return;
      let pending;
      do {
        pending = state.pending;
        await pending;
      } while (pending !== state.pending && sessions.get(event.sessionID) === state);
      if (sessions.get(event.sessionID) !== state || !state.advice) return;
      if (!event.system.some((item) => item.type === 'text' && item.text.includes(state.advice))) {
        event.system.push({ type: 'text', text: state.advice });
      }
      state.advice = '';
    });

    await ctx.tool.hook('execute.after', async (event) => {
      if (options.fileChecks === false || event.status !== 'completed') return;
      try {
        let result = event.result;
        const targets = markdownTargets(
          { tool: event.tool, args: event.input },
          { metadata: result?.metadata },
          directory,
        );
        for (const file of targets) {
          const lint = await runHook(python, SCRIPT, {
            hook_event_name: 'PostToolUse', harness: 'opencode', cwd: directory,
            tool_input: { file_path: file },
          }, directory);
          if (lint?.code !== 2 || !lint.stderr.trim()) continue;
          const content = Array.isArray(result.content) ? [...result.content] : [];
          content.push({ type: 'text', text: lint.stderr.trim() });
          result = { ...result, content };
          event.result = result;
        }
      } catch {
        // Preserve the successful tool result even if a check fails.
      }
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.deleted') {
            sessions.delete(event.properties?.info?.id ?? event.properties?.sessionID);
            continue;
          }
          const sessionID = event.properties?.sessionID;
          if (options.replyChecks === false || event.type !== 'session.idle' || !sessionID) continue;
          let state = sessions.get(sessionID);
          if (!state) {
            state = { revision: 0, checked: '', advice: '', pending: undefined };
            sessions.set(sessionID, state);
          }
          state.pending = checkReply(sessionID, state, ++state.revision);
          await state.pending;
        }
      } catch {
        if (!controller.signal.aborted) await log('Event subscription stopped unexpectedly.');
      }
    })();

    return () => {
      controller.abort();
      sessions.clear();
    };
  },
};
