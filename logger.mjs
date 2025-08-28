import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logFile = path.join(__dirname, 'network-errors.log');

export function logNetworkError(err, context = '') {
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}]${context ? ' ' + context : ''} ${err.stack || err.message || err}\n`;
  try {
    fs.appendFileSync(logFile, msg, 'utf-8');
  } catch (e) {
    console.error('⚠️  Konnte Logdatei nicht schreiben:', e.message);
  }
}

export function describeNetworkError(err) {
  const code = err.code || err.cause?.code;
  switch (code) {
    case 'ENOTFOUND':
      return 'Hostname konnte nicht aufgelöst werden (ENOTFOUND)';
    case 'ECONNREFUSED':
      return 'Verbindung abgelehnt (ECONNREFUSED)';
    case 'ECONNRESET':
      return 'Verbindung zurückgesetzt (ECONNRESET)';
    case 'ETIMEDOUT':
      return 'Zeitüberschreitung der Verbindung (ETIMEDOUT)';
    case 'ENETUNREACH':
      return 'Netzwerk nicht erreichbar (ENETUNREACH)';
    case 'EAI_AGAIN':
      return 'DNS-Lookup fehlgeschlagen (EAI_AGAIN)';
    default:
      return err.message || String(err);
  }
}

export function handleNetworkError(err, context = '') {
  logNetworkError(err, context);
  const detail = describeNetworkError(err);
  const prefix = context ? `❌ Netzwerkfehler bei ${context}:` : '❌ Netzwerkfehler:';
  console.error(prefix, detail);
}
