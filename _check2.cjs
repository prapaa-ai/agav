const fs = require('fs');
const c = fs.readFileSync('C:\\Users\\Acer\\repos\\a\\agav\\.agav-worktrees\\sa-3\\source\\components\\agents-create.tsx', 'utf8');

// Find and show exact bytes around "Registering"
const idx = c.indexOf('Registering');
const snippet = c.substring(idx - 30, idx + 180);
// Show char codes for first 50 chars
const codes = [];
for (let i = 0; i < Math.min(snippet.length, 210); i++) {
  const ch = snippet.charCodeAt(i);
  if (ch === 9) codes.push('TAB');
  else if (ch === 10) codes.push('LF');
  else if (ch === 13) codes.push('CR');
  else if (ch === 32) codes.push('SP');
  else codes.push(snippet[i]);
}
console.log(codes.join(' '));
