exports.handler = async function(event) {
  const GAMMA = "https://gamma-api.polymarket.com";
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const params = event.queryStringParameters || {};

  // Route: /markets?slug=xxx — check single market result
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

  // Route: /markets?analyze=true — fetch + AI analyze
  try {
    // Step 1: Fetch top markets from Polymarket
    const marketsRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=50&order=volume24hr&ascending=false`,
      { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
    );
    const markets = await marketsRes.json();

    // Step 2: Prepare top 15 markets for AI analysis
    const topMarkets = markets.slice(0, 15).map(m => {
      let prices = [], outcomes = [];
      try { prices = JSON.parse(m.outcomePrices || "[0.5,0.5]").map(Number); } catch {}
      try { outcomes = JSON.parse(m.outcomes || '["Yes","No"]'); } catch {}
      const bestIdx = prices.indexOf(Math.max(...prices));
      const endDate = m.endDate ? new Date(m.endDate) : null;
      const daysLeft = endDate ? Math.round((endDate - new Date()) / 86400000) : null;
      return {
        question: m.question,
        outcomes,
        crowdProbabilities: prices.map((p, i) => `${outcomes[i]}: ${Math.round(p*100)}%`),
        crowdFavorite: outcomes[bestIdx],
        crowdConfidence: Math.round(prices[bestIdx] * 100),
        volume: Math.round(parseFloat(m.volume || 0)),
        liquidity: Math.round(parseFloat(m.liquidity || 0)),
        daysLeft,
        slug: m.slug || "",
      };
    });

    // Step 3: Send to Claude AI with web search for independent analysis
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `You are an independent prediction market analyst. Your job is to analyze Polymarket markets and give INDEPENDENT predictions based on real-world evidence — NOT just the crowd probability.

For each market:
1. Use web_search to find recent news and facts about the topic
2. Compare your research findings to what the crowd thinks
3. Identify if the crowd is OVERCONFIDENT, UNDERCONFIDENT, or ACCURATE
4. Give your own independent probability estimate
5. Score the bet quality 0-100 based on: your confidence + evidence strength + value vs crowd

Return ONLY a valid JSON array. No markdown, no backticks, no explanation outside the JSON.

Each object must have:
- question: string
- crowdFavorite: string (what crowd bets on)
- crowdConfidence: number (crowd's %)
- myFavorite: string (YOUR independent pick)
- myConfidence: number (YOUR independent %)
- edge: number (difference between your confidence and crowd's, can be negative)
- edgeType: "value" | "confirm" | "fade" (value=crowd wrong, confirm=crowd right, fade=bet against crowd)
- reasoning: string (2-3 sentences explaining your independent analysis based on news/facts)
- score: number (0-100, your overall bet quality score)
- flags: array of short signal strings
- slug: string

Only include markets with score >= 35. Sort by score descending. Return max 12 markets.`,
        messages: [{
          role: "user",
          content: `Today is ${new Date().toDateString()}. Analyze these Polymarket prediction markets independently using web search to find real evidence. Give me your genuine independent predictions:\n\n${JSON.stringify(topMarkets, null, 2)}`
        }]
      })
    });

    const claudeData = await claudeRes.json();

    // Extract final text response from Claude
    const textBlock = claudeData.content
      ? claudeData.content.filter(b => b.type === "text").map(b => b.text).join("")
      : "";

    if (!textBlock) {
      throw new Error("No AI response received");
    }

    // Parse JSON from response
    const jsonMatch = textBlock.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Could not parse AI analysis");

    const analysis = JSON.parse(jsonMatch[0]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ markets: analysis, analyzedAt: new Date().toISOString() })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
