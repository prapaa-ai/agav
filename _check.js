const fs = require('fs');
const c = fs.readFileSync('source/components/agents-create.tsx', 'utf8');
const i = c.indexOf('Registering agent');
console.log(JSON.stringify(c.substring(i-10, i+200)));
