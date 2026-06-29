const SHEET_ID = process.env.SHEET_ID;

const TABS = ['Tagged Notes', 'Untagged Notes', 'All Notes'];

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  try {
    let combined = [];

    for (const tabName of TABS) {
      try {
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
        const res = await fetch(url);
        if (!res.ok) {
          console.log(`Tab "${tabName}" returned ${res.status}`);
          continue;
        }

        const text = await res.text();

        // Google wraps response in: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
        // Find the first { and last } to extract the JSON object
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1) {
          console.log(`Could not find JSON in response for tab "${tabName}"`);
          continue;
        }

        const json = JSON.parse(text.slice(start, end + 1));
        if (!json?.table?.rows?.length) continue;

        const cols = json.table.cols.map(c => c.label || c.id || '');

        for (const row of json.table.rows) {
          if (!row.c) continue;
          const obj = { _tab: tabName };
          cols.forEach((col, i) => {
            if (col) obj[col] = row.c[i]?.v != null ? String(row.c[i].v).trim() : '';
          });
          const hasContent = cols.some(col => col && obj[col] && obj[col].length > 0);
          if (hasContent) combined.push(obj);
        }
      } catch (tabErr) {
        console.error(`Error on tab "${tabName}":`, tabErr.message);
      }
    }

    console.log(`Total notes fetched: ${combined.length}`);

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
