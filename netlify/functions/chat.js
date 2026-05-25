// ─────────────────────────────────────────────────────────────────
//  HardBot — Proxy Groq + Google Custom Search API
//
//  Variáveis de ambiente no Netlify:
//    GROQ_API_KEY        → console.groq.com
//    GOOGLE_SEARCH_KEY   → console.cloud.google.com
//    GOOGLE_SEARCH_CX    → programmablesearchengine.google.com
// ─────────────────────────────────────────────────────────────────

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GOOGLE_URL = 'https://www.googleapis.com/customsearch/v1';

const PRICE_WORDS = [
  'preço','preços','valor','custo','quanto custa','mais barato',
  'menor preço','melhor preço','comprar','onde comprar','loja',
  'onde encontrar','cotação','link','links','me dê o link',
  'me da o link','encontrar','pesquisar','buscar','verificar',
  'busque','pesquise','compra','url','site','oferta','ofertas',
  'melhores ofertas','pesquisa de preço',
];

const COUPON_WORDS = [
  'cupom','cupons','desconto','descontos','promoção','promoções',
  'cashback','código','voucher','promo',
];

// ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  const groqKey   = process.env.GROQ_API_KEY;
  const googleKey = process.env.GOOGLE_SEARCH_KEY;
  const googleCx  = process.env.GOOGLE_SEARCH_CX;

  if (!groqKey) {
    return {
      statusCode: 500,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'GROQ_API_KEY não configurada.' } }),
    };
  }

  try {
    const { model, messages, max_tokens, temperature } = JSON.parse(event.body);

    // Última mensagem do usuário
    const lastUserMsg  = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const cleanCurrent = lastUserMsg.replace(/\n\n---[\s\S]*?---\n/g, '').trim();
    const lower        = cleanCurrent.toLowerCase();

    const needsPrice  = PRICE_WORDS.some(w  => lower.includes(w));
    const needsCoupon = COUPON_WORDS.some(w => lower.includes(w));
    const hasSearchKeys = !!(googleKey && googleCx);

    // ── Status das chaves (aparece no log do Netlify) ────────────
    console.log('[HardBot] needsPrice:', needsPrice, '| needsCoupon:', needsCoupon);
    console.log('[HardBot] Google keys:', hasSearchKeys ? 'OK' : 'MISSING');

    let searchContext = '';

    if ((needsPrice || needsCoupon) && hasSearchKeys) {

      // SEMPRE extrai o nome do produto — nunca envia a frase crua do usuário
      const queryBase = extractProductName(messages, cleanCurrent);

      console.log('[HardBot] Query base:', queryBase);

      const jobs = [];

      if (needsPrice) {
        // Query 1 — produto + preço
        const q1 = `${queryBase} preço`;
        jobs.push(googleSearch(q1, googleKey, googleCx));

        // Query 2 — produto + comprar (captura páginas de produto)
        const q2 = `${queryBase} comprar`;
        jobs.push(googleSearch(q2, googleKey, googleCx));
      }

      if (needsCoupon) {
        const q3 = `cupom desconto ${queryBase} brasil 2025`;
        jobs.push(googleSearch(q3, googleKey, googleCx));
      }

      const settled    = await Promise.allSettled(jobs);
      const allResults = settled
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

      console.log('[HardBot] Total resultados brutos:', allResults.length);

      // Remove duplicatas por URL
      const seen   = new Set();
      const unique = allResults.filter(r => {
        if (!r.url || seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });

      console.log('[HardBot] Resultados únicos:', unique.length);

      if (unique.length > 0) {
        searchContext = buildContext(unique, needsPrice, needsCoupon, queryBase);
      } else {
        // Busca rodou mas sem resultados — informa o LLM
        searchContext =
          '\n\n[BUSCA GOOGLE EXECUTADA MAS SEM RESULTADOS. ' +
          'Possíveis causas: produto muito novo, sem estoque no Brasil, ' +
          'ou limite de buscas gratuitas atingido (100/dia). ' +
          'Oriente o usuário a pesquisar diretamente nas lojas.]\n';
        console.log('[HardBot] Nenhum resultado encontrado');
      }

    } else if ((needsPrice || needsCoupon) && !hasSearchKeys) {
      console.log('[HardBot] Busca necessária mas chaves Google não configuradas');
      searchContext =
        '\n\n[AVISO: Busca de preços em tempo real não disponível — ' +
        'variáveis GOOGLE_SEARCH_KEY ou GOOGLE_SEARCH_CX não configuradas no Netlify. ' +
        'Informe o usuário que a busca em tempo real está indisponível e ' +
        'recomende as principais lojas brasileiras.]\n';
    }

    // Injeta contexto na última mensagem
    const finalMessages = messages.map((msg, i) => {
      if (msg.role === 'user' && i === messages.length - 1 && searchContext) {
        return { ...msg, content: msg.content + searchContext };
      }
      return msg;
    });

    // Chama Groq
    const groqResp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({ model, messages: finalMessages, max_tokens, temperature }),
    });

    const data = await groqResp.json();

    return {
      statusCode: groqResp.status,
      headers: {
        ...cors(),
        'Content-Type': 'application/json',
        'X-Web-Search': searchContext ? 'true' : 'false',
        'X-Search-Keys': hasSearchKeys ? 'configured' : 'missing',
      },
      body: JSON.stringify(data),
    };

  } catch (err) {
    console.error('[HardBot] Erro:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: err.message } }),
    };
  }
};

