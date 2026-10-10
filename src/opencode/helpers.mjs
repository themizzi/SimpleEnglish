import { execFile } from 'node:child_process';
import path from 'node:path';

// Exit 2 is advisory in the existing PostToolUse protocol, not a tool failure.
export function runHook(command, script, event, cwd, { timeout = 10000, maxBuffer = 65536 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, [script], { cwd, timeout, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && error.code !== 2) {
        resolve(null);
        return;
      }
      resolve({ code: error ? 2 : 0, stdout, stderr });
    });
    // A missing executable or an early process exit can close stdin first.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

export function markdownTargets(input, output, directory) {
  let files = [];
  if (input.tool === 'write' || input.tool === 'edit') {
    files = [input.args?.filePath];
  } else if (input.tool === 'apply_patch' && Array.isArray(output.metadata?.files)) {
    files = output.metadata.files
      .filter((file) => file.type !== 'delete')
      .map((file) => file.movePath || file.filePath);
  }
  return [...new Set(files
    .filter((file) => typeof file === 'string' && file.endsWith('.md'))
    .map((file) => path.resolve(directory, file)))];
}

export function latestReply(messages) {
  if (!Array.isArray(messages)) return null;
  // Do not reach back past a new user turn or a failed/unfinished response.
  const message = messages.findLast((item) => !item.info?.summary);
  const info = message?.info;
  if (info?.role !== 'assistant' || !info.time?.completed || info.error || info.finish === 'tool-calls') return null;
  const text = (message.parts || [])
    .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join('\n\n');
  return text ? { id: info.id, text } : null;
}

export function replyAdvice(result) {
  if (!result || result.code !== 0) return '';
  try {
    const message = JSON.parse(result.stdout).systemMessage;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}
