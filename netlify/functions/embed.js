const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 50; // OpenAI allows up to 2048 inputs per request but we batch conservatively

// ── SUPABASE HELPERS ──
async function supabaseQuery(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── OPENAI EMBED ──
async function embedTexts(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

// Build a stable note ID from its content — used to detect if a note has changed
function noteId(note) {
  const key = [
    note['_tab'] || '',
    note['Tag'] || '',
    note['Scripture / Reference'] || '',
    note['Note Title'] || '',
  ].join('|');
  // Simple hash
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return `note_${Math.abs(hash)}_${key.length}`;
}

// Build the text we embed for a note — combines the most meaningful fields
function noteEmbedText(note) {
  return [
    note['Tag'] ? `Topic: ${note['Tag']}` : '',
    note['Note Title'] ? `Title: ${note['Note Title']}` : '',
    note['Scripture / Reference'] ? `Scripture: ${note['Scripture / Reference']}` : '',
    note['Note Content'] ? note['Note Content'] : '',
    note['Location Title'] ? `Source: ${note['Location Title']}` : '',
  ].filter(Boolean).join('. ').slice(0, 2000); // OpenAI token limit safety
}

// ── HANDLER ──
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, notes, query } = body;

    if (!OPENAI_KEY) throw new Error('OPENAI_KEY not configured');
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase not configured');

    // ── ACTION: embed-notes ──
    // Called after notes are fetched to keep embeddings fresh.
    // Only embeds notes that don't already have a stored embedding.
    if (action === 'embed-notes') {
      if (!notes || !notes.length) {
        return { statusCode: 200, headers, body: JSON.stringify({ embedded: 0, skipped: 0 }) };
      }

      // Get existing note IDs from Supabase so we don't re-embed unchanged notes
      const existing = await supabaseQuery('note_embeddings?select=note_id');
      const existingIds = new Set((existing || []).map(r => r.note_id));

      // Filter to only notes that need embedding
      const toEmbed = notes.filter(n => !existingIds.has(noteId(n)));
      console.log(`Embedding ${toEmbed.length} new notes (${existingIds.size} already stored)`);

      if (toEmbed.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ embedded: 0, skipped: notes.length }) };
      }

      // Process in batches to avoid OpenAI rate limits
      let embedded = 0;
      for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
        const texts = batch.map(noteEmbedText);
        const embeddings = await embedTexts(texts);

        const rows = batch.map((note, j) => ({
          note_id: noteId(note),
          embedding: embeddings[j],
          note_text: texts[j],
          tab: note['_tab'] || '',
        }));

        await supabaseQuery('note_embeddings', 'POST', rows);
        embedded += batch.length;
        console.log(`Embedded batch ${Math.floor(i / BATCH_SIZE) + 1}: ${embedded} total`);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ embedded, skipped: notes.length - embedded }),
      };
    }

    // ── ACTION: semantic-search ──
    // Embeds the query and returns the top matching note IDs with scores.
    if (action === 'semantic-search') {
      if (!query) throw new Error('query is required');

      // Embed the query
      const [queryEmbedding] = await embedTexts([query]);

      // Use Supabase's pgvector similarity search
      // We call the match_notes RPC function (defined below)
      const matches = await supabaseQuery(
        `rpc/match_notes`,
        'POST',
        {
          query_embedding: queryEmbedding,
          match_threshold: 0.3,
          match_count: 30,
        }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ matches: matches || [] }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Embed function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
