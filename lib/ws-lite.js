// ws-lite.js — a minimal, dependency-free WebSocket server (RFC 6455).
//
// This project's sandbox build environment can't reach the npm registry,
// so instead of depending on the `ws` package, this file implements just
// enough of the protocol to run our small JSON control-message relay:
// the opening handshake, text-frame parsing (with basic fragmentation
// support), ping/pong, and close. It is NOT a general-purpose WebSocket
// library — for a production build, swap this out for `ws` or `socket.io`
// once you have normal npm access (see README).

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = WSConnection.OPEN;
    this._recvBuffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentsOpcode = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  _onData(chunk) {
    this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);
    // Parse as many complete frames as are available.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frame = this._tryParseFrame(this._recvBuffer);
      if (!frame) return;
      this._recvBuffer = this._recvBuffer.subarray(frame.totalLength);
      this._handleFrame(frame);
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    return { fin, opcode, payload, totalLength: offset + len };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OPCODE.CLOSE) {
      this._sendRaw(this._encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
      this.socket.end();
      return;
    }
    if (opcode === OPCODE.PING) {
      this._sendRaw(this._encodeFrame(OPCODE.PONG, payload));
      return;
    }
    if (opcode === OPCODE.PONG) return;

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      this._fragments = [payload];
      this._fragmentsOpcode = opcode;
    } else if (opcode === OPCODE.CONTINUATION) {
      this._fragments.push(payload);
    }

    if (fin && this._fragmentsOpcode !== null) {
      const full = Buffer.concat(this._fragments);
      this._fragments = [];
      this._fragmentsOpcode = null;
      this.emit('message', full.toString('utf8'));
    }
  }

  _encodeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = len; // no mask from server
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  _sendRaw(buf) {
    if (this.socket.writable) this.socket.write(buf);
  }

  send(data) {
    if (this.readyState !== WSConnection.OPEN) return;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    this._sendRaw(this._encodeFrame(OPCODE.TEXT, payload));
  }

  close() {
    if (this.readyState !== WSConnection.OPEN) return;
    this.readyState = WSConnection.CLOSED;
    this._sendRaw(this._encodeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    this.socket.end();
  }

  _onClose() {
    if (this.readyState === WSConnection.CLOSED) return;
    this.readyState = WSConnection.CLOSED;
    this.emit('close');
  }
}
WSConnection.OPEN = 1;
WSConnection.CLOSED = 3;

class WSServer extends EventEmitter {
  /** @param {{server: import('http').Server}} opts */
  constructor(opts) {
    super();
    this.httpServer = opts.server;
    this.httpServer.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
  }

  _onUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    // Disable Nagle's algorithm. Without this, Node's default TCP behavior
    // can hold small writes (like our tiny JSON control/input messages) for
    // up to ~40ms waiting to coalesce them with more data or an ACK — real,
    // perceptible lag for a realtime "your movement -> the character moves"
    // loop where every message is small and latency-sensitive. This is the
    // same fix the `ws` package applies by default.
    socket.setNoDelay(true);
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n');
    socket.write(responseHeaders);

    const ws = new WSConnection(socket);
    if (head && head.length) ws._onData(head);
    this.emit('connection', ws, req);
  }
}

module.exports = { WSServer, WSConnection };
