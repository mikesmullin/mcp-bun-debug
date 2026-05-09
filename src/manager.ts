import { randomBytes } from 'crypto';
import { BunDebugSession, launchSession } from './debugger.js';

function makeId(): string {
  return randomBytes(3).toString('hex'); // 6 hex chars
}

function pickPort(): number {
  // Ephemeral range above well-known ports; collisions are rare enough for a dev tool
  return 40000 + Math.floor(Math.random() * 10000);
}

class SessionManager {
  private sessions = new Map<string, BunDebugSession>();

  async launch(cwd: string, script: string, args: string[]): Promise<BunDebugSession> {
    const id = makeId();
    const port = pickPort();
    const session = await launchSession({ id, cwd, script, args, port });
    this.sessions.set(id, session);
    // Auto-remove when process exits
    session['proc'].on('exit', () => this.sessions.delete(id));
    return session;
  }

  list(): BunDebugSession[] {
    return [...this.sessions.values()].filter(s => s.state !== 'exited');
  }

  get(id: string): BunDebugSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No session with id "${id}"`);
    if (s.state === 'exited') throw new Error(`Session "${id}" has exited`);
    return s;
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (s) { s.quit(); this.sessions.delete(id); }
  }
}

export const manager = new SessionManager();
