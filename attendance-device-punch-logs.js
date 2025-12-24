const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hdata.aspx') {
    let chunks = [];

    req.on('data', chunk => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks);
      
    
      const rawString = body.toString('utf8');

          const start = rawString.indexOf('{');
      const end = rawString.lastIndexOf('}');

      if (start !== -1 && end !== -1 && end > start) {
        const jsonPart = rawString.substring(start, end + 1);
        
        try {
          const log = JSON.parse(jsonPart);

          if (log.user_id && log.io_time) {
            console.log(`[PUNCH] User ID: ${log.user_id} | Time: ${log.io_time} | Mode: ${log.io_mode}`);
          } 
          else if (log.fk_info) {
             console.log(`[INFO] Device Heartbeat: ${log.fk_name}`);
          }
          else {
             console.log(`[DATA] Other JSON received:`, log);
          }

        } catch (e) {
          console.error('[ERROR] Could not parse extracted JSON:', e.message);
        }
      } else {
        console.log('[WARN] No JSON brackets found in request body.');
      }

    
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'response_code': 'OK',
        'Connection': 'close'
      });
      res.end('OK');
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(3000, () => {
  console.log('Server listening on port 3000');
});