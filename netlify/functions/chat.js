const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;


// ── OBSERVABILITY ──
function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  }));
}
export async function handler(event) {
  const start = Date.now();
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
    const { message, notes, history = [] } = body;

    log('chat.request', {
      msgLen: (message || '').length,
      notesCount: (notes || []).length,
      historyLen: (history || []).length,
    });

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
      : null;

    const systemPrompt = `You are Deep Dive, Mickey's personal Bible study and ministry assistant. Mickey is a Jehovah's Witness pioneer who uses this app to organize study notes, scriptures, illustrations, and ministry material.

You are warm, knowledgeable, and conversational — like a trusted study partner. You can:
- Answer follow-up questions and remember what was said earlier in the conversation
- Discuss Bible topics, scriptures, and ministry from your own knowledge
- Search Mickey's personal notes when they are relevant and cite them clearly
- Have natural back-and-forth conversations, not just one-shot answers

When Mickey's notes are provided and relevant, reference them specifically (e.g. "In your note tagged 'Trials'..." or "Your note on Isaiah 1:18 says..."). If no notes match, draw on your own knowledge of the Bible and Jehovah's Witness publications to give a helpful answer — don't just say nothing was found.

Be concise but thorough. Use natural paragraph breaks. Do not use bullet points or headers unless the answer genuinely calls for a list.${notesContext ? `\n\nMickey's notes relevant to this message:\n${notesContext}` : ''}

After your main answer, on a new line, output exactly this format with three short natural follow-up questions Mickey might want to ask next, based on the conversation so far:
[[SUGGESTIONS]]
1. First follow-up question
2. Second follow-up question
3. Third follow-up question

Keep each suggestion under 12 words, phrased as something Mickey would type, not as something you would ask him. Always include this block, even for short answers.`;

    // Build message history — exclude the current message (it's already the last in history)
    // history arrives as [{role, content}...] including the current user message at the end
    // We send all of it as the messages array
    const messages = history.length > 0
      ? history
      : [{ role: 'user', content: message }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages,
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
    const rawText = data.content?.[0]?.text || 'No response generated.';

    // Split out the suggestions block from the main reply so the visible
    // chat bubble and the voice readout never include it
    const splitMarker = '[[SUGGESTIONS]]';
    let reply = rawText;
    let suggestions = [];

    const idx = rawText.indexOf(splitMarker);
    if (idx !== -1) {
      reply = rawText.slice(0, idx).trim();
      const suggestionsBlock = rawText.slice(idx + splitMarker.length);
      suggestions = suggestionsBlock
        .split('\n')
        .map(line => line.replace(/^\s*\d+\.\s*/, '').trim())
        .filter(line => line.length > 0)
        .slice(0, 3);
    }

    log('chat.response', {
      durationMs: Date.now() - start,
      replyLen: reply.length,
      suggestionCount: suggestions.length,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply, suggestions }),
    };
  } catch (err) {
    log('chat.error', { durationMs: Date.now() - start, error: err.message });
    console.error('Chat function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Something went wrong. Please try again.' }),
    };
  }
}
