const fs = require('fs');
try {
  const c = fs.readFileSync('C:\\Users\\Acer\\repos\\a\\agav\\source\\components\\agents-create.tsx', 'utf8');
  const idx = c.indexOf('Registering');
  console.log('MAIN REPO idx:', idx);
  if (idx >= 0) {
    console.log(JSON.stringify(c.substring(idx-10, idx+200)));
  }
} catch(e) {
  console.log('MAIN REPO error:', e.message);
}
