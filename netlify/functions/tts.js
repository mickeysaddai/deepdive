const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'nzFihrBIvB34imQBuxub';

// Split text into chunks that stay under ElevenLabs' practical per-request
// limit, breaking on sentence boundaries so each chunk sounds natural when
// played back to back rather than cutting mid-sentence.
function splitIntoChunks(text, maxLen = 1800) {
  if (text.length <= maxLen) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

async function synthesizeChunk(text) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_KEY,
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('ElevenLabs error:', response.status, errText);
    throw new Error(`Voice service error (${response.status})`);
  }

  const audioBuffer = await response.arrayBuffer();
  return Buffer.from(audioBuffer).toString('base64');
}

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
    const text = (body.text || '').trim();

    if (!text) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No text provided' }) };
    }

    if (!ELEVENLABS_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Voice not configured' }) };
    }

    // Strip markdown and emojis before sending to TTS so it never reads
    // out asterisks, hashes, or emoji characters
    const clean = text
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/#+\s/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .trim();

    // Hard safety cap so a runaway reply can't generate dozens of chunks —
    // well beyond what any chat reply should reasonably be
    const SAFETY_CAP = 8000;
    const safeText = clean.length > SAFETY_CAP ? clean.slice(0, SAFETY_CAP) : clean;

    const chunks = splitIntoChunks(safeText);

    // Synthesize all chunks in parallel for speed, then return them in order
    const audioChunks = await Promise.all(chunks.map(synthesizeChunk));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioChunks }),
    };
  } catch (err) {
    console.error('TTS function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Could not generate speech.' }),
    };
  }
}
