# Biometric Attendance Server (Node.js)

A high-performance Node.js middleware server designed to interface with biometric attendance devices (Biomax, ZKTeco, RealAnd, FK-Series) using the **FK Web Protocol**. This server acts as a bridge, parsing proprietary binary/JSON hybrid payloads and storing clean attendance data into Firebase Firestore.

## 🚀 Overview

Many biometric devices use a variation of the ADMS/FK protocol which communicates over HTTP but follows non-standard behaviors. This project solves the common pitfalls of "Connection Refused", "Infinite Loops", and "Data Mapping" issues that occur when using standard web servers.

---

## 🛠 Technical Challenges & Solutions

### 1. The "Connection Refused" (404 Not Found)
**Problem:** The device shows "Network OK" but no data reaches the server.
**Discovery:** Using `tcpdump`, we found the device is hardcoded to `POST /hdata.aspx`. Most modern frameworks expect RESTful routes.
**Solution:** Implemented a specific handler for `/hdata.aspx` and configured the server to handle `application/octet-stream` via raw buffer processing.

### 2. The Infinite Data Loop
**Problem:** The device sends the same attendance record every few seconds, never clearing its internal memory.
**Root Cause:** The device requires a specific **Acknowledgement (ACK)** string and a strict **Connection: close** header. If it receives a standard HTTP 200 without these, it assumes the packet was lost and retries indefinitely.
**Solution:**
- Differentiated responses: `result=OK` for logs/enrollments and `OK` for heartbeats.
- Forced `Connection: close` to tell the device the transaction is complete.
- Stripped unnecessary headers (`Date`, `ETag`, `X-Powered-By`) that legacy firmware often chokes on.

### 3. Indistinguishable Punch Modes
**Problem:** Every punch (Check-In, Check-Out, Break) arrived with the same raw code `16777216`.
**Discovery:** The `io_mode` is a **Bitmask Integer**, not a simple index. Pressing F1/F2 keys changes these bits.
**Solution:** Decoded the bitmask values through real-time `tcpdump` analysis during physical device testing.

---

## 📊 Data Mapping (FKDataHS102)

| Device Action | Raw `io_mode` | Mapped Status |
| :--- | :--- | :--- |
| **Default / F1** | `16777216` | Check-In |
| **F2 / Right Arrow** | `33554432` | Check-Out |
| **Break In** | `50331648` | Break-In |
| **Break Out** | `67108864` | Break-Out |
| **Overtime In** | `83886080` | Overtime-In |
| **Overtime Out** | `100663296` | Overtime-Out |

---

## 📡 Protocol Analysis

- **Target URL:** `/hdata.aspx`
- **Content-Type:** `application/octet-stream`
- **Payload:** Hybrid (Binary Header + JSON String)
- **Handshake:** HTTP/1.1 or 1.0 (requires strict closure)
- **Headers:** `cmd_id` (Action type), `dev_id` (Serial Number)

---

---

## 🔀 EBKN FkWeb Variant (Secureye S-FB6K / S-FB3K, Realand BIOFACE M60/M61BH)

A second FK-family device (`fk_bin_data_lib: M50`, firmware `M60 v3.16.1286s`) turned out to speak a **different** dialect from the `FKDataHS102` variant above. Reference handler: [`ebkn-fkweb-handler.js`](ebkn-fkweb-handler.js).

| | FKDataHS102 (above) | EBKN FkWeb |
|---|---|---|
| Request line | `POST /hdata.aspx` | `POST http://<host> HTTP/1.0` — **absolute URI, no path** |
| Identifies itself via | `cmd_id` header | `request_code` / `dev_id` / `trans_id` headers |
| Ack shape | text body `OK` / `result=OK` | **empty body**, `response_code: OK` as a **response header** |
| Command channel | none | `receive_cmd` — device polls every ~3s, bidirectional |

### The bug that cost the most time: reverse proxies eat the identity headers

The device was sending a perfectly correct request the entire time — a `tcpdump -i any -A "tcp port 80 and host <device-ip>"` capture proved it:

