const SHEET_ID = process.env.SHEET_ID;

const TABS = ['Tagged Notes', 'Untagged Notes', 'All Notes'];

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300', // cache for 5 min
  };

  try {
    const { tab } = event.queryStringParameters || {};
    const tabsToFetch = tab ? [tab] : TABS;
    let combined = [];

    for (const tabName of tabsToFetch) {
      try {
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
        const res = await fetch(url);
        if (!res.ok) continue;

        const text = await res.text();
        // Google wraps response in /*O_o*/ and google.visualization.Query.setResponse(...)
        const jsonStr = text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
        const json = JSON.parse(jsonStr);

        if (!json?.table?.rows) continue;

        const headers_row = json.table.cols.map(c => c.label || c.id);

        json.table.rows.forEach(row => {
          if (!row.c) return;
          const obj = { _tab: tabName };
          headers_row.forEach((h, i) => {
            obj[h] = row.c[i]?.v != null ? String(row.c[i].v) : '';
          });
          // Only include rows that have actual content
          const hasContent = headers_row.some(h => h && obj[h] && obj[h].trim());
          if (hasContent) combined.push(obj);
        });
      } catch (tabErr) {
        console.error(`Error fetching tab "${tabName}":`, tabErr.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ notes: combined, count: combined.length }),
    };
  } catch (err) {
    console.error('Sheets function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not fetch notes from Google Sheets.' }),
    };
  }
}
