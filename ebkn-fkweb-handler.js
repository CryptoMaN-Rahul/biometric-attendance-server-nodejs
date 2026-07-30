// Reference handler for the EBKN "FkWeb" protocol variant — Secureye S-FB6K /
// S-FB3K, Realand BIOFACE M61BH/M60 firmware (fk_bin_data_lib: M50).
//
// This is a DIFFERENT wire format from FKDataHS102 (attendance-device-punch-logs.js):
//   - posts an absolute URI ("POST http://<host> HTTP/1.0") with NO path, not /hdata.aspx
//   - identifies itself with `request_code` / `dev_id` / `trans_id` headers, not `cmd_id`
//   - the ack MUST be an empty body with `response_code: OK` as a HEADER — a JSON
//     or text body makes the device retransmit the same event forever
//   - supports a real bidirectional command channel via `receive_cmd` polling
//
// See README.md "EBKN FkWeb Variant" section for the full writeup, including the
// reverse-proxy gotcha that cost the most time to find.

const http = require('http');

// Any command queued here gets injected on the device's next `receive_cmd` poll
// (~every 3s). Do NOT queue CLEAR_ENROLL_DATA / CLEAR_LOG_DATA / CLEAR_ALL_ADMIN —
// they execute immediately with an empty body and are irreversible.
const commandQueue = [];

function formatCommandBody(bodyValue) {
  if (bodyValue == null) return Buffer.alloc(0);
  const json = Buffer.from(JSON.stringify(bodyValue), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(json.length, 0);
  return Buffer.concat([prefix, json, Buffer.from([0])]);
}

// FkWeb bodies are `4-byte LE length prefix + JSON + binary template blobs`.
// Anchoring on the last `}` (a common shortcut) fails here — it lands inside
// the binary tail on enrollment pushes. Track brace depth instead.
function extractJson(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(str.substring(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function sendAck(res, transId, { cmdCode = null, body = null } = {}) {
  const payload = body || Buffer.alloc(0);
  const headers = {
    'Content-Type': 'application/octet-stream',
    response_code: 'OK',
    'Content-Length': String(payload.length),
    Connection: 'close',
  };
  if (transId) headers.trans_id = transId;
  if (cmdCode) headers.cmd_code = cmdCode;
  res.writeHead(200, headers);
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const requestCode = req.headers['request_code'];
  const devId = req.headers['dev_id'];
  const transId = req.headers['trans_id'] || null;

  if (!requestCode) {
    res.writeHead(404);
    return res.end();
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1'); // latin1 keeps binary bytes intact for the brace scan
    const parsed = extractJson(body);

    switch (requestCode) {
      case 'realtime_glog': // attendance punch
        console.log(`[PUNCH] dev=${devId} user=${parsed?.user_id} time=${parsed?.io_time} io_mode=${parsed?.io_mode}`);
        return sendAck(res, transId);

      case 'realtime_enroll_data': // user push — the only channel with names; templates follow as binary, not reassembled here
        if (parsed?.user_name) console.log(`[ENROLL] dev=${devId} user=${parsed.user_id} name=${parsed.user_name}`);
        return sendAck(res, transId);

      case 'receive_cmd': { // device polls for work every ~3s
        console.log(`[POLL] dev=${devId} firmware=${parsed?.fk_info?.firmware || '?'}`);
        const queued = commandQueue.shift();
        if (queued) {
          return sendAck(res, `cmd${Date.now()}`, {
            cmdCode: queued.cmd_code,
            body: formatCommandBody(queued.body ?? null),
          });
        }
        return sendAck(res, transId); // empty body = "no command, keep polling"
      }

      case 'send_cmd_result': // device reporting outcome of an injected command
        console.log(`[CMD_RESULT] dev=${devId} trans_id=${transId} ret=${req.headers['cmd_return_code']}`);
        return sendAck(res, transId);

      default:
        return sendAck(res, transId);
    }
  });
});

server.listen(80, () => console.log('EBKN FkWeb reference server listening on :80'));

module.exports = { commandQueue };
