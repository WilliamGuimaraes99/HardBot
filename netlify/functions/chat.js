// ─────────────────────────────────────────────────────────────────
//  HardBot — Proxy Groq + Busca real (Google Custom Search API)
//
//  Variáveis de ambiente no Netlify:
//    GROQ_API_KEY        → console.groq.com          (obrigatório)
//    GOOGLE_SEARCH_KEY   → console.cloud.google.com  (grátis, sem cartão)
//    GOOGLE_SEARCH_CX    → programmablesearchengine.google.com
//
//  Limite gratuito Google: 100 buscas/dia (~50 consultas de preço/dia)
// ─────────────────────────────────────────────────────────────────

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GOOGLE_URL = 'https://www.googleapis.com/customsearch/v1';

// ── Palavras que disparam busca de preços ────────────────────────
const PRICE_WORDS = [
  'preço','preços','valor','custo','quanto custa','mais barato',
  'menor preço','melhor preço','comprar','onde comprar','loja',
  'onde encontrar','cotação','link','encontrar','pesquisar',
  'buscar preço','verificar preço','busque','pesquise','compra online',
];

// ── Palavras que disparam busca de cupons ────────────────────────
const COUPON_WORDS = [
  'cupom','cupons','desconto','descontos','promoção','promoções',
  'oferta','ofertas','cashback','código promocional','voucher','promo',
  'código desconto',
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

    // ── Última mensagem do usuário (sem bloco de contexto) ───────
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const cleanQuery  = lastUserMsg.replace(/\n\n---[\s\S]*?---\n/g, '').trim();
    const lower       = cleanQuery.toLowerCase();

    const needsPrice  = PRICE_WORDS.some(w  => lower.includes(w));
    const needsCoupon = COUPON_WORDS.some(w => lower.includes(w));
    const canSearch   = (needsPrice || needsCoupon) && googleKey && googleCx;

    // ── Buscas em paralelo (máx. 2 calls para economizar cota) ───
    let searchContext = '';

    if (canSearch) {
      const short = cleanQuery.substring(0, 150);
      const jobs  = [];

      if (needsPrice) {
        // Uma query que cobre as principais lojas BR de hardware
        const priceQuery =
          `${short} preço site:kabum.com.br OR site:pichau.com.br ` +
          `OR site:terabyteshop.com.br OR site:amazon.com.br ` +
          `OR site:magalu.com.br OR site:americanas.com.br 2025`;
        jobs.push(googleSearch(priceQuery, googleKey, googleCx));
      }

      if (needsCoupon) {
        // Query focada em sites de cupons brasileiros
        const couponQuery =
          `cupom desconto ${short} site:promobit.com.br OR ` +
          `site:cuponomia.com.br OR site:meliuz.com.br OR ` +
          `site:ociocriativo.com.br 2025`;
        jobs.push(googleSearch(couponQuery, googleKey, googleCx));
      }

      const settled = await Promise.allSettled(jobs);
      const allResults = settled
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

      // Remove duplicatas
      const seen   = new Set();
      const unique = allResults.filter(r => {
        if (!r.url || seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });

      if (unique.length > 0) {
        searchContext = buildContext(unique, needsPrice, needsCoupon);
      }
    }

    // ── Injeta resultados na última mensagem do usuário ──────────
    const finalMessages = messages.map((msg, i) => {
      if (msg.role === 'user' && i === messages.length - 1 && searchContext) {
        return { ...msg, content: msg.content + searchContext };
      }
      return msg;
    });

    // ── Chama Groq ───────────────────────────────────────────────
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
      },
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

// ─────────────────────────────────────────────────────────────────
//  Google Custom Search
// ─────────────────────────────────────────────────────────────────
async function googleSearch(query, key, cx) {
  try {
    const params = new URLSearchParams({
      key,
      cx,
      q:           query,
      gl:          'br',   // geolocalização Brasil
      hl:          'pt',   // idioma português
      num:         '8',    // 8 resultados por busca
      dateRestrict:'m3',   // últimos 3 meses (preços mais recentes)
    });

    const resp = await fetch(`${GOOGLE_URL}?${params}`);
    if (!resp.ok) return [];

    const data = await resp.json();

    return (data.items || []).map(item => ({
      title:       item.title        || '',
      url:         item.link         || '',
      description: item.snippet      || '',
      displayUrl:  item.displayLink  || '',
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
//  Formata resultados para o LLM
// ─────────────────────────────────────────────────────────────────
function buildContext(results, isPrice, isCoupon) {
  const today = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const STORE_DOMAINS  = ['kabum','pichau','terabyte','amazon','magalu','americanas','shopee','submarino'];
  const COUPON_DOMAINS = ['promobit','cuponomia','meliuz','cupom','desconto','cashback','promo','ociocriativo'];

  const storeResults  = results.filter(r => STORE_DOMAINS.some(d  => r.url.includes(d)));
  const couponResults = results.filter(r => COUPON_DOMAINS.some(d => r.url.includes(d)));
  const otherResults  = results.filter(r => !storeResults.includes(r) && !couponResults.includes(r));

  let ctx = `\n\n${'═'.repeat(52)}\n`;
  ctx += `🔍 BUSCA GOOGLE EM TEMPO REAL — ${today}\n`;
  ctx += `${'═'.repeat(52)}\n\n`;

  // Resultados de lojas
  if (isPrice && storeResults.length > 0) {
    ctx += `🛒 PRODUTOS NAS LOJAS (Google):\n\n`;
    storeResults.forEach((r, i) => {
      ctx += `${i + 1}. ${r.title}\n`;
      ctx += `   💰 URL DIRETO: ${r.url}\n`;
      ctx += `   📋 ${r.description.substring(0, 200)}\n\n`;
    });
  }

  // Outros resultados de preço
  if (isPrice && otherResults.length > 0) {
    ctx += `🔎 MAIS RESULTADOS DE PREÇO:\n\n`;
    otherResults.slice(0, 4).forEach((r, i) => {
      ctx += `${i + 1}. ${r.title}\n`;
      ctx += `   🔗 URL: ${r.url}\n`;
      ctx += `   📋 ${r.description.substring(0, 160)}\n\n`;
    });
  }

  // Cupons
  if (isCoupon && couponResults.length > 0) {
    ctx += `🎟️ CUPONS E PROMOÇÕES ENCONTRADOS:\n\n`;
    couponResults.forEach((r, i) => {
      ctx += `${i + 1}. ${r.title}\n`;
      ctx += `   🏷️ URL: ${r.url}\n`;
      ctx += `   📋 ${r.description.substring(0, 200)}\n\n`;
    });
  }

  // Instruções para o LLM
  ctx += `${'═'.repeat(52)}\n`;
  ctx += `📌 INSTRUÇÕES OBRIGATÓRIAS PARA O ASSISTENTE:\n`;
  ctx += `1. USE os links acima — formate como [Texto](URL)\n`;
  ctx += `2. Organize os preços do menor para o maior\n`;
  ctx += `3. Destaque o MENOR PREÇO encontrado em negrito\n`;
  ctx += `4. Se o snippet mencionar R$ X.XXX, cite esse valor\n`;
  ctx += `5. Mostre o link direto de cada produto/loja encontrado\n`;
  ctx += `6. Para cupons: informe o código, desconto e loja\n`;
  ctx += `7. Adicione "🔍 Preços verificados via Google em tempo real"\n`;
  ctx += `8. NUNCA invente preços que não estejam nestes dados\n`;
  ctx += `9. Se não encontrou preço exato, diga qual loja tem o produto\n`;
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
