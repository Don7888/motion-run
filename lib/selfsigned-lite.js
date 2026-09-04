// Self-signed certificate generator — pure Node, no dependencies, no openssl.
//
// LAN mode needs HTTPS (getUserMedia refuses to hand over the camera on a
// plain http:// origin that isn't localhost), and there is no certificate
// authority that will vouch for 192.168.x.x, so the server has to sign its
// own. Previously that meant the README asking you to run an openssl
// incantation by hand with your LAN IP pasted into it. Two problems with
// that: `certs/` was deliberately never committed (see README), so LAN mode
// couldn't start at all out of the box — and Windows doesn't ship openssl,
// so the documented command simply doesn't run there.
//
// Node can generate the KEY (crypto.generateKeyPairSync) but has no API for
// building a certificate, so the X.509 structure is assembled here as DER by
// hand. Same house style as lib/ws-lite.js and lib/qrcode-lite.js: a small,
// readable, dependency-free implementation of exactly the slice we need.
//
// Verified by round-tripping through Node's own TLS stack rather than by
// eyeballing the bytes: the test starts a real HTTPS server with a
// generated cert and connects to it BY IP with full verification on
// (`ca: [cert]`, and no rejectUnauthorized: false), so the handshake only
// completes if the signature, the validity dates and the subjectAltName
// are all genuinely correct.
'use strict';

const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------------
// Minimal DER encoding
// ---------------------------------------------------------------------
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, payload) {
  return Buffer.concat([Buffer.from([tag]), len(payload.length), payload]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));

function int(buf) {
  // DER integers are signed, so a leading byte >= 0x80 needs a 0x00 pad or
  // it would be read as negative.
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0x00 && (b[i + 1] & 0x80) === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const bytes = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    if (n === 0) { bytes.push(0); continue; }
    const chunk = [];
    let v = n;
    while (v > 0) { chunk.unshift(v & 0x7f); v >>>= 7; }
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const nullDer = Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octet = (buf) => tlv(0x04, buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const explicit = (n, payload) => tlv(0xa0 | n, payload);

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate())
    + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// ---------------------------------------------------------------------
// Certificate assembly
// ---------------------------------------------------------------------
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';
const OID_SAN = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const algSha256Rsa = seq(oid(OID_SHA256_RSA), nullDer);

function name(commonName) {
  return seq(set(seq(oid(OID_CN), utf8(commonName))));
}

// GeneralName: dNSName is [2] IA5String, iPAddress is [7] OCTET STRING.
function generalNames(hosts) {
  const parts = hosts.map((h) => {
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (ipv4) {
      return tlv(0x87, Buffer.from(ipv4.slice(1, 5).map(Number)));
    }
    return tlv(0x82, Buffer.from(h, 'ascii'));
  });
  return seq(...parts);
}

function extensions(hosts) {
  const ext = (id, critical, value) => (critical
    ? seq(oid(id), bool(true), octet(value))
    : seq(oid(id), octet(value)));
  return explicit(3, seq(
    ext(OID_BASIC_CONSTRAINTS, true, seq(bool(false))),
    ext(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
    ext(OID_SAN, false, generalNames(hosts)),
  ));
}
/**
 * Generates a self-signed certificate valid for every host in `hosts`
 * (IPv4 literals and DNS names both allowed).
 * Returns { key, cert } as PEM strings.
 */
function generate(hosts, opts) {
  const options = opts || {};
  const days = options.days || 825; // under the 825-day cap browsers enforce
  const commonName = options.commonName || hosts[0] || 'localhost';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const now = new Date();
  // Backdate slightly so a device with a skewed clock doesn't reject it as
  // not-yet-valid — Fire TV sticks are not famous for accurate clocks.
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),        // version v3
    int(crypto.randomBytes(16)),               // serial
    algSha256Rsa,
    name(commonName),                          // issuer == subject (self-signed)
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(commonName),
    spki,
    extensions(hosts),
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, algSha256Rsa, bitString(signature));

  const pem = (der, label) => {
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
  };

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem(cert, 'CERTIFICATE'),
    hosts,
    notAfter,
  };
}

/** Every non-internal IPv4 address on this machine. */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/**
 * True if `pem` is a certificate that is still valid and covers every one of
 * `hosts` — used to decide whether an existing cert can be reused. Reusing
 * matters: browsers remember the security exception you clicked for a
 * specific certificate, so regenerating on every boot would mean clicking
 * through the warning on the TV and the phone every single time.
 */
function certCovers(pem, hosts) {
  try {
    const x = new crypto.X509Certificate(pem);
    if (new Date(x.validTo) < new Date()) return false;
    const san = x.subjectAltName || '';
    return hosts.every((h) => san.includes(`IP Address:${h}`) || san.includes(`DNS:${h}`));
  } catch {
    return false;
  }
}

module.exports = { generate, lanAddresses, certCovers };
