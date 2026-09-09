// Vercel serverless function: GET /api/stats
// Fetches live data from the GoHighLevel API server-side (token never reaches the browser)
// and returns an aggregated, PII-light summary for the dashboard.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function ghlHeaders() {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error("GHL_API_TOKEN environment variable is not set");
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };
}

async function ghlGet(path) {
  const res = await fetch(`${GHL_BASE}${path}`, { headers: ghlHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAllOpportunities(locationId) {
  let all = [];
  let url = `/opportunities/search?location_id=${locationId}&limit=100`;
  let guard = 0;
  while (url && guard < 20) {
    const resp = await fetch(url.startsWith("http") ? url : `${GHL_BASE}${url}`, { headers: ghlHeaders() });
    if (!resp.ok) throw new Error(`GHL API ${resp.status} on opportunities page`);
    const data = await resp.json();
    all = all.concat(data.opportunities || []);
    url = data.meta && data.meta.nextPageUrl ? data.meta.nextPageUrl : null;
    guard++;
  }
  return all;
}

// Deterministic pseudo-name so the same lead always gets the same label
// across refreshes, without ever exposing their real name.
function anonymize(id) {
  const tail = (id || "").slice(-4).toUpperCase() || "0000";
  return `Lead ${tail}`;
}

module.exports = async (req, res) => {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    res.status(500).json({ error: "GHL_LOCATION_ID environment variable is not set" });
    return;
  }

  try {
    const [contactsMeta, recentContacts, pipelinesResp, allOpps] = await Promise.all([
      ghlGet(`/contacts/?locationId=${locationId}&limit=1`),
      ghlGet(`/contacts/?locationId=${locationId}&limit=5`),
      ghlGet(`/opportunities/pipelines?locationId=${locationId}`),
      fetchAllOpportunities(locationId),
    ]);

    const totals = { contacts: contactsMeta.meta.total, openCount: 0, openValue: 0, wonCount: 0, wonValue: 0, lostCount: 0, lostValue: 0, abandonedCount: 0, abandonedValue: 0 };
    for (const o of allOpps) {
      const val = Number(o.monetaryValue) || 0;
      if (o.status === "open") { totals.openCount++; totals.openValue += val; }
      else if (o.status === "won") { totals.wonCount++; totals.wonValue += val; }
      else if (o.status === "lost") { totals.lostCount++; totals.lostValue += val; }
      else if (o.status === "abandoned") { totals.abandonedCount++; totals.abandonedValue += val; }
    }

    const pipelines = (pipelinesResp.pipelines || []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: (p.stages || []).map((s, position) => {
        const matching = allOpps.filter((o) => o.status === "open" && o.pipelineId === p.id && o.pipelineStageId === s.id);
        return {
          id: s.id,
          name: s.name,
          position,
          count: matching.length,
          value: matching.reduce((sum, o) => sum + (Number(o.monetaryValue) || 0), 0),
        };
      }),
    }));

    const recentLeads = (recentContacts.contacts || []).map((c) => ({
      name: anonymize(c.id),
      source: c.source || null,
      dateAdded: c.dateAdded,
      type: c.type || "lead",
    }));

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({
      locationId,
      updatedAt: new Date().toISOString(),
      totals,
      pipelines,
      recentLeads,
    });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
