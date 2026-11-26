# Guard Hook

Install `scripts/hooks/engine-guard.cjs` as a Claude Code `PreToolUse` command hook with matcher
`Agent|Task|Workflow|Bash|PowerShell|Monitor`. See [the hook reference](https://code.claude.com/docs/en/hooks).
In a shell command, quoted text and heredoc bodies are data, so writing or searching for the words `claude -p` is not blocked. Text after `bash -c`, `cmd /c`, `-Command` or `eval`, `$( )` substitutions, and a quoted program path in command position are still commands.

- The guard reads the user-level config and the chat key. A missing key file uses the new-chat policy.
  A missing session ID or malformed key denies recognized Claude launch requests.
- With Codex or Gemini selected, the guard checks `tool_input.prompt` for Agent, Task and WebFetch,
  the leading `//` comment of `tool_input.script` for Workflow, or the leading `#` comment
  of `tool_input.command` for a recognized shell launch. Only one declaration is accepted.
- `CLAUDE-ONLY: ceiling` requires a recent marker for each enabled external engine before Claude
  in the configured fallback order, starting with the active engine.
- `CLAUDE-ONLY: tool <name>` requires an exact user-configured tool name. A name in
  `guard.allowAgents` authorizes only the matching named Agent or Task when the request explicitly
  names that agent in its declaration. Built-in general agents still require a tool exception.
- A permitted exception appends one JSONL record to `guard.auditLog`. A failed append denies the
  exception. Unexpected hook errors exit 0 silently.

## Enforcement limits

Skill and WebFetch are not blocked on purpose: blocking Skill would stop the chat from using any skill, this one included, and WebFetch only reads a page. A skill declared with a forked context runs on Claude; if that matters, keep such skills out of external-engine chats.

The shell check catches direct Claude launches and common wrappers. Arbitrary shell programs,
other executable tools, Claude Code features that launch agents outside these hook events, and
modification of user-writable hook state cannot be contained by this routing hook. The marker and
tool declarations rely on trusted local writers and tool configuration. Use managed tool permissions
and OS isolation if preventing all indirect Claude launches is a requirement.
