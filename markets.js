exports.handler = async function(event, context) {
  const GAMMA = "https://gamma-api.polymarket.com";
  const path = event.queryStringParameters?.path || "markets";
  const slug = event.queryStringParameters?.slug || "";

  let apiUrl = `${GAMMA}/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false`;
  if (slug) apiUrl = `${GAMMA}/markets?slug=${slug}`;

  try {
    const res = await fetch(apiUrl, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
