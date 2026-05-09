#!/usr/bin/env bun
/**
 * Smoke test: launch test-target.ts under the debugger, set a breakpoint,
 * step through, and read variables.
 */
import { manager } from '../src/manager.js';

const CWD = import.meta.dir;
const SCRIPT = 'test-target.ts';

console.log('=== mcp-bun-debug smoke test ===\n');

// 1. Launch
console.log('1. Launching debug session...');
const session = await manager.launch(CWD, SCRIPT, []);
const info = session.info();
console.log(`   session id: ${info.id}`);
console.log(`   pid: ${info.pid}  port: ${info.port}`);
console.log(`   log: ${info.logFile}`);
const loc0 = session.currentLocation();
console.log(`   paused at: ${loc0?.file}:${loc0?.line} in ${loc0?.function}()\n`);

// 2. Set breakpoint at the greet() call inside the loop
console.log('2. Setting breakpoint at test-target.ts:12...');
const bp = await session.setBreakpoint('test-target.ts', 12);
console.log(`   breakpoint id: ${bp.breakpointId}`);
console.log(`   resolved line: ${bp.resolvedLine}\n`);

// 3. Continue to breakpoint
console.log('3. Continuing to breakpoint...');
const paused1 = await session.resume();
const loc1 = session.currentLocation();
console.log(`   paused at: ${loc1?.file}:${loc1?.line} in ${loc1?.function}()  (reason: ${paused1.reason})\n`);

// 4. List variables
console.log('4. Variables in scope:');
const vars = await session.listScopeVariables();
for (const v of vars) {
  console.log(`   ${v.name}: ${v.type} = ${v.preview}`);
}
console.log();

// 5. Get specific variable
console.log('5. Getting specific variables...');
const greeting = await session.getVariable('greeting');
console.log(`   greeting = ${greeting}`);
const user = await session.getVariable('user');
console.log(`   user = ${user}\n`);

// 6. Step into greet()
console.log('6. Stepping into greet()...');
const paused2 = await session.stepInto();
const loc2 = session.currentLocation();
console.log(`   paused at: ${loc2?.file}:${loc2?.line} in ${loc2?.function}()  (reason: ${paused2.reason})\n`);

// 7. Read 'msg' variable inside greet
console.log('7. Variables inside greet():');
const vars2 = await session.listScopeVariables();
for (const v of vars2) {
  console.log(`   ${v.name}: ${v.type} = ${v.preview}`);
}
console.log();

// 8. Step out and continue second iteration
console.log('8. Stepping out of greet()...');
const paused3 = await session.stepOut();
const loc3 = session.currentLocation();
console.log(`   paused at: ${loc3?.file}:${loc3?.line} in ${loc3?.function}()  (reason: ${paused3.reason})\n`);

// 9. Modify a variable
console.log('9. Setting user.name = "Charlie"...');
const newVal = await session.setVariable('user', '{ ...user, name: "Charlie" }');
console.log(`   user = ${newVal}`);
const greeting2 = await session.evaluate('`Hello, ${user.name}!`');
console.log(`   greeting preview: ${greeting2}\n`);

// 10. Quit
console.log('10. Quitting session...');
session.quit();
console.log('    Done.\n');

console.log('=== smoke test PASSED ===');
