// Read-only ScraperAPI account status — credits used / limit / renewal date.
// Shown on the TM Watch screen so credit surprises never happen again.
// Exposes only harmless usage numbers, never the key itself.
exports.handler = async () => {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  if (!apiKey) return { statusCode: 200, body: JSON.stringify({ error: 'no key configured' }) };
  try {
    const res = await fetch(`https://api.scraperapi.com/account?api_key=${apiKey}`);
    if (!res.ok) return { statusCode: 200, body: JSON.stringify({ error: `status ${res.status}` }) };
    const j = await res.json();
    const explicit = j.renewalDate ?? j.renewal_date ?? null;
    const subDate  = j.subscriptionDate ?? j.subscription_date ?? null;
    // Derive the next monthly reset from the subscription anniversary when
    // the API doesn't state it outright.
    let nextReset = explicit ? String(explicit).slice(0, 10) : null;
    if (!nextReset && subDate) {
      const start = new Date(subDate);
      if (!isNaN(start)) {
        const next = new Date(start);
        const now = new Date();
        while (next <= now) next.setMonth(next.getMonth() + 1);
        nextReset = next.toISOString().slice(0, 10);
      }
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        requestCount: j.requestCount ?? null,
        requestLimit: j.requestLimit ?? null,
        failedRequestCount: j.failedRequestCount ?? null,
        subscriptionDate: subDate,
        nextReset,
      }),
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: String(e) }) };
  }
};
