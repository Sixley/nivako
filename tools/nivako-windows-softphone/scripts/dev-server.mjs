import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createServer as createViteServer } from "vite";

const defaultSecretFile = "/root/.hermes/secrets/openclaw/nivako/nextcloud-carddav-linphone-app-password-2026-07-01.env";
const certDir = "/tmp/nivako-windows-softphone-cert";
const certFile = `${certDir}/cert.pem`;
const keyFile = `${certDir}/key.pem`;

function parseEnvFile(path) {
  if (!path || !fs.existsSync(path)) return {};
  return Object.fromEntries(
    fs.readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^["']|["']$/g, "")];
      })
  );
}

function cardDavConfig() {
  const fileValues = parseEnvFile(process.env.NIVAKO_CARDDAV_ENV || defaultSecretFile);
  return {
    url: process.env.NEXTCLOUD_CARDDAV_URL || fileValues.NEXTCLOUD_CARDDAV_URL,
    username: process.env.NEXTCLOUD_CARDDAV_USERNAME || fileValues.NEXTCLOUD_CARDDAV_USERNAME,
    password: process.env.NEXTCLOUD_CARDDAV_APP_PASSWORD || process.env.NEXTCLOUD_CARDDAV_PASSWORD || fileValues.NEXTCLOUD_CARDDAV_APP_PASSWORD || fileValues.NEXTCLOUD_CARDDAV_PASSWORD
  };
}

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function ensureCertificate() {
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return {
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile)
    };
  }

  fs.mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "30",
    "-subj",
    "/CN=65.21.178.102",
    "-addext",
    "subjectAltName=IP:65.21.178.102,DNS:localhost,IP:127.0.0.1"
  ], { stdio: "ignore" });

  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile)
  };
}

async function syncCardDav() {
  const config = cardDavConfig();
  if (!config.url || !config.username || !config.password) {
    const error = new Error("CardDAV credentials missing");
    error.status = 503;
    throw error;
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag />
    <card:address-data />
  </d:prop>
</card:addressbook-query>`;

  const response = await fetch(config.url, {
    method: "REPORT",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1"
    },
    body
  });

  const xml = await response.text();
  if (!response.ok && response.status !== 207) {
    const error = new Error(`CardDAV HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }

  return xml;
}

const vite = await createViteServer({
  server: {
    middlewareMode: true
  }
});

const host = "0.0.0.0";
const port = Number(process.env.PORT || 5179);
const httpsPort = Number(process.env.HTTPS_PORT || 5443);

async function requestHandler(req, res) {
  try {
    if (req.url === "/api/carddav/contacts") {
      const xml = await syncCardDav();
      writeJson(res, 200, { ok: true, xml, syncedAt: new Date().toISOString() });
      return;
    }

    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  } catch (error) {
    writeJson(res, error.status || 500, {
      ok: false,
      message: error instanceof Error ? error.message : "CardDAV sync failed"
    });
  }
}

const server = http.createServer(requestHandler);
const secureServer = https.createServer(ensureCertificate(), requestHandler);

server.listen(port, host, () => {
  console.log(`  ➜  Local:   http://localhost:${port}/`);
  console.log(`  ➜  Network: http://65.21.178.102:${port}/`);
});

secureServer.listen(httpsPort, host, () => {
  console.log(`  ➜  Local HTTPS:   https://localhost:${httpsPort}/`);
  console.log(`  ➜  Network HTTPS: https://65.21.178.102:${httpsPort}/`);
});
