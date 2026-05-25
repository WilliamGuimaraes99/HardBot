// ─────────────────────────────────────────────────────────────────
//  HardBot — Proxy Groq + Busca real (Google Custom Search API)
//
//  Variáveis de ambiente no Netlify:
//    GROQ_API_KEY        → console.groq.com          (obrigatório)
//    GOOGLE_SEARCH_KEY   → console.cloud.google.com  (grátis, sem cartão)
//    GOOGLE_SEARCH_CX    → programmablesearchengine.google.com
// ─────────────────────────────────────────────────────────────────

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GOOGLE_URL = 'https://www.googleapis.com/customsearch/v1';

// ── Palavras que disparam busca de preços ────────────────────────
const PRICE_WORDS = [
  'preço','preços','valor','custo','quanto custa','mais barato',
  'menor preço','melhor preço','comprar','onde comprar','loja',
  'onde encontrar','cotação','link','links','me dê o link',
  'me da o link','encontrar','pesquisar','buscar','verificar preço',
  'busque','pesquise','compra','compra online','url','site',
];

// ── Palavras que disparam busca de cupons ────────────────────────
const COUPON_WORDS = [
  'cupom','cupons','desconto','descontos','promoção','promoções',
  'oferta','ofertas','cashback','código promocional','voucher','promo',
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

    // ── Última mensagem do usuário ───────────────────────────────
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const cleanCurrent = lastUserMsg.replace(/\n\n---[\s\S]*?---\n/g, '').trim();
    const lower = cleanCurrent.toLowerCase();

    const needsPrice  = PRICE_WORDS.some(w  => lower.includes(w));
    const needsCoupon = COUPON_WORDS.some(w => lower.includes(w));
    const canSearch   = (needsPrice || needsCoupon) && googleKey && googleCx;

    // ── Monta query usando contexto da conversa ──────────────────
    let searchContext = '';

    if (canSearch) {
      // Se mensagem atual é curta/vaga (ex: "me dê o link"), usa contexto anterior
      const queryBase = cleanCurrent.length < 60
        ? extractContextFromHistory(messages, cleanCurrent)
        : cleanCurrent.substring(0, 160);

      const jobs = [];

      if (needsPrice) {
        // Busca direta nas lojas BR — inclui "comprar" para pegar páginas de produto
        const q1 =
          `${queryBase} comprar site:kabum.com.br OR site:pichau.com.br ` +
          `OR site:terabyteshop.com.br OR site:amazon.com.br ` +
          `OR site:magalu.com.br OR site:americanas.com.br`;
        jobs.push(googleSearch(q1, googleKey, googleCx));

        // Segunda busca: menor preço + comparação
        const q2 = `${queryBase} menor preço Brasil 2025 link comprar`;
        jobs.push(googleSearch(q2, googleKey, googleCx));
      }

      if (needsCoupon) {
        const q3 =
          `cupom desconto ${queryBase} site:promobit.com.br OR ` +
          `site:cuponomia.com.br OR site:meliuz.com.br 2025`;
        jobs.push(googleSearch(q3, googleKey, googleCx));
      }

      const settled = await Promise.allSettled(jobs);
      const allResults = settled
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

      // Remove duplicatas por URL
      const seen   = new Set();
      const unique = allResults.filter(r => {
        if (!r.url || seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });

      if (unique.length > 0) {
        searchContext = buildContext(unique, needsPrice, needsCoupon);
      } else if (googleKey && googleCx) {
        // Busca não retornou resultados — informa o LLM
        searchContext = '\n\n[BUSCA REALIZADA MAS SEM RESULTADOS DIRETOS DE LOJAS. ' +
          'Oriente o usuário a pesquisar nas lojas mencionadas.]\n';
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
//  Extrai contexto de produto das mensagens anteriores
//  Usado quando a mensagem atual é curta (ex: "me dê o link")
// ─────────────────────────────────────────────────────────────────
function extractContextFromHistory(messages, currentMsg) {
  // Pega as últimas 6 mensagens e extrai nomes de produtos
  const recent = messages
    .slice(-6)
    .map(m => m.content
      .replace(/\n\n---[\s\S]*?---\n/g, '')       // remove bloco de contexto
      .replace(/[═]{2,}[\s\S]*?[═]{2,}/g, '')     // remove bloco de busca
      .trim()
    )
    .join(' ');

  // Padrões comuns de produtos de hardware
  const hardwarePatterns = [
    /\b(RTX|RX|GTX)\s*\d{3,4}[A-Z\s]*/gi,
    /\b(Ryzen|Core i\d|Intel|AMD)\s*[\w\s-]*/gi,
    /\b(DDR[45]|NVMe|SSD|RAM|M\.2)\s*[\w\s]*/gi,
    /\b[\w\s]*(GB|TB|MHz|GHz)\b/gi,
  ];

  let productName = '';
  for (const pattern of hardwarePatterns) {
    const match = recent.match(pattern);
    if (match && match[0]) {
      productName = match[0].trim().substring(0, 60);
      break;
    }
  }

  // Se não achou padrão, usa as últimas palavras significativas do histórico
  if (!productName) {
    productName = recent
      .replace(/[^a-zA-Z0-9À-ÿ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(-12)
      .join(' ')
      .substring(0, 120);
  }

  return `${productName} ${currentMsg}`.trim().substring(0, 160);
}

// ─────────────────────────────────────────────────────────────────
//  Google Custom Search
// ─────────────────────────────────────────────────────────────────
async function googleSearch(query, key, cx) {
  try {
    const params = new URLSearchParams({
      key,
      cx,
      q:           query,
      gl:          'br',
      hl:          'pt',
      num:         '8',
      dateRestrict:'m3',
    });

    const resp = await fetch(`${GOOGLE_URL}?${params}`);
    if (!resp.ok) return [];

    const data = await resp.json();

    return (data.items || []).map(item => ({
      title:      item.title       || '',
      url:        item.link        || '',
      description:item.snippet     || '',
      displayUrl: item.displayLink || '',
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
//  Formata resultados para injetar no contexto do LLM
// ─────────────────────────────────────────────────────────────────
function buildContext(results, isPrice, isCoupon) {
  const today = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const STORE_DOMAINS  = ['kabum','pichau','terabyte','amazon','magalu','americanas','shopee','submarino'];
  const COUPON_DOMAINS = ['promobit','cuponomia','meliuz','cupom','desconto','cashback','ociocriativo'];

  const storeResults  = results.filter(r => STORE_DOMAINS.some(d  => r.url.includes(d)));
  const couponResults = results.filter(r => COUPON_DOMAINS.some(d => r.url.includes(d)));
  const otherResults  = results.filter(r => !storeResults.includes(r) && !couponResults.includes(r));

  let ctx = `\n\n${'═'.repeat(52)}\n`;
  ctx += `🔍 RESULTADOS REAIS DO GOOGLE — ${today}\n`;
  ctx += `${'═'.repeat(52)}\n\n`;

  if (isPrice && storeResults.length > 0) {
    ctx += `🛒 PÁGINAS DE PRODUTO NAS LOJAS:\n\n`;
    storeResults.forEach((r, i) => {
      ctx += `${i + 1}. TÍTULO: ${r.title}\n`;
      ctx += `   LINK DIRETO: ${r.url}\n`;
      ctx += `   INFO: ${r.description.substring(0, 220)}\n\n`;
    });
  }

  if (isPrice && otherResults.length > 0) {
    ctx += `🔎 MAIS RESULTADOS:\n\n`;
    otherResults.slice(0, 4).forEach((r, i) => {
      ctx += `${i + 1}. TÍTULO: ${r.title}\n`;
      ctx += `   LINK: ${r.url}\n`;
      ctx += `   INFO: ${r.description.substring(0, 180)}\n\n`;
    });
  }

  if (isCoupon && couponResults.length > 0) {
    ctx += `🎟️ CUPONS ENCONTRADOS:\n\n`;
    couponResults.forEach((r, i) => {
      ctx += `${i + 1}. TÍTULO: ${r.title}\n`;
      ctx += `   LINK: ${r.url}\n`;
      ctx += `   INFO: ${r.description.substring(0, 220)}\n\n`;
    });
  }

  ctx += `${'═'.repeat(52)}\n`;
  ctx += `🚨 REGRAS OBRIGATÓRIAS — SEGUIR SEM EXCEÇÃO:\n\n`;
  ctx += `1. COPIE os links EXATOS acima — não modifique as URLs\n`;
  ctx += `2. Formate TODOS os links como: [nome da loja ou produto](URL_EXATA)\n`;
  ctx += `3. NUNCA diga "não posso fornecer links" — você tem os links acima\n`;
  ctx += `4. NUNCA invente URLs — use apenas as listadas acima\n`;
  ctx += `5. Se o snippet mostrar "R$ X.XXX", cite esse valor com a loja\n`;
  ctx += `6. Organize do menor para o maior preço quando possível\n`;
  ctx += `7. Adicione o badge: 🔍 Preços verificados via Google em tempo real\n`;
  ctx += `8. Para cupons: destaque o código, percentual e a loja\n`;
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
