const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

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
    const { message, notes } = body;

    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
    }

    if (!ANTHROPIC_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
    }

    const notesContext = notes && notes.length > 0
      ? notes.map(n =>
          `[${n.tab || 'Notes'}] Tag: ${n.tag || 'none'} | Scripture: ${n.scripture || ''} | Title: ${n.title || ''} | Content: ${n.content || ''}`
        ).join('\n')
      : 'No matching notes found in the database for this query.';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: `You are Deep Dive, Mickey's personal research and study assistant. Mickey uses this app to organize study notes, scriptures, illustrations, and ministry material.

Your job is to search Mickey's notes and give clear, warm, well-organized answers. Always cite exactly where information comes from — for example "Tagged Notes — row 5" or "Untagged Notes". If multiple notes are relevant, organize them clearly with the most relevant first. If nothing matches, say so honestly and suggest what tags Mickey might search for.

Never make up information. Only use what is in the provided notes.

Mickey's notes relevant to this query:
${notesContext}`,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `AI service error (${response.status}). Please try again.` }),
      };
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'No response generated.';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    console.error('Chat function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Something went wrong. Please try again.' }),
    };
  }
}
