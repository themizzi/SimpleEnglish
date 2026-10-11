import path from 'node:path';
import { fileURLToPath } from 'node:url';
import activation from '../hooks/simple-english-activate.js';
import { latestReply, markdownTargets, replyAdvice, runHook } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = path.join(ROOT, 'skills');
const SCRIPT = path.join(ROOT, 'src', 'hooks', 'lint_hook.py');
const MARKER = 'SIMPLE ENGLISH SKILL ACTIVE AUTOMATICALLY';

// Export only the plugin function: OpenCode treats module exports as plugins.
export default async function SimpleEnglish({ client, directory }, options = {}) {
  const context = activation.buildContext(
    activation.readFirstFile([path.join(ROOT, 'prompts', 'system-prompt.md')]),
    path.join(SKILLS, 'simple-english', 'SKILL.md'),
    options.replyStyle === false
      ? ''
      : activation.readFirstFile([path.join(ROOT, 'prompts', 'reply-style.md')]),
  );
  const python = typeof options.pythonCommand === 'string' ? options.pythonCommand : 'python3';
  const sessions = new Map();
  let disposed = false;

  async function log(message) {
    try {
      await client.app.log({
        body: { service: 'simple-english', level: 'info', message },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Advisory logging must not prevent the next turn.
    }
  }

  async function checkReply(sessionID, state, revision) {
    try {
      const response = await client.session.messages({
        path: { id: sessionID },
        signal: AbortSignal.timeout(10000),
      });
      const reply = latestReply(response.data);
      if (!reply || reply.id === state.checked) return;
      const result = await runHook(python, SCRIPT, {
        hook_event_name: 'Stop', last_assistant_message: reply.text,
      }, directory);
      // A later idle event, deletion, or disposal invalidates this result.
      if (sessions.get(sessionID) !== state || state.revision !== revision || !result) return;
      state.checked = reply.id;
      state.advice = replyAdvice(result);
      if (state.advice) await log(state.advice);
    } catch {
      // SDK and linter failures are advisory too.
    }
  }

  return {
    config: async (config) => {
      config.skills ||= {};
      config.skills.paths ||= [];
      if (!config.skills.paths.includes(SKILLS)) config.skills.paths.push(SKILLS);
    },

    'experimental.chat.system.transform': async ({ sessionID }, output) => {
      if (!output.system.some((item) => item.includes(MARKER))) output.system.push(context);
      const state = sessions.get(sessionID);
      if (!state) return;
      // Event callbacks are not awaited by OpenCode. Join the bounded check
      // before consuming feedback, including any newer check started meanwhile.
      let pending;
      do {
        pending = state.pending;
        await pending;
      } while (pending !== state.pending && sessions.get(sessionID) === state);
      if (sessions.get(sessionID) !== state || !state.advice) return;
      if (!output.system.some((item) => item.includes(state.advice))) output.system.push(state.advice);
      state.advice = '';
    },

    'tool.execute.after': async (input, output) => {
      if (options.fileChecks === false) return;
      try {
        for (const file of markdownTargets(input, output, directory)) {
          const result = await runHook(python, SCRIPT, {
            hook_event_name: 'PostToolUse', harness: 'opencode', cwd: directory,
            tool_input: { file_path: file },
          }, directory);
          if (result?.code === 2 && result.stderr.trim()) output.output += `\n\n${result.stderr.trim()}`;
        }
      } catch {
        // Preserve the successful tool result even if a check fails.
      }
    },

    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        sessions.delete(event.properties?.info?.id);
        return;
      }
      const sessionID = event.properties?.sessionID;
      if (disposed || options.replyChecks === false || event.type !== 'session.idle' || !sessionID) return;
      let state = sessions.get(sessionID);
      if (!state) {
        state = { revision: 0, checked: '', advice: '', pending: undefined };
        sessions.set(sessionID, state);
      }
      state.pending = checkReply(sessionID, state, ++state.revision);
      await state.pending;
    },

    dispose: async () => {
      disposed = true;
      sessions.clear();
    },
  };
}
