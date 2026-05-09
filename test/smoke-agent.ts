#!/usr/bin/env bun
/**
 * Smoke test against the real agent.coffee process.
 * Sets a breakpoint early in execution and reads variables.
 */
import { manager } from '../src/manager.js';

const CWD = '/workspace/agl-agents';
const SCRIPT = 'personal-email/agent.coffee';

console.log('=== agent.coffee smoke test ===\n');

console.log('1. Launching debug session for agent.coffee...');
const session = await manager.launch(CWD, SCRIPT, []);
const info = session.info();
console.log(`   session id: ${info.id}`);
console.log(`   pid: ${info.pid}  port: ${info.port}`);
console.log(`   log: ${info.logFile}`);
const loc0 = session.currentLocation();
console.log(`   paused at: ${loc0?.file}:${loc0?.line} in ${loc0?.function}()\n`);

// Set a breakpoint at agent.coffee:37 (Agent.default.model = _G.MODEL)
console.log('2. Setting breakpoint at personal-email/agent.coffee:37...');
try {
  const bp = await session.setBreakpoint('personal-email/agent.coffee', 37);
  console.log(`   breakpoint id: ${bp.breakpointId}`);
  console.log(`   resolved line: ${bp.resolvedLine}\n`);
} catch (e) {
  console.log(`   failed to set breakpoint: ${(e as Error).message}`);
  console.log('   Trying compiled output instead...\n');
}

// Continue to breakpoint (with a short timeout)
console.log('3. Continuing to breakpoint (30s timeout)...');
try {
  const paused = await session.resume();
  const loc = session.currentLocation();
  console.log(`   paused at: ${loc?.file}:${loc?.line} in ${loc?.function}()  (reason: ${paused.reason})\n`);

  console.log('4. Variables in scope:');
  const vars = await session.listScopeVariables();
  if (vars.length === 0) {
    console.log('   (none visible)');
  } else {
    for (const v of vars) {
      console.log(`   ${v.name}: ${v.type} = ${v.preview}`);
    }
  }
} catch (e) {
  console.log(`   ${(e as Error).message}`);
  console.log('   (process may be waiting for env vars or network)');
}

console.log('\n5. Quitting...');
session.quit();
console.log('   Done.\n');
console.log('=== agent smoke test DONE ===');
