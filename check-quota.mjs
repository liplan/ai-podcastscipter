import 'dotenv/config';

// kleine Helper:
const authHeaders = {
  Authorization: `Bearer ${process.env.OPENAI_ADMIN_KEY}`,
  'Content-Type': 'application/json',
};
const nowSec = Math.floor(Date.now() / 1000);
const days = (n) => n * 24 * 60 * 60;

// === 1) Usage: Completions (Tokens/Requests), gruppiert nach Model & Project ===
async function fetchUsage({ daysBack = 7, groupBy = ['model', 'project_id'] } = {}) {
  const url = new URL('https://api.openai.com/v1/organization/usage/completions');
  url.searchParams.set('start_time', String(nowSec - days(daysBack)));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', '30');
  if (groupBy?.length) url.searchParams.set('group_by', groupBy.join(','));

  // Optional: gezielt auf ein Project oder Org-weit
  if (process.env.OPENAI_PROJECT_ID) url.searchParams.append('project_ids', process.env.OPENAI_PROJECT_ID);

  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) throw new Error(`Usage API ${res.status}`);
  const { data = [] } = await res.json();
  return data;
}

// === 2) Costs: Tageskosten (zeigt dir, ob überhaupt Guthaben verbraucht wird) ===
async function fetchCosts({ daysBack = 30 } = {}) {
  const url = new URL('https://api.openai.com/v1/organization/costs');
  url.searchParams.set('start_time', String(nowSec - days(daysBack)));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', '30');
  // Optional: project_ids Filter analog oben

  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) throw new Error(`Costs API ${res.status}`);
  const { data = [] } = await res.json();
  return data;
}

function sumCostsUSD(buckets) {
  let total = 0;
  for (const b of buckets) {
    for (const r of (b.results || [])) total += (r.amount?.value || 0);
  }
  return total;
}

function sumRequests(buckets) {
  let total = 0;
  for (const b of buckets) {
    for (const r of (b.results || [])) total += (r.num_model_requests || 0);
  }
  return total;
}

(async () => {
  try {
    // Kosten der letzten 30 Tage
    const costs = await fetchCosts({ daysBack: 30 });
    const usd30d = sumCostsUSD(costs);
    console.log(`💸 Kosten letzte 30 Tage: $${usd30d.toFixed(4)} USD`);

    // Nutzung der letzten 7 Tage
    const usage = await fetchUsage({ daysBack: 7, groupBy: ['model', 'project_id'] });
    const requests7d = sumRequests(usage);
    console.log(`📈 Requests letzte 7 Tage: ${requests7d}`);

    // Schnelle Heuristik für dein Problem:
    if (usd30d === 0 && requests7d === 0) {
      console.log('⚠️ Keine erkennbare Nutzung/Kosten. Prüfe, ob der verwendete API-Key zur gleichen Org/Project gehört wie dieser Admin-Key.');
    } else {
      console.log('✅ Usage/Costs vorhanden – damit kannst du die richtige Org/Project-Zuordnung verifizieren.');
    }
  } catch (e) {
    console.error('❌ Fehler bei der Quota-/Usage-Abfrage:', e.message);
    console.error('Tipp: Du brauchst einen **Admin API Key** für diese Endpunkte.');
  }
})();
