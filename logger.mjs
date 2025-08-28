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
