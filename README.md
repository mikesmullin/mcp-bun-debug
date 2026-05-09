# mcp-bun-debug

An MCP (Model Context Protocol) stdio server that exposes Bun's built-in debugger as tools for AI agents. Agents can launch processes, set breakpoints, step through code, and inspect variables — all over the standard MCP tool-call interface.

## Tools

| Tool | Description |
|------|-------------|
| `debug_launch` | Start a script under `bun --inspect-brk` and return a session id |
| `debug_list_sessions` | Show all active debug sessions |
| `debug_set_breakpoint` | Set a breakpoint by file and line number |
| `debug_continue` | Resume to the next breakpoint |
| `debug_step_over` | Step over the current line |
| `debug_step_into` | Step into a function call |
| `debug_step_out` | Step out of the current function |
| `debug_list_variables` | List variables in scope at the current pause |
| `debug_get_variable` | Evaluate a variable or expression |
| `debug_set_variable` | Assign a new value to a variable |
| `debug_quit` | Kill a session |

See [SKILLS.md](SKILLS.md) for detailed usage, parameters, and common patterns.

## Quick start

```bash
# Install dependencies
bun install

# Run the MCP server (reads from stdin, writes to stdout)
bun src/index.ts
```

## Using with GitHub Copilot in VS Code

GitHub Copilot's agent mode supports MCP servers. Registering `mcp-bun-debug` teaches Copilot's agent how to attach a debugger to any Bun process.

### 1. Register the MCP server

Add this to your VS Code **user** `settings.json` (or workspace `.vscode/settings.json`):

```json
{
  "github.copilot.chat.mcp.servers": {
    "bun-debug": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/workspace/mcp-bun-debug/src/index.ts"]
    }
  }
}
```

VS Code will start the server automatically when Copilot needs it. You can verify it's registered under **Settings → GitHub Copilot → MCP Servers**.

### 2. Ask Copilot to debug your script

Open **Copilot Chat** (`Ctrl+Shift+I`), switch to **Agent mode** (the `@` selector), and ask:

> Set a breakpoint at line 42 of `src/server.ts` in `/workspace/my-project`, run it, and tell me what `req.body` contains when the breakpoint is hit.

Copilot will discover the available tools from the MCP server and call `debug_launch`, `debug_set_breakpoint`, `debug_continue`, and `debug_get_variable` on its own.

### 3. Point Copilot at SKILLS.md

For best results, include [SKILLS.md](SKILLS.md) in Copilot's context. You can do this by:

- Opening `SKILLS.md` in VS Code and mentioning it with `#SKILLS.md` in your chat message, **or**
- Adding it to a `copilot-instructions.md` in your workspace:

```markdown
# Debugging Bun processes

Use the `mcp-bun-debug` MCP server to debug Bun scripts.
See #SKILLS.md for the full tool reference.
```

### 4. CoffeeScript support

If your project loads `bun-coffeescript` via `bunfig.toml`, the debugger works transparently — breakpoints map to the original `.coffee` lines.

```
# Copilot prompt example
Debug personal-email/agent.coffee in /workspace/agl-agents.
Set a breakpoint at line 37 and show me what _G contains.
```

## Using with Claude Code (VS Code extension)

The [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-for-vscode) loads MCP servers from `.mcp.json` files. **Do not use `.claude/settings.json` for this** — `mcpServers` is not a valid key there and will be silently ignored.

### 1. Register the MCP server

Create or edit `.mcp.json` in your workspace root:

```json
{
  "mcpServers": {
    "bun-debug": {
      "command": "bun",
      "args": ["run", "/workspace/mcp-bun-debug/src/index.ts"]
    }
  }
}
```

After saving, reload the VS Code window (**Developer: Reload Window** or `Ctrl+Shift+P → Reload Window`). The `bun-debug` tools will appear as available tools in the next conversation.

### 2. Load SKILLS.md into context

Claude will automatically discover the available tools, but pointing it at [SKILLS.md](SKILLS.md) gives it the full usage guide — parameter names, common patterns, and error-handling notes — without any trial-and-error.

Drop this in your workspace's `CLAUDE.md`:

```markdown
## Debugging Bun processes

An MCP server for debugging Bun scripts is available as `bun-debug`.
Read @SKILLS.md before using any `debug_*` tools.
```

### 3. Ask Claude to debug your script

Open Claude Code chat and ask directly:

> Debug `src/server.ts` in `/workspace/my-project`. Set a breakpoint at the top of the `handleRequest` function and show me what the request object looks like when a POST comes in.

Claude will launch the process, set the breakpoint, continue until it's hit, and report variables back — no manual interaction required.

### 4. CoffeeScript support

Projects using `bun-coffeescript` (via `bunfig.toml` preload) work transparently. Breakpoints resolve against the original `.coffee` source lines.

---

## Smoke tests

```bash
# Test against the included TypeScript fixture
bun test/smoke-test.ts

# Test against a real CoffeeScript agent (requires /workspace/agl-agents)
bun test/smoke-agent.ts
```

## How it works

1. `debug_launch` spawns `bun --inspect-brk=127.0.0.1:<port> <script>` and parses the WebSocket URL from stderr.
2. The server connects to Bun's **WebKit/JSC Inspector Protocol** over that WebSocket.
3. The correct initialization sequence is:
   ```
   Inspector.enable → Runtime.enable → Debugger.enable → Console.enable
   → Debugger.setBreakpointsActive → Inspector.initialized → Debugger.pause
   ```
   `Inspector.initialized` is the client-sends handshake that starts the VM; the immediate `Debugger.pause` catches execution at the first line.
4. All subsequent commands (`resume`, `stepOver`, breakpoints, `getProperties`) map directly to JSC inspector protocol messages.

> **Note:** Bun uses the WebKit inspector protocol, not Chrome/V8 CDP. Key differences: scope type is `nestedLexical` (not `local`), `Runtime.getProperties` returns a `properties` key (not `result`), and `Runtime.runIfWaitingForDebugger` does not exist — use `Inspector.initialized` + `Debugger.pause` instead.