```
POST http://<server> HTTP/1.0
Content-Type: application/octet-stream
request_code: receive_cmd
dev_id: 102026020002170
trans_id: 330
Content-Length: 171

{"fk_name":"M60","fk_time":"...","fk_info":{...,"fk_bin_data_lib":"M50","firmware":"M60 v3.16.1286s"}}
```

But behind an Nginx/Caddy reverse proxy, the app only ever saw `host`, `content-type`, `content-length` — **`request_code`, `dev_id`, and `trans_id` were silently gone.** Both proxies strip headers containing underscores by default (Nginx needs `underscore_in_headers on;`; Caddy has no equivalent directive at all — tested by mirroring the raw header into a synthetic response header and it arrived empty, proving the proxy never parses it in the first place).

Symptom if you hit this: every request looks like `UNKNOWN` protocol, the device gets a random fallback ID instead of its real serial, and you can't tell a punch from a heartbeat.

**Fix:** don't proxy this device. Terminate its connection directly in the app (bind `:80` yourself, or run it on a dedicated port and NAT that port straight to the app, bypassing the proxy layer).

### `request_code` values observed

| `request_code` | Meaning | Ack |
|---|---|---|
| `realtime_glog` | attendance punch | ack only |
| `realtime_enroll_data` | user push (name, privilege) — arrives as one JSON block + ~30 pure-binary continuation blocks (template + a JFIF photo). This is the **only** channel that carries the user's name | ack only |
| `receive_cmd` | device polling for work, ~3s interval | ack, or inject a queued command |
| `send_cmd_result` | device reporting `cmd_return_code` for a command you injected | ack only |

Body framing is `4-byte little-endian length prefix + JSON + binary blobs` — extracting JSON by matching the last `}` in the payload breaks on `realtime_enroll_data`, because that lands inside the binary tail. Scan brace depth instead (see `extractJson` in the reference handler).

### Command injection

Reply to a `receive_cmd` poll with a non-empty `cmd_code` header to make the device execute it:

```js
commandQueue.push({ cmd_code: 'GET_USER_ID_LIST' });
commandQueue.push({ cmd_code: 'SET_TIME', body: { time: '20260730164712' } }); // YYYYMMDDHHMMSS
```

`GET_USER_ID_LIST`, `GET_USER_INFO`, `GET_DEVICE_STATUS`, `GET_LOG_DATA`, and `SET_TIME` are confirmed working. `OPEN_DOOR` is recognized but its body shape is unsolved (`ERROR_INVALID_PARAM` on every variant tried).

> 💀 **`CLEAR_ENROLL_DATA` / `CLEAR_LOG_DATA` / `CLEAR_ALL_ADMIN` take an empty body, execute instantly, and are irreversible.** Never queue them to probe what they do.

### PIN format

`user_id` arrives zero-padded to 8 digits (`"00000001"`). If you're mapping to an external system by PIN, normalize it (`String(Number(userId))`) — the padded and unpadded forms will not match.

---

## 📦 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/CryptoMaN-Rahul/biometric-attendance-server-nodejs
   cd biometric-attendance-server-nodejs
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Firebase Setup:**
   - Create a Firebase project.
   - Download your `serviceAccountKey.json`.
   - Update the code with your database reference.

---

## 🔍 Debugging Commands

To see exactly what the device is sending in real-time:

**Monitor Raw Traffic:**
```bash
sudo tcpdump -i any port 3000 -A -s 0
```

**Filter for Specific Actions:**
```bash
sudo tcpdump -i any port 3000 -A -s 0 -l | grep --line-buffered -A 10 "RTLogSendAction"
```

---

## 📜 Final Code Logic

The server handles requests by:
1. Buffering the binary stream.
2. Extracting the JSON payload using `{}` delimiters.
3. Mapping the `io_mode` to a readable status.
4. Sending the correct ACK to clear the device buffer.

```javascript
// Critical ACK Logic
res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Connection': 'close'
});
res.end(responseText); // "result=OK" or "OK"
```
