const http = require('http');
const url = 'http://localhost:8000/live/li.flv';
let total = 0, chunks = 0;
const start = Date.now();
http.get(url, (res) => {
  console.log(`HTTP ${res.statusCode}`);
  res.on('data', (buf) => { total += buf.length; chunks++; });
  res.on('end', () => console.log(`stream ended after ${((Date.now()-start)/1000).toFixed(1)}s`));
}).on('error', (e) => console.error(e.message));
const timer = setInterval(() => {
  const dt = (Date.now() - start) / 1000;
  console.log(`[+${dt.toFixed(1)}s] ${total} bytes, ${chunks} chunks, ${(total / dt / 1024).toFixed(1)} KB/s`);
}, 1000);
setTimeout(() => { clearInterval(timer); process.exit(0); }, 12000);
