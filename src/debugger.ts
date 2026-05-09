import WebSocket from 'ws';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type CDPParams = Record<string, unknown>;
type CDPResult = Record<string, unknown>;
type EventHandler = (params: CDPParams) => void;

export interface Location {
  scriptId: string;
  lineNumber: number;   // 0-indexed (CDP convention)
  columnNumber: number;
}

export interface Scope {
  type: 'global' | 'local' | 'closure' | 'catch' | 'block' | 'script' | 'with' | 'module';
  object: { objectId?: string; type: string; description?: string };
  name?: string;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: Location;
  scopeChain: Scope[];
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

export interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  writable?: boolean;
  enumerable?: boolean;
}

export interface PausedState {
  callFrames: CallFrame[];
  reason: string;
  hitBreakpoints?: string[];
}

export interface SessionInfo {
  id: string;
  pid: number;
  port: number;
  wsUrl: string;
  cwd: string;
  script: string;
  args: string[];
  logFile: string;
  state: string;
  pauseLocation?: { file: string; line: number; function: string };
}

export class BunDebugSession {
  readonly id: string;
  readonly pid: number;
  readonly port: number;
  readonly wsUrl: string;
  readonly cwd: string;
  readonly script: string;
  readonly args: string[];
  readonly logFile: string;

