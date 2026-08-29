# llm-fetch

[English](./README.md)

`llm-fetch`は、LLMを使うNode.jsアプリにWeb検索とページ本文の取得を追加するTypeScript製ライブラリです。検索結果や取得ページを外部から届く未信頼データとして扱い、モデル向けのツール出力を作る前にプロンプトインジェクションを検査します。

Python、Docker、SearXNG、常駐サービスは不要です。通常のページはHTTPで取得し、JavaScriptで本文を生成するページだけ、任意でPlaywrightへ切り替えられます。

> [!NOTE]
> 現在は公開準備中です。`@scope/llm-fetch`は仮のパッケージ名で、誤公開を防ぐため`private: true`にしています。npmへ公開する前にscopeを決め、`private`を外してください。

## 動作環境

- Node.js 22以上
- ESM / CommonJS

コア機能の直接依存はCheerioだけです。OpenAI SDK、AWS SDK、Playwright、ブラウザ本体は標準インストールに含みません。

## インストール

```sh
npm install @scope/llm-fetch
```

## まず検索して本文を読む

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";

const web = createLlmFetch({
  search: duckDuckGo(),
});

try {
  const result = await web.searchAndRead({
    query: "TypeScript Web検索",
    limit: 5,
  });

  for (const document of result.documents) {
    console.log(document.title, document.finalUrl);
    console.log(document.text);
    console.log(document.security.decision);
  }
} finally {
  await web.close();
}
```

`searchAndRead()`は、検索に成功したページを並行して取得します。ページ単位の失敗は`failures`へ入り、ほかのページの取得は続行します。検索自体が失敗した場合は例外になります。

| API | 用途 |
| --- | --- |
| `search()` | 検索結果だけを取得する |
| `read()` | 指定したURLから本文を取得する |
| `searchAndRead()` | 検索と本文取得をまとめて行う |
| `toolset()` | OpenAI / Bedrock向けのツール定義と実行処理を作る |
| `close()` | キャッシュ、ブラウザ、内部プロキシを終了する |

## 検索プロバイダー

### DuckDuckGo

DuckDuckGoはAPIキーなしで利用できます。

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
});
```

通常はDuckDuckGoの検索ページからVQDトークン付きのpreload URLを取得し、`links.duckduckgo.com/d.js`から検索結果を読みます。URLのホスト名、パス、検索語、VQDトークンを照合し、返されたJavaScriptは実行しません。必要なJSON配列だけを解析します。

この経路がbot challenge、通信失敗、構造変更で使えない場合は、DuckDuckGoのHTML版、Lite版の順に切り替えます。いずれも安定した検索APIではないため、仕様変更、アクセス制限、bot challengeは起こり得ます。失敗を空の検索結果にはせず、原因を判別できるエラーとして返します。

SearXNGとAGPLコードは使っていません。CAPTCHAの解答やプロキシの切り替えも行いません。

### Brave Searchへ切り替える

DuckDuckGoが一時的に使えない場合だけBrave Searchを試す構成です。

```ts
import {
  brave,
  createLlmFetch,
  duckDuckGo,
  fallbackSearch,
} from "@scope/llm-fetch";

const web = createLlmFetch({
  search: fallbackSearch([
    duckDuckGo({ timeoutMs: 2_500 }),
    brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY! }),
  ]),
});
```

次のプロバイダーへ進むのは、先のプロバイダーが再試行可能なエラーを返した場合だけです。検索結果が0件だった場合や入力に誤りがある場合は切り替えません。Brave Searchでは`timeRange`を鮮度フィルターへ、`locale`を`search_lang`へ渡します。

検索語は最大400文字です。検索チェーン全体の既定期限は10秒で、`searchTimeoutMs`で変更できます。DuckDuckGoのbot challengeとDuckDuckGo / Braveのアクセス制限を検知した後は、同じプロセスから短時間に再送しないよう、プロバイダーごとに待機時間を設けます。

独自の検索サービスは`custom()`を使い、`SearchProvider`として登録できます。

## URLを指定して本文を読む

```ts
const document = await web.read({
  url: "https://example.com/article",
  maxCharacters: 20_000,
  requestedUse: "answer_with_citation",
});
```

接続先は、公開ネットワーク上のHTTP / HTTPSと標準ポートに限ります。接続前にDNSの応答を検査して接続先IPを固定し、リダイレクトのたびに同じ検査をやり直します。圧縮前と展開後の本文には別々の容量上限があります。

`read()`は、アプリケーション内で扱う用途として最大100,000文字を返せます。LLMへ渡す場合は、後述する`toolset()`の短い出力を使ってください。

## JavaScriptで本文を作るページ

Playwrightは任意機能です。静的HTMLから十分な本文を得られなかった場合だけChromiumを使うには、ブラウザ実行環境を追加します。

```sh
npm install @scope/llm-fetch @playwright/browser-chromium
```

ブラウザ本体を自分で管理する場合は、次の構成も使えます。

```sh
npm install @scope/llm-fetch playwright-core
npx playwright-core install --only-shell chromium
```

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";
import { playwrightRetriever } from "@scope/llm-fetch/playwright";

const web = createLlmFetch({
  search: duckDuckGo(),
  browser: {
    retriever: playwrightRetriever({ concurrency: 2 }),
    defaultRender: "auto",
  },
});

