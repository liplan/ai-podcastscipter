// test-openai.mjs
import 'dotenv/config';       // lädt automatisch deine .env Datei
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // wird jetzt aus .env geladen
});

async function main() {
  try {
    const response = await client.models.list();
    console.log("Verbindung erfolgreich ✅");
    console.log("Modelle:", response.data.map(m => m.id).slice(0, 5));
  } catch (err) {
    console.error("Fehler bei der Verbindung ❌");
    console.error(err);
  }
}

main();
