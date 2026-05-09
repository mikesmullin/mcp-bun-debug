# mcp-bun-debug — AI Agent Skills

Attach a live debugger to any Bun process via MCP tools.  
All tools communicate over stdio with the `mcp-bun-debug` server.

---

## Quick-start workflow

```
1. debug_launch            → get session_id; note the initial pause location
2. debug_set_breakpoint    → set breakpoints in YOUR script (not the built-in the process is currently paused in)
3. debug_continue          → run to your first breakpoint
4. debug_backtrace         → confirm you're in the right place after any step or continue
5. debug_list_variables / debug_get_variable / debug_step_over / ...
6. debug_quit when done
```

**Critical:** after launch the process is paused inside the first loaded module, which may be
a Node.js built-in (`node:fs/promises`, `node:path`, etc.) rather than your script.
Always set at least one breakpoint in your target file before calling `debug_continue`, or
the 30-second timeout will expire with nothing to show.

---

## Tools

### `debug_list_sessions`
List all active debug sessions with their state, pid, port, and current pause location.

**Returns:** plain-text table of sessions, or "No active debug sessions."

---

### `debug_launch`
Start a script under Bun's `--inspect-brk` debugger. The process pauses immediately at the
entry of the first loaded module — which may be a preloaded built-in, not your script.

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
Paused at: node:fs/promises:1 in node:fs/promises()
```

**Notes:**
- `session_id` is the 6-char hex ID shown in brackets, e.g. `abc123`
- The initial pause location is often a Node built-in — this is normal. Set a breakpoint in your script before continuing.
- stdout/stderr from the target process are written to the log file; check it if the process errors on startup.

---

### `debug_set_breakpoint`
Set a breakpoint at a source file + line number.

**Inputs:**
| field | type | required | description |
|-------|------|----------|-------------|
| `session_id` | string | ✓ | |
| `file` | string | ✓ | File path relative to `cwd`, or absolute |
| `line` | number | ✓ | Line number (1-indexed) |

**Returns:** `Breakpoint set: id=<bp_id>  resolved at line <n>`

**Notes:**
- The **resolved line** may differ from the requested line for transpiled files (TypeScript, CoffeeScript). Always read the resolved line from the response — that is the line where execution will actually stop.
- Breakpoints can be set while paused anywhere, including before the script has started running. Set them immediately after `debug_launch`.
- Requesting a line that is a comment or blank will snap to the next executable statement.

---

### `debug_list_variables`
List variables in scope at the current pause point. Covers local, block, and closure scopes.

**Inputs:** `session_id`

**Returns:**
```
Variables in scope:
  user: object = {id: 1, name: Alice, role: admin}
  config: object = {timeout: 30000, retries: 3}
  count: number = 42
  label: string = "active"
  fetchData: function = async function(url) {…
```

**Notes:**
- Object values are expanded one level deep automatically (`{key: value, …}`).
- Function-type variables (imports, closures) are shown as a truncated signature (`async function(args) {…`). Use `debug_get_variable` to evaluate them if needed.
- Variables declared on the **current line** (the line you're paused at) have not been initialized yet and will not appear, or will throw a `ReferenceError` if evaluated — step over once to initialize them.
- For modules with many imports the list can be long. Use `debug_get_variable` with a specific name for targeted inspection.

---

### `debug_get_variable`
Evaluate a variable name or any JavaScript expression at the current pause point.

**Inputs:**
| field | type | description |
|-------|------|-------------|
| `session_id` | string | |
| `expression` | string | Variable name or JS expression, e.g. `user.email`, `arr.length`, `JSON.stringify(config, null, 2)` |

**Returns:** `<expression> = <value>`

**Notes:**
- Evaluating a variable declared on the current line (not yet initialized) returns a `ReferenceError` — step over once first.
- Full JS expressions work: `Object.keys(config)`, `users.filter(u => u.role === "admin")`, etc.

---

### `debug_set_variable`
Assign a new value to a variable at the current pause point.

**Inputs:**
| field | type | description |
|-------|------|-------------|
| `session_id` | string | |
| `name` | string | Variable name |
| `value` | string | New value as a JS expression: `"42"`, `'"hello"'`, `'[1,2,3]'`, `'null'`, `'{ ...user, role: "admin" }'` |

**Returns:** `<name> = <new_value>`

**Notes:**
- Only works for `let` and `var` bindings. Attempting to reassign a `const` returns `TypeError: Attempted to assign to readonly property`.
- The value is evaluated as a JS expression in the current scope, so you can reference other local variables: `value='{ ...config, debug: true }'`.

---

### `debug_continue`
Resume execution and pause at the next breakpoint.

**Inputs:** `session_id`

**Returns:** `Paused at <file>:<line> in <function>()  (reason: Breakpoint)`

**Warning:** Waits up to 30 seconds for the next pause. If no breakpoint is ever hit (process finishes or loops forever without hitting one), the call times out with `Timeout waiting for Debugger.paused`. Always set at least one breakpoint before calling this.

---

### `debug_step_over`
Execute the current line and pause at the next line in the same function.

**Inputs:** `session_id`  
**Returns:** `Paused at <file>:<line> in <function>()  (reason: other)`

**Note:** The result only shows the top frame. If you land somewhere unexpected, call `debug_backtrace` immediately to see the full call stack.

**Known limitation — async functions:** In `async` functions (TypeScript or CoffeeScript), a single `debug_step_over` may skip multiple source lines when the runtime resumes an async continuation. Symptoms: landed at an unexpected line, pause reason is `Breakpoint` instead of `other`, a variable you expected to be initialized is still `undefined`. Use `debug_step_to` instead of `debug_step_over` when paused inside an async function.

---

### `debug_step_to`
Run to a specific line number in the current script using `Debugger.continueToLocation`. Reliable for async functions where `debug_step_over` may jump too far.

**Inputs:**
| field | type | required | description |
|-------|------|----------|-------------|
| `session_id` | string | ✓ | |
| `line` | number | ✓ | Target line number (1-indexed) in the **same script** currently paused |

**Returns:** `Paused at <file>:<line> in <function>()  (reason: other)`

**When to use:**
- Paused inside an `async` function or after an `await` expression
- `debug_step_over` just landed on the wrong line (skipped lines in an async continuation)
- You want to advance exactly to a known line number without risking overshooting

**Example — async step-over workaround:**
```
# Paused at page.coffee:20 inside an async function
debug_step_over session_id=abc123
# → Landed at line 25 (skipped the assignment on line 20!), reason: Breakpoint

# Correct approach:
debug_step_to session_id=abc123 line=21
# → Paused at page.coffee:21  (reason: other)  ✓
debug_get_variable session_id=abc123 expression=now
# → now = "2026-05-09T19:18:08.711Z"  ✓
```

---

### `debug_step_into`
Step into the function call on the current line.

**Inputs:** `session_id`  
**Returns:** `Paused at <file>:<line> in <function>()  (reason: other)` — inside the callee

**Note:** Stepping into a native or built-in function may land in internal runtime code. Call `debug_backtrace` to orient yourself, then use `debug_step_out` to return to your script.

---

### `debug_step_out`
Run to the end of the current function and pause at the call site.

**Inputs:** `session_id`  
**Returns:** `Paused at <file>:<line> in <function>()  (reason: other)` — back in the caller

---

### `debug_backtrace`
Print the full call stack at the current pause point. Use this after any step command to confirm exactly where execution has landed, especially when the location is unexpected.

**Inputs:** `session_id`

**Returns:**
```
Call stack (4 frames):
  #0  greet  —  /workspace/project/src/utils.ts:8:2
  #1  module code  —  /workspace/project/src/index.ts:12:20
  #2  module code  —  /workspace/project/src/index.ts:4:0
  #3  (anonymous)  —  bun:main:6:0
```

Frame `#0` is where execution is paused. Each line shows: frame index, function name, file path, line, and column.

**When to use:**
- After `debug_step_into` to confirm you entered the right function
- After `debug_step_over` lands on an unexpected line
- Any time you're disoriented about the current execution context

---

### `debug_quit`
Kill the debug session and its child process.

**Inputs:** `session_id`

---

## Common patterns

### Inspect a specific variable in a function
```
debug_launch cwd=/workspace/project script=src/server.ts
# Check where we're paused first — likely a built-in
debug_list_sessions
# Set breakpoints in our target file before continuing
debug_set_breakpoint session_id=abc123 file=src/handlers/user.ts line=47
debug_continue session_id=abc123
# Now paused at line 47 (or the resolved line shown by set_breakpoint)
debug_get_variable session_id=abc123 expression="JSON.stringify(req.body, null, 2)"
debug_quit session_id=abc123
```

### Step through a function and watch state change
```
debug_set_breakpoint session_id=abc123 file=src/process.ts line=20
debug_continue session_id=abc123
debug_backtrace session_id=abc123           # confirm we're at the right frame
debug_list_variables session_id=abc123      # see initial state
debug_step_over session_id=abc123           # execute line 20
debug_backtrace session_id=abc123           # confirm location after step
debug_list_variables session_id=abc123      # see updated state
debug_get_variable session_id=abc123 expression=result
```

### Patch a let/var value to force a branch
```
# Paused before the if-check
debug_get_variable session_id=abc123 expression=featureFlag   # currently false
debug_set_variable session_id=abc123 name=featureFlag value=true
debug_step_over session_id=abc123   # now takes the true branch
```

### Inspect what an async function returns
```
debug_step_into session_id=abc123    # enter the async function
debug_step_out  session_id=abc123    # run it to completion, return to caller
debug_get_variable session_id=abc123 expression=result
```

### Debug a CoffeeScript or TypeScript file
```
# Bun transpiles automatically — use the source file path and source line numbers.
# The resolved line in the set_breakpoint response is the authoritative stop line.
debug_launch cwd=/workspace/agl-agents script=personal-email/agent.coffee
debug_set_breakpoint session_id=abc123 file=personal-email/agent.coffee line=37
# Response: "resolved at line 38" — that is where execution will stop
debug_continue session_id=abc123
debug_get_variable session_id=abc123 expression=_G
```

---

## Error reference

| Error | Meaning | Fix |
|-------|---------|-----|
| `Not paused` | Called a variable/step tool while running | Wait for a breakpoint; set one and call `debug_continue` |
| `No session with id "xyz"` | Session ID doesn't exist | Call `debug_list_sessions` to see active IDs |
| `Session "xyz" has exited` | Process crashed or finished | Check the log file path from `debug_list_sessions` |
| `Timeout waiting for Debugger.paused` | No breakpoint was hit within 30 s | Set a breakpoint closer to the code path being executed |
| `ReferenceError: Cannot access 'X' before initialization` | Variable X is declared on the current line (TDZ) | Step over once, then evaluate |
| `TypeError: Attempted to assign to readonly property` | Variable is `const` | Only `let`/`var` can be reassigned with `debug_set_variable` |