const document = await web.read({
  url: "https://example.com/app",
  render: "auto",
});
```

`render: "auto"`は最初にHTTP取得を試します。本文が不足し、`playwright-core`とChromiumが利用できる場合だけブラウザへ切り替えます。依存パッケージまたはブラウザ本体がなければ切り替えず、元の`CONTENT_INSUFFICIENT`を返します。`render: "always"`はブラウザを明示的に要求する設定なので、実行環境がなければ`CONFIG_MISSING`になります。

HTTP取得、ブラウザ待ち、ページ移動、本文抽出、Context Guardは、既定15秒の同じ期限を共有します。ブラウザへ切り替わっても残り時間はリセットされません。期限は`readTimeoutMs`で変更できます。

ブラウザプロセスは再利用しますが、ページごとに新しい非永続BrowserContextを作ります。標準設定では、GET以外のリクエスト、サブフレーム、ポップアップ、ダウンロード、WebSocket、Service Worker、プライベートネットワークへの接続、不要な画像・動画・音声・フォントを止めます。表示状態の判定はページ側から上書きされにくいisolated worldで行い、CSSによって隠された内容もContext Guardの検査対象にします。

Chromiumのプロセスsandboxは標準で有効です。`externalSandbox: true`は、別のコンテナやsandboxで隔離している場合にだけ使ってください。内蔵の接続制御とDNS pinningプロキシは防御を重ねる仕組みであり、OS単位のネットワークsandboxではありません。実行ホストから社内ネットワークなどへ接続できる環境では、コンテナや外向き通信の制限も併用してください。

## LLMのツールとして使う

```ts
const toolset = web.toolset();

const openaiTools = toolset.openaiDefinitions();
const bedrockTools = toolset.bedrockDefinitions();

const output = await toolset.execute("web_search", {
  query: "Node.js HTTP security",
  limit: 5,
});
```

OpenAI SDKとAWS SDKは不要です。ツール定義は通常のJSONとして生成します。

`web_search`は既定で5件を返し、外部由来のタイトルと要約を短く制限します。危険度が高いプロンプトインジェクションを含む検索結果は出力しません。`fetch_content`は既定5,000文字、最大20,000文字です。LLMへ返すのは引用用URL、可視本文、取得時刻、打ち切りの有無、短い安全性情報だけです。HTML構造、script、style、イベント属性、非表示内容、生のレスポンス情報、詳細な検査ログは含めません。

低レベルAPIの`search()`が返すタイトルと要約も、外部サイト由来の未信頼データです。アプリケーションのsystem prompt（システム指示）や命令文へ直接連結しないでください。LLMへ渡す場合は、検査と出力制限が入る`toolset()`を使います。

## Context Guardで行う検査

取得した文書は、検出結果が0件でも`trust: "untrusted"`、`tainted: true`になります。内蔵Context Guardは無効化できません。

検査では、可視本文、非表示内容、HTMLコメント、メタデータ、template、信頼度の低い属性を分けます。Unicode、zero-width文字、URL / hex escape、Base64、区切り文字による分割、leetspeakによる難読化を、処理量に上限を設けて正規化します。そのうえで、命令の上書き、役割変更、秘密情報の送信要求、ツール実行、外部送信、memory変更、policy変更、出典の隠蔽、出力形式の強制などを判定します。

厳しめに判定する場合は`strict`プロファイルを指定します。

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
  contextGuard: { profile: "strict" },
});
```

組織独自の`ContentGuard`も追加できます。内蔵Guardとのうち、厳しい方の判定を採用します。追加Guardの既定期限は5秒で、`additionalGuardTimeoutMs`から変更できます。追加Guardが返す文字列、検出件数、理由にも上限があります。

Context Guardは、取得した文章が安全であることを証明する機能ではありません。HTTP取得では外部スタイルシートによる非表示状態まで判断できず、ブラウザ利用時も文章の意味を完全には判定できません。書き込みツール、コード実行、外部送信、memory更新、policy変更などの操作は、アプリケーション側で別の承認手順を設けてください。

`fetcher`はテストや特殊な接続方式のための上級者向け設定です。指定すると内蔵のSSRF対策付きHTTP通信処理を置き換えます。本番環境で差し替える場合は、接続先IP、リダイレクト、容量、content-type、期限を同等に検査してください。独自プロバイダー、retriever、fetcher、Guardは、受け取った`AbortSignal`に従う必要があります。

## エラーを処理する

```ts
import { LlmFetchError } from "@scope/llm-fetch";

try {
  await web.read({ url: "http://127.0.0.1/admin" });
} catch (error) {
  if (error instanceof LlmFetchError) {
    console.error(error.code, error.retryable);
  }
}
```

内蔵プロバイダーとHTTP通信処理は、取得したHTML、検索レスポンス、Cookie、APIキーをエラーメッセージへ含めません。独自実装を追加する場合も、同じ情報をログや例外へ出さないでください。

`close()`は複数回呼んでも問題ありません。終了処理を始めたクライアントは再利用できず、新しい操作は`CONFIG_MISSING`になります。

## 開発と検証

```sh
npm install
npm run verify
npm pack --dry-run
```

インストール済みChromiumを使う結合テストは、明示的に有効化します。

```sh
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 \
  npx vitest run test/playwright/integration.test.ts
```

`npm run verify`はLint、型検査、単体・セキュリティテスト、本番依存のライセンス検査、ESM / CommonJS / 型定義、コア機能だけのインストールを確認します。

## ライセンス

llm-fetchは[MIT License](./LICENSE)で公開します。DuckDuckGo、Brave、Playwright、Chromiumなどの外部サービスや依存ソフトウェアには、それぞれの利用条件とライセンスがあります。
