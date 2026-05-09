#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { manager } from './manager.js';

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'debug_list_sessions',
    description: 'List all active bun debug sessions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'debug_launch',
    description:
      'Launch a new bun process under --inspect-brk and return the session id. ' +
      'The process pauses at entry; use debug_continue or set breakpoints first.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory for the process' },
        script: { type: 'string', description: 'Script file to run (relative or absolute)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI arguments', default: [] },
      },
      required: ['cwd', 'script'],
    },
  },
  {
    name: 'debug_set_breakpoint',
    description: 'Set a breakpoint by file path and line number.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from debug_launch' },
        file: { type: 'string', description: 'File path (relative to session cwd or absolute)' },
        line: { type: 'number', description: 'Line number (1-indexed)' },
      },
      required: ['session_id', 'file', 'line'],
    },
  },
  {
    name: 'debug_list_variables',
    description: 'List variables in scope at the current pause point.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'debug_get_variable',
    description: 'Get the value of a variable (or any expression) at the current pause point.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        expression: { type: 'string', description: 'Variable name or JS expression' },
      },
      required: ['session_id', 'expression'],
    },
  },
  {
    name: 'debug_set_variable',
    description: 'Assign a new value to a variable at the current pause point.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        name: { type: 'string', description: 'Variable name' },
        value: { type: 'string', description: 'New value as a JS expression (e.g. "42", `"hello"`, "[1,2,3]")' },
      },
      required: ['session_id', 'name', 'value'],
    },
  },
  {
    name: 'debug_continue',
    description: 'Resume execution and pause at the next breakpoint.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'debug_step_over',
    description: 'Step to the next line in the current function.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'debug_step_into',
    description: 'Step into the next function call.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'debug_step_out',
    description: 'Step out of the current function.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'debug_step_to',
    description:
      'Run to a specific line number in the current script using Debugger.continueToLocation. ' +
      'More reliable than debug_step_over for async functions, where stepOver may skip multiple source lines ' +
      'in a single async continuation resumption (e.g. after an await expression).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        line: { type: 'number', description: 'Target line number (1-indexed) in the current script' },
      },
      required: ['session_id', 'line'],
    },
  },
  {
    name: 'debug_backtrace',
    description: 'Show the full call stack at the current pause point — use this after any step command to confirm where execution landed.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'debug_quit',
    description: 'Kill a debug session and its process.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
];

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mcp-bun-debug', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'debug_list_sessions': {
        const sessions = manager.list();
        if (sessions.length === 0) {
          return text('No active debug sessions.');
        }
        const lines = sessions.map(s => {
          const info = s.info();
          const loc = info.pauseLocation;
          const locStr = loc ? ` | paused at ${loc.file}:${loc.line} in ${loc.function}()` : '';
          return `[${info.id}] pid=${info.pid} port=${info.port} state=${info.state} script=${info.script}${locStr}\n  log: ${info.logFile}`;
        });
        return text(lines.join('\n'));
      }

      case 'debug_launch': {
        const { cwd, script, args: scriptArgs = [] } = args as {
          cwd: string; script: string; args?: string[];
        };
        const session = await manager.launch(cwd, script, scriptArgs as string[]);
        const info = session.info();
        const loc = info.pauseLocation;
        const locStr = loc ? `\nPaused at: ${loc.file}:${loc.line} in ${loc.function}()` : '';
        return text(
          `Launched session [${info.id}]\n` +
          `pid=${info.pid}  port=${info.port}  state=${info.state}\n` +
          `log: ${info.logFile}` +
          locStr,
        );
      }

      case 'debug_set_breakpoint': {
        const { session_id, file, line } = args as { session_id: string; file: string; line: number };
        const session = manager.get(session_id);
        const result = await session.setBreakpoint(file, line);
        return text(`Breakpoint set: id=${result.breakpointId}  resolved at line ${result.resolvedLine}`);
      }

      case 'debug_list_variables': {
        const { session_id } = args as { session_id: string };
        const session = manager.get(session_id);
        const vars = await session.listScopeVariables();
        if (vars.length === 0) return text('No variables in scope.');
        const lines = vars.map(v => `  ${v.name}: ${v.type} = ${v.preview}`);
        return text(`Variables in scope:\n${lines.join('\n')}`);
      }

      case 'debug_get_variable': {
        const { session_id, expression } = args as { session_id: string; expression: string };
        const session = manager.get(session_id);
        const value = await session.evaluate(expression);
        return text(`${expression} = ${value}`);
      }

      case 'debug_set_variable': {
        const { session_id, name, value } = args as { session_id: string; name: string; value: string };
        const session = manager.get(session_id);
        const result = await session.setVariable(name, value);
        return text(`${name} = ${result}`);
      }

      case 'debug_continue': {
        const { session_id } = args as { session_id: string };
        const session = manager.get(session_id);
        const paused = await session.resume();
        return text(formatPaused(session, paused));
      }

      case 'debug_step_over': {
        const { session_id } = args as { session_id: string };
        const session = manager.get(session_id);
        const paused = await session.stepOver();
        return text(formatPaused(session, paused));
      }

      case 'debug_step_into': {
        const { session_id } = args as { session_id: string };
        const session = manager.get(session_id);
        const paused = await session.stepInto();
        return text(formatPaused(session, paused));
      }

      case 'debug_step_out': {
        const { session_id } = args as { session_id: string };
        const session = manager.get(session_id);
        const paused = await session.stepOut();
        return text(formatPaused(session, paused));
      }

      case 'debug_step_to': {
        const { session_id, line } = args as { session_id: string; line: number };
        const session = manager.get(session_id);
        const paused = await session.continueToLine(line);
        return text(formatPaused(session, paused));
      }

      case 'debug_backtrace': {
        const { session_id } = args as { session_id: string };
        const session = manager.get(session_id);
        const frames = session.backtrace();
        const lines = frames.map(f => {
          const loc = f.file ? `${f.file}:${f.line}:${f.column}` : '(native)';
          const fn = f.function || '(anonymous)';
          return `  #${f.frame}  ${fn}  —  ${loc}`;
        });
        return text(`Call stack (${frames.length} frame${frames.length !== 1 ? 's' : ''}):\n${lines.join('\n')}`);
      }

      case 'debug_quit': {
        const { session_id } = args as { session_id: string };
        manager.kill(session_id);
        return text(`Session [${session_id}] killed.`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function formatPaused(session: import('./debugger.js').BunDebugSession, paused: import('./debugger.js').PausedState): string {
  const loc = session.currentLocation();
  if (!loc) return `Paused (reason: ${paused.reason})`;
  const bps = paused.hitBreakpoints?.length ? `  hit breakpoints: ${paused.hitBreakpoints.join(', ')}` : '';
  return `Paused at ${loc.file}:${loc.line} in ${loc.function}()  (reason: ${paused.reason})${bps}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
