// ─────────────────────────────────────────────────────────────────
//  HardBot — Proxy Groq API
//  A chave GROQ_API_KEY fica nas variáveis de ambiente do Netlify.
//  O usuário final NUNCA vê nem digita nenhuma chave.
// ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  // Chave lida do ambiente — nunca exposta ao navegador
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: {
          message: 'Chave GROQ_API_KEY não configurada nas variáveis de ambiente do Netlify.'
        }
      }),
    };
  }

  try {
    const payload = JSON.parse(event.body);

    // Encaminha para a Groq com a chave segura
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: err.message } }),
    };
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
