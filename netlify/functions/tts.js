const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'nzFihrBIvB34imQBuxub';

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

    // ElevenLabs has a practical limit per request — truncate very long
    // replies to keep latency reasonable for a chat experience
    const MAX_CHARS = 2000;
    const finalText = clean.length > MAX_CHARS ? clean.slice(0, MAX_CHARS) + '...' : clean;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_KEY,
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: finalText,
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
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `Voice service error (${response.status})` }),
      };
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64Audio }),
    };
  } catch (err) {
    console.error('TTS function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not generate speech.' }),
    };
  }
}
