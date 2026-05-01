exports.handler = async function(event) {
  const GAMMA = "https://gamma-api.polymarket.com";
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const params = event.queryStringParameters || {};

  if (params.slug) {
    try {
      const res = await fetch(`${GAMMA}/markets?slug=${params.slug}`, {
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
      });
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  try {
    const marketsRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=50&order=volume24hr&ascending=false`,
      { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
    );
    const markets = await marketsRes.json();

    const topMarkets = markets.slice(0, 15).map(m => {
      let prices = [], outcomes = [];
      try { prices = JSON.parse(m.outcomePrices || "[0.5,0.5]").map(Number); } catch {}
      try { outcomes = JSON.parse(m.outcomes || '["Yes","No"]'); } catch {}
      const bestIdx = prices.indexOf(Math.max(...prices));
      const daysLeft = m.endDate ? Math.round((new Date(m.endDate) - new Date()) / 86400000) : null;
      return {
        question: m.question,
        outcomes,
        crowdProbabilities: prices.map((p, i) => `${outcomes[i]}: ${Math.round(p*100)}%`).join(", "),
        crowdFavorite: outcomes[bestIdx] || "Yes",
        crowdConfidence: Math.round((prices[bestIdx] || 0.5) * 100),
        volume: Math.round(parseFloat(m.volume || 0)),
        liquidity: Math.round(parseFloat(m.liquidity || 0)),
        daysLeft,
        slug: m.slug || "",
      };
    });

    const prompt = `You are an independent prediction market analyst. Today is ${new Date().toDateString()}.

Analyze these Polymarket prediction markets and give INDEPENDENT predictions based on your knowledge of current events, history, and logic — NOT just the crowd probability.

For each market think about:
1. What you know about this topic from your training data
2. Whether the crowd probability seems accurate, too high, or too low
3. Historical base rates for similar events
4. Any logical reasons the crowd might be wrong

Return ONLY a valid JSON array. No markdown, no backticks, no text outside the JSON array.

Each object must have exactly these fields:
- question: string
- crowdFavorite: string (copy from input)
- crowdConfidence: number (copy from input)
- myFavorite: string (YOUR independent pick - can differ from crowd)
- myConfidence: number (YOUR independent probability 0-100)
- edge: number (myConfidence minus crowdConfidence if same pick, or negative if different pick)
- edgeType: exactly one of "value", "confirm", or "fade"
- reasoning: string (2-3 sentences explaining your independent analysis)
- score: number (0-100 overall bet quality score)
- flags: array of 2-4 short signal strings like ["92% crowd confidence", "$2M volume", "closes in 3d"]
- slug: string (copy from input)

edgeType rules:
- "confirm" = you agree with crowd and confidence is similar
- "value" = you agree with crowd but your confidence is higher (you see more evidence)
- "fade" = you disagree with crowd, bet the other outcome

Only include markets with score >= 35. Sort by score descending. Return max 12 markets.

Markets:
${JSON.stringify(topMarkets, null, 2)}`;

    let analysis = null;
    let aiUsed = "";

    // Try Groq first (free, fast)
    if (GROQ_KEY) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_KEY}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: 4000,
          })
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || "";
        const clean = text.replace(/```json|```/g, "").trim();
        const match = clean.match(/\[[\s\S]*\]/);
        if (match) { analysis = JSON.parse(match[0]); aiUsed = "Groq (Llama 3.3 70B)"; }
      } catch (e) { console.log("Groq failed:", e.message); }
    }

    // Fallback to Gemini
    if (!analysis && GEMINI_KEY) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 4000 }
            })
          }
        );
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const clean = text.replace(/```json|```/g, "").trim();
        const match = clean.match(/\[[\s\S]*\]/);
        if (match) { analysis = JSON.parse(match[0]); aiUsed = "Google Gemini 1.5 Flash"; }
      } catch (e) { console.log("Gemini failed:", e.message); }
    }

    if (!analysis) throw new Error("Both AI providers failed. Check your API keys in Netlify environment variables.");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ markets: analysis, analyzedAt: new Date().toISOString(), aiUsed })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
