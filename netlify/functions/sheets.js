const SHEET_ID = process.env.SHEET_ID;
const TABS = ['Tagged Notes', 'Untagged Notes', 'Google Keep'];

// ── SCHEMA ──
// The expected columns and whether they're required to have content.
// Any row missing all required fields gets dropped before reaching the app.
const SCHEMA = {
  'Tag':                    { required: false },
  'Scripture / Reference':  { required: false },
  'Bible Book':             { required: false },
  'Chapter':                { required: false },
  'Verse / Block':          { required: false },
  'Note Title':             { required: false },
  'Note Content':           { required: false },
  'Location Title':         { required: false },
  'Publication Key':        { required: false },
  'Display Title':          { required: false },
};

// At least one of these fields must have meaningful content for a row to pass
const MEANINGFUL_FIELDS = ['Note Content', 'Note Title', 'Scripture / Reference', 'Tag'];

// Content quality tiers — used by search scorer so it doesn't recompute length each query
function contentQuality(content) {
  const len = (content || '').trim().length;
  if (len >= 200) return 'rich';
  if (len >= 60)  return 'substantial';
  if (len >= 15)  return 'thin';
  return 'empty';
}

// ── SANITIZE ──
// Clean a single field value — trim whitespace, normalize common encoding
// issues, strip control characters that break JSON or HTML rendering.
function sanitize(value) {
  if (value == null) return '';
  return String(value)
    .trim()
    // Normalize smart quotes to straight quotes
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // Normalize em-dash and en-dash
    .replace(/[\u2013\u2014]/g, '-')
    // Strip control characters (except newline and tab)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Collapse multiple spaces (but preserve intentional newlines)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ── VALIDATE ROW ──
// Returns { valid: bool, reason: string, note: object }
function validateRow(obj, tabName, rowIndex) {
  // Must have at least one meaningful field with real content
  const hasMeaningful = MEANINGFUL_FIELDS.some(f => obj[f] && obj[f].trim().length > 2);
  if (!hasMeaningful) {
    return {
      valid: false,
      reason: `Row ${rowIndex} in "${tabName}" has no meaningful content in any key field`,
    };
  }

  // Note Content must not be suspiciously short garbage if it exists
  const content = obj['Note Content'] || '';
  if (content.length > 0 && content.length < 3) {
    return {
      valid: false,
      reason: `Row ${rowIndex} in "${tabName}" has trivially short Note Content: "${content}"`,
    };
  }

  return { valid: true };
}

// ── ENRICH ROW ──
// Add computed fields that downstream consumers (search, UI) can rely on
// without recomputing them on every query.
function enrichRow(obj) {
  const content = obj['Note Content'] || '';
  const title   = obj['Note Title'] || '';
  const tag     = obj['Tag'] || '';
  const scripture = obj['Scripture / Reference'] || '';

  // Pre-computed quality tier for search scoring
  obj._quality = contentQuality(content);

  // Unified display title — used by UI when Note Title is absent
  obj._displayTitle = title || scripture || tag || '';

  // Pre-lowercased search fields — saves repeated .toLowerCase() calls in searchNotes
  obj._searchText = [tag, title, content, scripture,
    obj['Location Title'] || '', obj['Bible Book'] || '']
    .join(' ').toLowerCase();

  return obj;
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const validation = {
    tabsAttempted: [],
    tabsFailed: [],
    rowsFetched: 0,
    rowsDropped: 0,
    rowsPassed: 0,
    droppedReasons: [],
  };

  try {
    let combined = [];

    for (const tabName of TABS) {
      validation.tabsAttempted.push(tabName);

      try {
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
        const res = await fetch(url);

        if (!res.ok) {
          console.log(`Tab "${tabName}" returned ${res.status} — skipping`);
          validation.tabsFailed.push({ tab: tabName, reason: `HTTP ${res.status}` });
          continue;
        }

        const text = await res.text();
        const start = text.indexOf('{');
        const end   = text.lastIndexOf('}');

        if (start === -1 || end === -1) {
          console.log(`Could not find JSON in response for tab "${tabName}"`);
          validation.tabsFailed.push({ tab: tabName, reason: 'No JSON found in response' });
          continue;
        }

        const json = JSON.parse(text.slice(start, end + 1));
        if (!json?.table?.rows?.length) {
          console.log(`Tab "${tabName}" has no rows`);
          continue;
        }

        const cols = json.table.cols.map(c => c.label || c.id || '');

        json.table.rows.forEach((row, rowIndex) => {
          if (!row.c) return;

          validation.rowsFetched++;

          // Build and sanitize the row object
          const obj = { _tab: tabName };
          cols.forEach((col, i) => {
            if (col) obj[col] = sanitize(row.c[i]?.v);
          });

          // Validate
          const result = validateRow(obj, tabName, rowIndex + 2); // +2 for header row + 1-index
          if (!result.valid) {
            validation.rowsDropped++;
            if (validation.droppedReasons.length < 20) {
              validation.droppedReasons.push(result.reason);
            }
            return;
          }

          // Enrich with computed fields
          enrichRow(obj);
          validation.rowsPassed++;
          combined.push(obj);
        });

      } catch (tabErr) {
        console.error(`Error on tab "${tabName}":`, tabErr.message);
        validation.tabsFailed.push({ tab: tabName, reason: tabErr.message });
      }
    }

    // Log validation summary to Netlify function logs
    console.log('Sheets validation summary:', JSON.stringify({
      rowsFetched: validation.rowsFetched,
      rowsPassed:  validation.rowsPassed,
      rowsDropped: validation.rowsDropped,
      tabsFailed:  validation.tabsFailed.length,
    }));

    if (validation.rowsDropped > 0) {
      console.log('Dropped row reasons (first 20):', validation.droppedReasons);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        notes: combined,
        count: combined.length,
        validation: {
          rowsFetched: validation.rowsFetched,
          rowsPassed:  validation.rowsPassed,
          rowsDropped: validation.rowsDropped,
          tabsFailed:  validation.tabsFailed,
        },
      }),
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
