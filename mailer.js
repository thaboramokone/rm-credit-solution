// A minimal SMTP client implemented directly over net/tls sockets — no
// nodemailer or other package needed. Speaks just enough SMTP (EHLO,
// STARTTLS, AUTH LOGIN, MAIL FROM/RCPT TO/DATA) to send a plain-text email
// through Outlook/Office365's SMTP relay using the AdminRM@outlook.com
// mailbox you create yourself.
//
// If SMTP_USER/SMTP_PASS aren't set in the environment, sendMail() falls
// back to logging the message to the server console instead of throwing —
// so the app still works end-to-end before you've wired up real email,
// the same way the in-app "demo mode" banner worked in the prototype.

const net = require("net");
const tls = require("tls");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const FROM_ADDRESS = process.env.SMTP_FROM || SMTP_USER;

// Reads SMTP responses off a socket via a single persistent listener and a
// FIFO queue of pending reads, rather than attaching/detaching a fresh
// listener per read. This matters specifically because of the mid-stream
// STARTTLS upgrade: attaching one-shot listeners repeatedly around a TLS
// record boundary is a known source of duplicate/out-of-order delivery in
// Node, since a single TLS record can decrypt into more application data
// than one logical response. A persistent buffer + explicit response-
// boundary parser sidesteps that entirely.
class SmtpReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = "";
    this.queue = [];
    this._onData = (chunk) => {
      this.buf += chunk.toString("utf8");
      this._drain();
    };
    this._onError = (err) => {
      while (this.queue.length) {
        const w = this.queue.shift();
        clearTimeout(w.timer);
        w.reject(err);
      }
    };
    socket.on("data", this._onData);
    socket.on("error", this._onError);
  }

  // Finds the end (exclusive index, i.e. just past the trailing CRLF) of
  // the first complete SMTP response in this.buf, handling multiline
  // responses ("250-...\r\n250-...\r\n250 ...\r\n"). Returns -1 if the
  // buffer doesn't yet contain a full response.
  _findResponseEnd() {
    let pos = 0;
    for (;;) {
      const nl = this.buf.indexOf("\r\n", pos);
      if (nl === -1) return -1;
      const line = this.buf.slice(pos, nl);
      if (/^\d{3} /.test(line)) return nl + 2; // final line of the response
      if (!/^\d{3}-/.test(line)) return nl + 2; // not well-formed; don't hang forever
      pos = nl + 2; // continuation line, keep scanning
    }
  }

  _drain() {
    while (this.queue.length) {
      const end = this._findResponseEnd();
      if (end === -1) return;
      const responseText = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      const waiter = this.queue.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(responseText);
    }
  }

  read(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i !== -1) this.queue.splice(i, 1);
        reject(new Error("SMTP timeout waiting for response"));
      }, timeoutMs);
      this.queue.push(entry);
      this._drain();
    });
  }

  stop() {
    this.socket.removeListener("data", this._onData);
    this.socket.removeListener("error", this._onError);
  }
}

function expectCode(response, code) {
  if (!response.startsWith(String(code))) {
    throw new Error(`SMTP: expected ${code}, got: ${response.trim()}`);
  }
}

function writeCmd(socket, cmd) {
  socket.write(cmd + "\r\n");
}

async function sendViaSmtp({ to, subject, text }) {
  const socket = net.connect(SMTP_PORT, SMTP_HOST);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const plainReader = new SmtpReader(socket);
  try {
    expectCode(await plainReader.read(), 220);

    writeCmd(socket, "EHLO localhost");
    await plainReader.read();

    writeCmd(socket, "STARTTLS");
    expectCode(await plainReader.read(), 220);
  } finally {
    plainReader.stop();
  }

  const secureSocket = await new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: SMTP_HOST }, () => resolve(s));
    s.once("error", reject);
  });
  const secureReader = new SmtpReader(secureSocket);

  try {
    writeCmd(secureSocket, "EHLO localhost");
    await secureReader.read();

    writeCmd(secureSocket, "AUTH LOGIN");
    expectCode(await secureReader.read(), 334);

    writeCmd(secureSocket, Buffer.from(SMTP_USER).toString("base64"));
    expectCode(await secureReader.read(), 334);

    writeCmd(secureSocket, Buffer.from(SMTP_PASS).toString("base64"));
    expectCode(await secureReader.read(), 235);

    writeCmd(secureSocket, `MAIL FROM:<${FROM_ADDRESS}>`);
    expectCode(await secureReader.read(), 250);

    writeCmd(secureSocket, `RCPT TO:<${to}>`);
    expectCode(await secureReader.read(), 250);

    writeCmd(secureSocket, "DATA");
    expectCode(await secureReader.read(), 354);

    const headers = [
      `From: ${FROM_ADDRESS}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
    ].join("\r\n");
    // Per RFC 5321, lines consisting of a single "." must be escaped by
    // doubling the leading dot, and the message is terminated by a line
    // containing only a single ".".
    const escapedBody = text.replace(/\r\n\./g, "\r\n..").replace(/\n\./g, "\n..");
    writeCmd(secureSocket, `${headers}\r\n\r\n${escapedBody}\r\n.`);
    expectCode(await secureReader.read(), 250);

    writeCmd(secureSocket, "QUIT");
  } finally {
    secureReader.stop();
    secureSocket.end();
  }
}

async function sendMail({ to, subject, text }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log(
      `\n[mailer] SMTP not configured — not actually sending email.\n` +
        `[mailer] To: ${to}\n[mailer] Subject: ${subject}\n[mailer] Body:\n${text}\n`
    );
    return { sent: false, reason: "smtp-not-configured" };
  }
  await sendViaSmtp({ to, subject, text });
  return { sent: true };
}

module.exports = { sendMail };
