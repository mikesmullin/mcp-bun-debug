// Simple test target for smoke-testing the debugger
const config = { host: 'localhost', port: 3000, debug: true };
const users = [
  { id: 1, name: 'Alice', role: 'admin' },
  { id: 2, name: 'Bob',   role: 'user'  },
];

function greet(user: { name: string; role: string }): string {
  const msg = `Hello, ${user.name}! (${user.role})`;
  return msg;
}

for (const user of users) {
  const greeting = greet(user);  // good breakpoint line
  console.log(greeting);
}

console.log('config:', config);
console.log('done');
