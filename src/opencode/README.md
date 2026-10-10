# Simple English for OpenCode

This local plugin loads the writing rules automatically and runs advisory checks on Markdown files and completed replies.
It uses the same prompt and Python linter as the Claude Code plugin.

## Install from a checkout

Clone the repository to a persistent location:

```bash
git clone https://github.com/AminBlg/SimpleEnglish.git "$HOME/tools/SimpleEnglish"
```

Add the entry point to `~/.config/opencode/opencode.json` for all projects, or to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///Users/alex/tools/SimpleEnglish/src/opencode/index.mjs"
  ]
}
```

Replace the example with your checkout's absolute file URL. Keep existing configuration fields and plugin entries.
On Linux, a typical URL is `file:///home/alex/tools/SimpleEnglish/src/opencode/index.mjs`.
On Windows, use a URL such as `file:///C:/Users/alex/tools/SimpleEnglish/src/opencode/index.mjs`.
Encode spaces as `%20` in file URLs.

For a project configuration inside this checkout, a relative entry works too:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./src/opencode/index.mjs"]
}
```

Relative entries resolve from the configuration file. An absolute file URL also works when the active project is outside this checkout.
Keep the entry point in the checkout, because it reads the repository's prompt, skill, and linter by relative paths.

Quit and restart OpenCode after installation or configuration changes.
The plugin has no build step or npm dependencies. OpenCode runs the JavaScript; Python 3.9 or later runs the advisory checks.
If Python is unavailable, the writing rules still load.

## Options

Both advisory checks are enabled by default. Use a plugin tuple to change their options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///Users/alex/tools/SimpleEnglish/src/opencode/index.mjs",
      {
        "fileChecks": true,
        "replyChecks": true,
        "pythonCommand": "python3"
      }
    ]
  ]
}
```

- Set `fileChecks` to `false` to disable Markdown checks.
- Set `replyChecks` to `false` to disable completed-reply checks.
- Set `pythonCommand` to an executable name or absolute path if Python has another name or location. Do not include shell arguments.

Quit and restart OpenCode after changing these options.

## How it works

The plugin appends the condensed rules from `prompts/system-prompt.md` to each model request through `experimental.chat.system.transform`.
Existing system instructions stay in place. Request-time injection keeps the rules active after resume and compaction.
If the prompt is missing or oversized, the existing activation helper supplies fallback rules.

The `config` hook adds the checkout's `skills` directory to `skills.paths`, preserving existing paths and URLs.
The full `simple-english` skill and its references remain available for Strict mode and compliance checks.

### Markdown checks

After `write`, `edit`, or `apply_patch`, the plugin checks the surviving `.md` files with `src/hooks/lint_hook.py`.
Patch checks include rename destinations and skip deleted files. Other tools, including shell commands and MCP tools, are not checked.
Findings are appended to the tool result with the offending text and line numbers.
The tool has already completed; the check never converts success into failure.

The file check skips these paths:

- Paths with a `.opencode` or `.claude` directory component.
- OpenCode's default global configuration directory, `${XDG_CONFIG_HOME:-~/.config}/opencode`, and `OPENCODE_CONFIG_DIR` when set.
- The Claude configuration directory, from `CLAUDE_CONFIG_DIR` or `~/.claude`.
- Globs from `SIMPLE_ENGLISH_LINT_EXCLUDE`.

Exclusions apply to both the written path and the resolved path, including symlinks.
Glob patterns use `:` separators on Linux and macOS, and `;` separators on Windows. In a pattern, `*` also matches `/`.

```bash
export SIMPLE_ENGLISH_LINT_EXCLUDE="$HOME/notes/*:*/CHANGELOG.md"
```

Set this variable to `*` to skip all file checks. Reply checks remain enabled.

### Reply checks

At `session.idle`, the plugin reads the latest completed assistant reply through the OpenCode SDK.
It combines the reply's text parts and passes them to the existing Python `Stop` check.
Summaries, failed replies, unfinished replies, and synthetic text are skipped.

If the reply has violations, the plugin logs the advice and injects it once into the next model request in that session.
It does not revise already-streamed text or start another turn. Duplicate idle events do not repeat feedback for the same message.
A newer clean reply clears queued advice. Session deletion and plugin disposal clear session state.
Queued advice is held in memory and does not survive an OpenCode restart.

Python processes have a ten-second timeout and a 64 KiB output limit per check.
Missing executables, timeouts, unreadable files, malformed results, and SDK failures leave the session usable.

## Update

Pull updates in the checkout:

```bash
git -C "$HOME/tools/SimpleEnglish" pull --ff-only
```

Quit and restart OpenCode to load the update. If you move the checkout, update the configured plugin path before restarting.

## Compatibility and tests

The adapter was tested on OpenCode 1.18.35 from a separate project with a local mock model provider.
The smoke test covered plugin loading, skill discovery, rule injection, Markdown advice, and next-request reply advice.
The system-transform hook is experimental; later versions can change its interface.
Plugin loading and skill discovery can be checked from the active project with `opencode debug config` and `opencode debug skill`.

Run the automated checks from the repository root:

```bash
node --test src/hooks/simple-english-activate.test.js src/opencode/index.test.mjs
python3 src/hooks/test_lint_hook.py
python3 evals/ste_lint.py --self-test
python3 evals/check_numbers.py
```
