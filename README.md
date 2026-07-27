# Experience OS（観察記録）

「経験を未来へ託す」ための個人用・植物観察記録アプリ（Phase1プロトタイプ）。

Claude.aiのartifactとして作られたものを、Vercel等に単体でデプロイできる形に切り出しています。

## 構成

```
experience-os/
├── api/
│   └── diagnose.js      # AI診断(写真+Web検索)用のサーバー関数。APIキーはここでのみ扱う
├── src/
│   ├── App.jsx          # アプリ本体（元のartifactコードそのまま）
│   ├── main.jsx         # エントリーポイント
│   └── storage.js       # ブラウザのIndexedDBを使った保存機能
├── index.html
├── package.json
└── vite.config.js
```

## 機能

- 植物ごとの観察記録（写真・症状・原因・試したこと・結果・メモ）
- 症状などの自由記載から、原因の候補を自動提案（APIなし・常にローカルで動作）
- 写真の見た目の近さだけで過去記録を探す「診断」タブ（APIなし）
- 写真+AI（Claude）による原因診断（Web検索込み・要APIキー）

## ローカルで動かす

```bash
npm install
npm run dev
```

`http://localhost:5173` で開けます。

**注意**：`npm run dev`（Viteのみ）では `api/diagnose.js` は動きません。AI診断（写真+ネット検索）機能もローカルで試したい場合は、[Vercel CLI](https://vercel.com/docs/cli) を使ってください。

```bash
npm install -g vercel
vercel dev
```

`.env.example` を `.env` にコピーし、`ANTHROPIC_API_KEY` を設定してから実行してください。

## Vercelにデプロイする（すべての機能が使える構成）

1. このリポジトリをGitHubにpushする
2. [Vercel](https://vercel.com/) で「Add New Project」→ このリポジトリを選択（フレームワークはVite/Otherとして自動検出されます）
3. プロジェクト設定 → Environment Variables に `ANTHROPIC_API_KEY` を追加（[console.anthropic.com](https://console.anthropic.com/) で発行）
4. Deploy

これで、記録・自動原因候補・画像類似度診断はAPIキーなしでそのまま動作し、写真+AI診断（Web検索込み）機能はサーバー側のAPIキーを使って安全に動作します。

## GitHub Pagesにデプロイする（静的ホスティングのみ）

**重要な制限**：GitHub Pagesは静的ファイルしか置けないホスティングです。`api/diagnose.js`のようなサーバー機能は動かないため、**「AIで診断する」（写真+Web検索によるAI診断）ボタンだけは動作しません**。記録の保存・原因の自動候補・写真の類似度診断（診断タブ）は、すべてブラウザだけで完結する機能なので問題なく動きます。すべての機能を使いたい場合はVercelでのデプロイをおすすめします。

セットアップ手順：

1. リポジトリの Settings → Pages を開く
2. 「Build and deployment」の Source を **「GitHub Actions」** に設定する
3. `vite.config.js` の `base` を、実際のリポジトリ名に合わせて書き換える（現在は `/vegetable-NOTE/` を設定済み。リポジトリ名を変えた場合はここも変更してください）
4. `main` ブランチにpushすると、`.github/workflows/deploy.yml` が自動でビルド・公開します（デフォルトブランチが `master` の場合はワークフロー内の `branches: ["main"]` を書き換えてください）
5. 数分後、`https://<ユーザー名>.github.io/vegetable-NOTE/` で公開されます

### 白い画面になる場合のチェックリスト

- `vite.config.js` の `base` がリポジトリ名と一致しているか（`/vegetable-NOTE/` のように前後に `/` が必要）
- Settings → Pages の Source が「GitHub Actions」になっているか（「Deploy from a branch」のままだと、このworkflowでは公開されません）
- Actionsタブでワークフローが失敗していないか

## データの保存について

記録はブラウザ内蔵のIndexedDBに保存されます（この端末・このブラウザだけに保存され、他の端末とは同期されません）。将来、複数端末で使いたい場合はサーバー側のデータベースへの移行が必要です（プロジェクトの基本設計書のPhase3に対応します）。

## 既知の制限

- 画像類似度診断（診断タブ）は、簡易的な視覚的類似度（dHash）による判定です。実際の病気・症状を認識しているわけではなく、あくまで「見た目が近い写真を探す」機能です。
- AI診断（API使用）は情報量やAIの回答精度に左右されるため、参考情報として扱ってください。
