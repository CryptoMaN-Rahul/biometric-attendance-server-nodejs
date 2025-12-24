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