// ─────────────────────────────────────────────────────────────────
//  Extrai APENAS o nome do produto (nunca envia a frase crua)
//  Prioridade: mensagem atual → histórico → fallback curto
// ─────────────────────────────────────────────────────────────────
function extractProductName(messages, currentMsg) {
  const patterns = [
    /\b(RTX|RX|GTX|Arc)\s*\d{3,4}\s*[A-Za-z]*/gi,
    /\b(Ryzen\s*\d+\s*\d*\w*|Core\s*i\d+[-\s]\w+)/gi,
    /\b(Intel|AMD|NVIDIA)\s+[\w][\w\s-]{2,25}/gi,
    /\b\w[\w\s-]{2,20}(GB|TB|GHz|MHz|W)\b/gi,
  ];

  // 1) Tenta extrair da mensagem atual
  for (const p of patterns) {
    const m = currentMsg.match(p);
    if (m?.[0]?.trim().length > 3) return m[0].trim().substring(0, 80);
  }

  // 2) Busca no histórico recente
  const recent = messages
    .slice(-6)
    .map(m => m.content.replace(/\n\n---[\s\S]*?---\n/g, '').replace(/[═]{2,}[\s\S]*?[═]{2,}/g, '').trim())
    .join(' ');

  for (const p of patterns) {
    const m = recent.match(p);
    if (m?.[0]?.trim().length > 3) return m[0].trim().substring(0, 80);
  }

  // 3) Fallback: palavras-chave curtas da mensagem atual (sem stopwords)
  const stops = new Set(['quero','uma','um','para','de','do','da','com','que','me','dê','link','links','nas','os','as','faça','pesquisa','melhor','melhores','menor','onde','comprar']);
  const words = currentMsg
    .toLowerCase()
    .replace(/[^a-zA-Z0-9À-ÿ\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stops.has(w))
    .slice(0, 5)
    .join(' ');

  return words.substring(0, 80) || 'hardware';
}

// ─────────────────────────────────────────────────────────────────
//  Extrai contexto de produto do histórico da conversa (legado)
// ─────────────────────────────────────────────────────────────────
function extractContext(messages, currentMsg) {
  const recent = messages
    .slice(-6)
    .map(m => m.content
      .replace(/\n\n---[\s\S]*?---\n/g, '')
      .replace(/[═]{2,}[\s\S]*?[═]{2,}/g, '')
      .trim()
    )
    .join(' ');

  // Tenta extrair nome de produto de hardware
  const patterns = [
    /\b(RTX|RX|GTX)\s*\d{3,4}\s*[A-Z]*/gi,
    /\b(Ryzen\s*\d+|Core\s*i\d+[-\s]\w+)/gi,
    /\b(Intel|AMD)\s+[\w\s-]{3,30}/gi,
    /\b[\w\s]*(GB|TB|GHz|MHz)\b/gi,
  ];

  for (const p of patterns) {
    const m = recent.match(p);
    if (m?.[0]) return (m[0].trim() + ' ' + currentMsg).substring(0, 160);
  }

  // Fallback: palavras significativas do histórico
  const words = recent
    .replace(/[^a-zA-Z0-9À-ÿ\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(-10)
    .join(' ');

  return (words + ' ' + currentMsg).substring(0, 160);
}

// ─────────────────────────────────────────────────────────────────
//  Google Custom Search
// ─────────────────────────────────────────────────────────────────
async function googleSearch(query, key, cx) {
  try {
    const params = new URLSearchParams({
      key,
      cx,
      q:   query,
      gl:  'br',
      hl:  'pt',
      num: '8',
      // sem dateRestrict — páginas de produto não têm data recente
    });

    const resp = await fetch(`${GOOGLE_URL}?${params}`);

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[HardBot] Google API erro:', resp.status, errBody.substring(0, 200));
      return [];
    }

    const data = await resp.json();
    const items = data.items || [];

    console.log(`[HardBot] Google retornou ${items.length} para: "${query.substring(0,80)}"`);

    return items.map(item => ({
      title:       item.title       || '',
      url:         item.link        || '',
      description: item.snippet     || '',
      displayUrl:  item.displayLink || '',
    }));
  } catch (e) {
    console.error('[HardBot] googleSearch exception:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
//  Formata resultados para o LLM
// ─────────────────────────────────────────────────────────────────
function buildContext(results, isPrice, isCoupon, queryUsed) {
  const today = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const STORE_DOMAINS  = ['kabum','pichau','terabyte','amazon','magalu','americanas','shopee','submarino','buscape','zoom'];
  const COUPON_DOMAINS = ['promobit','cuponomia','meliuz','cupom','desconto','cashback','ociocriativo'];

  const storeResults  = results.filter(r => STORE_DOMAINS.some(d  => r.url.toLowerCase().includes(d)));
  const couponResults = results.filter(r => COUPON_DOMAINS.some(d => r.url.toLowerCase().includes(d)));
  const otherResults  = results.filter(r => !storeResults.includes(r) && !couponResults.includes(r));

  let ctx = `\n\n${'═'.repeat(52)}\n`;
  ctx += `🔍 RESULTADOS REAIS DO GOOGLE — ${today}\n`;
  ctx += `🔎 Busca realizada por: "${queryUsed.substring(0, 80)}"\n`;
  ctx += `${'═'.repeat(52)}\n\n`;

  if (isPrice && storeResults.length > 0) {
    ctx += `🛒 PRODUTOS ENCONTRADOS NAS LOJAS (${storeResults.length} resultados):\n\n`;
    storeResults.forEach((r, i) => {
      ctx += `${i + 1}. ${r.title}\n`;
      ctx += `   🔗 URL: ${r.url}\n`;
      ctx += `   💬 ${r.description.substring(0, 250)}\n\n`;
    });
  }

  if (isPrice && otherResults.length > 0) {
    ctx += `📋 OUTROS RESULTADOS RELEVANTES (${otherResults.length}):\n\n`;
    otherResults.slice(0, 5).forEach((r, i) => {
      ctx += `${i + 1}. ${r.title}\n`;
      ctx += `   🔗 URL: ${r.url}\n`;
      ctx += `   💬 ${r.description.substring(0, 200)}\n\n`;
    });
  }

  if (isCoupon && couponResults.length > 0) {
    ctx += `🎟️ CUPONS ENCONTRADOS (${couponResults.length}):\n\n`;
    couponResults.forEach((r, i) => {
      ctx += `${i + 1}. ${r.title}\n`;
      ctx += `   🔗 URL: ${r.url}\n`;
      ctx += `   💬 ${r.description.substring(0, 250)}\n\n`;
    });
  }

  ctx += `${'═'.repeat(52)}\n`;
  ctx += `🚨 INSTRUÇÕES OBRIGATÓRIAS:\n`;
  ctx += `• USE as URLs EXATAS acima — formato: [texto](URL)\n`;
  ctx += `• NUNCA diga "não posso fornecer links" — os links estão acima\n`;
  ctx += `• Se snippet tiver "R$ X.XXX" → cite o valor e a loja\n`;
  ctx += `• Organize do menor para o maior preço\n`;
  ctx += `• Badge obrigatório: 🔍 Preços verificados via Google\n`;
  ctx += `${'═'.repeat(52)}\n`;

  return ctx;
}

// ─────────────────────────────────────────────────────────────────
function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
