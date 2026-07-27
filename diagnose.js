// Vercel Serverless Function
// ブラウザから直接 Anthropic API を呼ぶと API キーが公開されてしまうため、
// このサーバー側の関数を経由させることでキーを隠します。
// フロントエンド（src/App.jsx）は "/api/diagnose" にリクエストを送るだけで、
// 送った内容（model, max_tokens, messages, tools）はそのまま Anthropic API に転送されます。

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: "サーバーに ANTHROPIC_API_KEY が設定されていません。Vercelの環境変数を確認してください。" },
    });
    return;
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: "Anthropic API への接続に失敗しました。" } });
  }
}
