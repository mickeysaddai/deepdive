const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const { message, notes } = JSON.parse(event.body);

    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
    }

    const notesContext = notes && notes.length > 0
      ? notes.map(n =>
          `Tag: ${n.tag || ''} | Scripture: ${n.scripture || ''} | Title: ${n.title || ''} | Content: ${n.content || ''} | Source: ${n.source || ''}`
        ).join('\n')
      : 'No matching notes found in the database.';

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
        system: `You are Deep Dive, Mickey's personal research and study assistant. You have access to Mickey's personal notes database which includes ministry notes, scriptures, illustrations, and study material.

When answering questions:
- Always cite exactly where information comes from (e.g. "Google Sheets - Tagged Notes, row 14" or "Evernote - Illustrations note")
- Be warm, concise, and thoughtful
- If multiple notes are relevant, organize them clearly
- If nothing matches, say so honestly and suggest related tags Mickey could search for
- Never make up information that isn't in the provided notes

Mickey's relevant notes for this query:
${notesContext}`,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'AI service error. Please try again.' }) };
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