  private ws!: WebSocket;
  private proc: ChildProcess;
  private msgId = 1;
  private pending = new Map<number, { resolve: (r: CDPResult) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, EventHandler[]>();
  private onceHandlers = new Map<string, Array<(p: CDPParams) => void>>();

  scripts = new Map<string, string>(); // scriptId -> url
  urlToScriptId = new Map<string, string>(); // url -> scriptId
  state: 'starting' | 'running' | 'paused' | 'exited' = 'starting';
  pausedState?: PausedState;

  constructor(opts: {
    id: string; pid: number; port: number; wsUrl: string; cwd: string;
    script: string; args: string[]; logFile: string; proc: ChildProcess;
  }) {
    this.id = opts.id;
    this.pid = opts.pid;
    this.port = opts.port;
    this.wsUrl = opts.wsUrl;
    this.cwd = opts.cwd;
    this.script = opts.script;
    this.args = opts.args;
    this.logFile = opts.logFile;
    this.proc = opts.proc;

    this.proc.on('exit', () => { this.state = 'exited'; });
  }

  /** Connect WebSocket and enable debugger. Resolves when paused at first line. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.on('error', reject);
      ws.on('open', () => resolve());
      ws.on('message', (raw: Buffer | string) => {
        let msg: { id?: number; method?: string; result?: CDPResult; error?: { message: string }; params?: CDPParams };
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.id !== undefined) {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error.message));
            else cb.resolve(msg.result ?? {});
          }
        } else if (msg.method) {
          this._emit(msg.method, msg.params ?? {});
        }
      });
      ws.on('close', () => { this.state = 'exited'; });
    });

    this.on('Debugger.scriptParsed', (p) => {
      const { scriptId, url } = p as { scriptId: string; url: string };
      if (url) {
        this.scripts.set(scriptId, url);
        this.urlToScriptId.set(url, scriptId);
      }
    });

    this.on('Debugger.paused', (p) => {
      this.state = 'paused';
      this.pausedState = p as unknown as PausedState;
    });

    this.on('Debugger.resumed', () => {
      this.state = 'running';
      this.pausedState = undefined;
    });

    // JSC (WebKit) inspector protocol — must be sequential, not concurrent.
    // Bun holds the VM in pre-run state until Inspector.initialized is received.
    await this.send('Inspector.enable', {});
    await this.send('Runtime.enable', {});
    await this.send('Debugger.enable', {});
    await this.send('Console.enable', {});
    await this.send('Debugger.setBreakpointsActive', { active: true });

    // Inspector.initialized tells bun to start the VM.
    // Immediately follow with Debugger.pause so execution is caught before the
    // first user statement runs (the two messages land in the same TCP burst).
    await this.send('Inspector.initialized', {});
    await this.send('Debugger.pause', {});

    // Wait for first pause (the Debugger.pause above races with VM startup)
    if (this.state !== 'paused') {
      await this.waitFor('Debugger.paused', 15000);
    }
  }

  send(method: string, params: CDPParams = {}): Promise<CDPResult> {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  once(event: string, handler: EventHandler): void {
    if (!this.onceHandlers.has(event)) this.onceHandlers.set(event, []);
    this.onceHandlers.get(event)!.push(handler);
  }

  private _emit(event: string, params: CDPParams): void {
    for (const h of this.handlers.get(event) ?? []) h(params);
    const once = this.onceHandlers.get(event);
    if (once?.length) {
      this.onceHandlers.set(event, []);
      for (const h of once) h(params);
    }
  }

  waitFor(event: string, timeout = 10000): Promise<CDPParams> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
      this.once(event, (p) => { clearTimeout(timer); resolve(p); });
    });
  }

  // ── Debugger commands ─────────────────────────────────────────────────────

  async setBreakpoint(file: string, line: number): Promise<{ breakpointId: string; resolvedLine: number }> {
    // Bun reports script URLs as absolute paths (no file:// prefix), so match that format.
    const absPath = file.startsWith('/') ? file : join(this.cwd, file);
    const res = await this.send('Debugger.setBreakpointByUrl', {
      url: absPath,
      lineNumber: line - 1,  // CDP is 0-indexed
      columnNumber: 0,
    });
    const locations = (res.locations as Array<{ lineNumber: number }>) ?? [];
    return {
      breakpointId: res.breakpointId as string,
      resolvedLine: locations[0] ? locations[0].lineNumber + 1 : line,
    };
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.send('Debugger.removeBreakpoint', { breakpointId });
  }

  async resume(): Promise<PausedState> {
    // Register before sending so the event isn't missed if it fires during send()
    const nextPause = this.waitFor('Debugger.paused', 30000);
    await this.send('Debugger.resume', {});
    return (await nextPause) as unknown as PausedState;
  }

  async stepOver(): Promise<PausedState> {
    const nextPause = this.waitFor('Debugger.paused', 10000);
    await this.send('Debugger.stepOver', {});
    return (await nextPause) as unknown as PausedState;
  }

  async stepInto(): Promise<PausedState> {
    const nextPause = this.waitFor('Debugger.paused', 10000);
    await this.send('Debugger.stepInto', {});
    return (await nextPause) as unknown as PausedState;
  }

  async stepOut(): Promise<PausedState> {
    const nextPause = this.waitFor('Debugger.paused', 10000);
    await this.send('Debugger.stepOut', {});
    return (await nextPause) as unknown as PausedState;
  }

  // Use continueToLocation instead of stepOver for async functions where stepOver
  // may skip multiple source lines in a single async continuation resumption.
  async continueToLine(line: number): Promise<PausedState> {
    const frame = this.pausedState?.callFrames[0];
    if (!frame) throw new Error('Not paused');
    const nextPause = this.waitFor('Debugger.paused', 30000);
    await this.send('Debugger.continueToLocation', {
      location: {
        scriptId: frame.location.scriptId,
        lineNumber: line - 1,  // CDP is 0-indexed
        columnNumber: 0,
      },
    });
    return (await nextPause) as unknown as PausedState;
  }

  async getProperties(objectId: string): Promise<PropertyDescriptor[]> {
    const res = await this.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: true,
    });
    // JSC returns properties under "properties" key (not "result" like V8/CDP)
    return ((res.properties ?? res.result ?? []) as PropertyDescriptor[]);
  }

  // Expand an object one level deep using its objectId.
  private async expandObject(objectId: string): Promise<string> {
    const props = await this.getProperties(objectId);
    const pairs = props
      .filter(p => p.enumerable !== false && !p.name.startsWith('__'))
      .slice(0, 8)
      .map(p => `${p.name}: ${formatRemoteObject(p.value)}`);
    return `{${pairs.join(', ')}}`;
  }

  async listScopeVariables(): Promise<Array<{ name: string; type: string; preview: string }>> {
    if (!this.pausedState) throw new Error('Not paused');
    const frame = this.pausedState.callFrames[0];
    if (!frame) throw new Error('No call frames');

    const results: Array<{ name: string; type: string; preview: string }> = [];
    for (const scope of frame.scopeChain) {
      // JSC scope types: nestedLexical (≈local/block), closure, globalLexicalEnvironment, global
      if (!['local', 'closure', 'block', 'nestedLexical'].includes(scope.type)) continue;
      if (!scope.object.objectId) continue;
      const props = await this.getProperties(scope.object.objectId);
      for (const p of props) {
        if (p.name.startsWith('__') || !p.enumerable) continue;
        let preview = formatRemoteObject(p.value);
        // If the value is an unexpanded object, do one extra round-trip to show its fields.
        if (p.value?.type === 'object' && p.value.objectId && preview === (p.value.description ?? '[Object]')) {
          preview = await this.expandObject(p.value.objectId as string);
        }
        results.push({
          name: p.name,
          type: p.value?.type ?? 'undefined',
          preview,
        });
      }
    }
    return results;
  }

  async getVariable(name: string): Promise<string> {
    if (!this.pausedState) throw new Error('Not paused');
    const frame = this.pausedState.callFrames[0];
    if (!frame) throw new Error('No call frames');

    const res = await this.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: name,
      returnByValue: false,
      generatePreview: true,
    });
    return formatRemoteObject(res.result as RemoteObject);
  }

  async setVariable(name: string, expression: string): Promise<string> {
    if (!this.pausedState) throw new Error('Not paused');
    const frame = this.pausedState.callFrames[0];
    if (!frame) throw new Error('No call frames');

    const res = await this.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `${name} = (${expression})`,
      returnByValue: false,
    });
    return formatRemoteObject(res.result as RemoteObject);
  }

  async evaluate(expression: string): Promise<string> {
    if (!this.pausedState) throw new Error('Not paused');
    const frame = this.pausedState.callFrames[0];
    const res = frame
      ? await this.send('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression,
          returnByValue: false,
          generatePreview: true,
        })
      : await this.send('Runtime.evaluate', { expression, returnByValue: false, generatePreview: true });
    return formatRemoteObject(res.result as RemoteObject);
  }

  backtrace(): Array<{ frame: number; file: string; line: number; column: number; function: string }> {
    if (!this.pausedState) throw new Error('Not paused');
    return this.pausedState.callFrames.map((frame, i) => {
      const url = this.scripts.get(frame.location.scriptId) ?? '';
      const file = url.replace('file://', '');
      return {
        frame: i,
        file,
        line: frame.location.lineNumber + 1,
        column: frame.location.columnNumber,
        function: frame.functionName || '(anonymous)',
      };
    });
  }

  currentLocation(): { file: string; line: number; function: string } | undefined {
    if (!this.pausedState) return undefined;
    const frame = this.pausedState.callFrames[0];
    if (!frame) return undefined;
    const url = this.scripts.get(frame.location.scriptId) ?? '';
    const file = url.replace('file://', '');
    return { file, line: frame.location.lineNumber + 1, function: frame.functionName || '(anonymous)' };
  }

  info(): SessionInfo {
    return {
      id: this.id,
      pid: this.pid,
      port: this.port,
      wsUrl: this.wsUrl,
      cwd: this.cwd,
      script: this.script,
      args: this.args,
      logFile: this.logFile,
      state: this.state,
      pauseLocation: this.currentLocation(),
    };
  }

  quit(): void {
    try { this.ws?.close(); } catch {}
    try { this.proc.kill(); } catch {}
    this.state = 'exited';
  }
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchSession(opts: {
  id: string;
  cwd: string;
  script: string;
  args: string[];
  port: number;
}): Promise<BunDebugSession> {
  const { id, cwd, script, args, port } = opts;
  const logFile = join(tmpdir(), `bun-debug-${id}.log`);
  const logStream = createWriteStream(logFile);

  const proc = spawn('bun', [`--inspect-brk=127.0.0.1:${port}`, script, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  logStream.write(`=== bun debug session ${id} ===\n`);
  logStream.write(`cmd: bun --inspect-brk=127.0.0.1:${port} ${script} ${args.join(' ')}\n`);
  logStream.write(`cwd: ${cwd}\n\n`);

  proc.stdout?.on('data', (d: Buffer) => logStream.write(`[stdout] ${d}`));

  // Parse the WebSocket URL from bun's stderr output (includes a unique path token)
  const wsUrl = await parseWsUrl(proc, logStream, 10000);

  const session = new BunDebugSession({
    id, pid: proc.pid!, port, wsUrl, cwd, script, args, logFile, proc,
  });

  await session.connect();
  return session;
}

async function parseWsUrl(
  proc: ChildProcess,
  logStream: ReturnType<typeof createWriteStream>,
  timeout: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Timeout: bun inspector URL not found in stderr')), timeout);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      logStream.write(`[stderr] ${text}`);
      buf += text;
      // Match: ws://127.0.0.1:<port>/<token>
      const m = buf.match(/ws:\/\/[\w.]+:\d+\/\S+/);
      if (m) {
        clearTimeout(timer);
        proc.stderr?.off('data', onData);
        resolve(m[0]);
      }
    };

    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited (code ${code}) before inspector started`));
    });
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatRemoteObject(obj?: RemoteObject): string {
  if (!obj) return 'undefined';
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'null' || (obj.type === 'object' && obj.subtype === 'null')) return 'null';
  if (obj.type === 'string') return JSON.stringify(obj.value);
  if (obj.type === 'number' || obj.type === 'boolean' || obj.type === 'bigint') {
    return String(obj.value ?? obj.description);
  }
  if (obj.type === 'symbol') return obj.description ?? 'Symbol()';
  if (obj.type === 'function') {
    const desc = obj.description ?? '[Function]';
    // Truncate verbose function bodies to a one-liner
    const firstLine = desc.split('\n')[0].trim();
    return firstLine.length < desc.length ? `${firstLine}…` : firstLine;
  }
  if (obj.type === 'object') {
    const preview = (obj as { preview?: { properties?: Array<{ name: string; value: string }> } }).preview;
    if (preview?.properties) {
      const pairs = preview.properties.slice(0, 5).map(p => `${p.name}: ${p.value}`).join(', ');
      return `{${pairs}}`;
    }
    return obj.description ?? '[Object]';
  }
  return String(obj.value ?? obj.description ?? '?');
}
