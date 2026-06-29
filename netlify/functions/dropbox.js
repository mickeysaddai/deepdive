const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
const DROPBOX_FILE_PATH = process.env.DROPBOX_FILE_PATH || '/Pioneer-School-Book.pdf';

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    // Get a temporary download link from Dropbox
    const linkRes = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: DROPBOX_FILE_PATH }),
    });

    if (!linkRes.ok) {
      const err = await linkRes.text();
      console.error('Dropbox link error:', err);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Could not access Pioneer book from Dropbox.' }),
      };
    }

    const linkData = await linkRes.json();
    const tempLink = linkData.link;

    // Return the temporary link — the client uses it to display/read the PDF
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: tempLink,
        name: linkData.metadata?.name || 'Pioneer-School-Book.pdf',
        size: linkData.metadata?.size,
      }),
    };
  } catch (err) {
    console.error('Dropbox function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not connect to Dropbox.' }),
    };
  }
}
