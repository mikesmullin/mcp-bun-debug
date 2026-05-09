# mcp-bun-debug — AI Agent Skills

Attach a live debugger to any Bun process via MCP tools.  
All tools communicate over stdio with the `mcp-bun-debug` server.

---

## Quick-start workflow

```
1. debug_launch       → get session_id
2. debug_set_breakpoint (optional, before continuing)
3. debug_continue / debug_step_over / debug_step_into / debug_step_out
4. debug_list_variables / debug_get_variable / debug_set_variable
5. debug_quit when done
```

---

## Tools

### `debug_list_sessions`
List all active debug sessions with their state, pid, port, and current pause location.

**Returns:** plain-text table of sessions, or "No active debug sessions."

---

### `debug_launch`
Start a script under Bun's `--inspect-brk` debugger. The process **pauses at entry** — no code runs until you step or continue.

**Inputs:**
| field | type | required | description |
|-------|------|----------|-------------|
| `cwd` | string | ✓ | Working directory for the process |
| `script` | string | ✓ | Script file path (relative to cwd or absolute) |
| `args` | string[] | | Extra CLI arguments passed to the script |

**Returns:**
```
Launched session [abc123]
pid=12345  port=42001  state=paused
log: /tmp/bun-debug-abc123.log
Paused at: /workspace/project/index.ts:1 in (anonymous)()
```

**Notes:**
- `session_id` is the 6-char hex ID shown in brackets, e.g. `abc123`
- stdout/stderr from the target process are written to the log file
- The log file path is useful for checking runtime output after stepping

---

### `debug_set_breakpoint`
Set a breakpoint at a source file + line number. Safe to call before or after `debug_continue`.

**Inputs:**
| field | type | required | description |
|-------|------|----------|-------------|
| `session_id` | string | ✓ | |
| `file` | string | ✓ | File path relative to cwd, or absolute |
| `line` | number | ✓ | Line number (1-indexed) |

**Returns:** `Breakpoint set: id=<bp_id>  resolved at line <n>`

**Tip:** Set all breakpoints before calling `debug_continue` for the first time.

---

### `debug_list_variables`
List every variable in scope at the current pause point (local, closure, and block scopes).

**Inputs:** `session_id`

**Returns:**
```
Variables in scope:
  req: object = {method: GET, url: /api/users}
  res: object = {statusCode: 200}
  config: object = {timeout: 30000}
  count: number = 42
```

---

### `debug_get_variable`
Evaluate a variable name or any JavaScript expression at the current pause point.

**Inputs:**
| field | type | description |
|-------|------|-------------|
| `session_id` | string | |
| `expression` | string | Variable name or JS expression, e.g. `user.email`, `arr.length`, `JSON.stringify(config)` |

**Returns:** `<expression> = <value>`

---

### `debug_set_variable`
Assign a new value to a variable at the current pause point.

**Inputs:**
| field | type | description |
|-------|------|-------------|
| `session_id` | string | |
| `name` | string | Variable name |
| `value` | string | New value as a JS expression: `"42"`, `'"hello"'`, `'[1,2,3]'`, `'null'` |

**Returns:** `<name> = <new_value>`

---

### `debug_continue`
Resume execution and pause at the next breakpoint.

**Inputs:** `session_id`

**Returns:** `Paused at <file>:<line> in <function>()  (reason: breakpoint)`

**Warning:** If no breakpoint is hit, this will wait indefinitely (up to 30 s timeout). Always set breakpoints before continuing into long-running code.

---

### `debug_step_over`
Execute the current line and pause at the next line in the same function.

**Inputs:** `session_id`  
**Returns:** new pause location

---

### `debug_step_into`
Step into the function being called on the current line.

**Inputs:** `session_id`  
**Returns:** new pause location (inside the callee)

---

### `debug_step_out`
Finish the current function and pause at the call site.

**Inputs:** `session_id`  
**Returns:** new pause location (in the caller)

---

### `debug_quit`
Kill the debug session and its child process.

**Inputs:** `session_id`

---

## Common patterns

### Inspect a variable deep in a call stack
```
debug_launch cwd=/workspace/project script=src/server.ts
debug_set_breakpoint session_id=abc123 file=src/handlers/user.ts line=47
debug_continue session_id=abc123
debug_list_variables session_id=abc123
debug_get_variable session_id=abc123 expression="JSON.stringify(req.body, null, 2)"
debug_quit session_id=abc123
```

### Patch a value at runtime to test a branch
```
debug_set_variable session_id=abc123 name=featureEnabled value=true
debug_step_over session_id=abc123
```

### Check what an async function returns
```
debug_step_into session_id=abc123   # enter the async fn
debug_step_out session_id=abc123    # run to completion
debug_get_variable session_id=abc123 expression=result
```

---

## Error handling

All tools return `Error: <message>` when something goes wrong:
- `Not paused` — call a step/continue command first
- `No session with id "xyz"` — session doesn't exist; call `debug_list_sessions`
- `Session "xyz" has exited` — process crashed or finished; check the log file
- `Timeout waiting for Debugger.paused` — the process ran past all breakpoints
