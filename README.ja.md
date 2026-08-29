# llm-fetch

[npmパッケージ](https://www.npmjs.com/package/llm-fetch) · [English](./README.md)

`llm-fetch`は、LLMを使うNode.jsアプリにWeb検索とページ本文の取得を追加するTypeScript製ライブラリです。検索結果や取得ページを外部から届く未信頼データとして扱い、モデル向けのツール出力を作る前にプロンプトインジェクションを検査します。

Python、Docker、SearXNG、常駐サービスは不要です。通常のページはHTTPで取得し、JavaScriptで本文を生成するページだけ、任意でPlaywrightへ切り替えられます。

## 動作環境

- Node.js 20.19以上、またはBun 1.3.14以上
- ESM / CommonJS

コア機能の直接依存はCheerioだけです。OpenAI SDK、AWS SDK、Playwright、ブラウザ本体は標準インストールに含みません。

## インストール

```sh
npm install llm-fetch
```

## まず検索して本文を読む

```ts
import { createLlmFetch, duckDuckGo } from "llm-fetch";

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

`searchAndRead()`はページを並行取得し、同じhostへの同時接続は既定2件に抑えます（全体の並列数が1なら1件）。ページ単位の失敗は`failures`へ入り、ほかの結果は残ります。検索後に全体期限へ達した場合も、完了済み文書を保持して`timedOut: true`を返し、処理中と未開始のURLを別のfailure kindで示します。呼び出し側の`AbortSignal`と検索自体の失敗は例外になります。

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

DuckDuckGo対応はexperimental / best-effortです。契約されたAPIと予測しやすい可用性が必要な本番用途では、Brave Searchまたは審査済みのcustom Providerを使用してください。

SearXNGとAGPLコードは使っていません。CAPTCHAの解答やプロキシの切り替えも行いません。

### Brave Searchへ切り替える

DuckDuckGoが一時的に使えない場合だけBrave Searchを試す構成です。

```ts
import {
  brave,
  createLlmFetch,
  duckDuckGo,
  fallbackSearch,
} from "llm-fetch";

const web = createLlmFetch({
  search: fallbackSearch([
    duckDuckGo({ timeoutMs: 2_500 }),
    brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY! }),
  ]),
});
```

次のプロバイダーへ進むのは、先のプロバイダーが再試行可能なエラーを返した場合だけです。検索結果が0件だった場合や入力に誤りがある場合は切り替えません。言語はISO 639-1の`language`（`ja`、`en`など）、地域はISO 3166-1 alpha-2の`region`（`JP`、`US`など）で指定します。Braveは`search_lang`と`country`へ、DuckDuckGoは地域コードへ変換します。旧`locale`は非推奨で、新しい項目と同時指定できません。

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

本文取得だけなら検索プロバイダーは不要です。その場合も`read()`と`fetch_content`は使えますが、`search()`は`CONFIG_MISSING`になり、ツール定義から`web_search`が除かれます。

## JavaScriptで本文を作るページ

Playwrightは任意機能です。静的HTMLから十分な本文を得られなかった場合だけChromiumを使うには、ブラウザ実行環境を追加します。

```sh
npm install llm-fetch @playwright/browser-chromium
```

ブラウザ本体を自分で管理する場合は、次の構成も使えます。

```sh
npm install llm-fetch playwright-core
npx playwright-core install --only-shell chromium
```

```ts
import { createLlmFetch, duckDuckGo } from "llm-fetch";
import { playwrightRetriever } from "llm-fetch/playwright";

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

`render: "auto"`は最初にHTTP取得した生HTMLをGuardで検査します。検査を通過した本文が不足し、`playwright-core`とChromiumが利用できる場合だけブラウザへ切り替えます。依存パッケージまたはブラウザ本体がなければ、元の`CONTENT_INSUFFICIENT`を返します。`render: "always"`は二重取得を避けるため、JavaScript実行前の生HTML検査を行いません。secret、認証済み状態、Node.js binding、高権限toolを渡さないでください。

HTTP取得、ブラウザ待ち、ページ移動、本文抽出、Context Guardは、既定15秒の同じ期限を共有します。ブラウザへ切り替わっても残り時間はリセットされません。期限は`readTimeoutMs`で変更できます。

ブラウザプロセスは再利用しますが、ページごとに新しい非永続BrowserContextを作ります。標準設定で許可するmethodはGET / HEADだけです。それ以外のmethod、サブフレーム、ポップアップ、ダウンロード、WebSocket、Service Worker、プライベートネットワークへの接続、不要な画像・動画・音声・フォントを止めます。表示状態の判定はisolated worldで行い、CSSによって隠された内容もContext Guardの検査対象にします。

Chromiumのプロセスsandboxは標準で有効です。`externalSandbox: true`は、別のコンテナやsandboxで隔離している場合にだけ使ってください。内蔵の接続制御とDNS pinningプロキシは防御を重ねる仕組みであり、OS単位のネットワークsandboxではありません。実行ホストから社内ネットワークなどへ接続できる環境では、コンテナや外向き通信の制限も併用してください。

## LLMのツールとして使う

```ts
const toolset = web.toolset();

const responsesTools = toolset.openaiResponsesDefinitions();
const chatCompletionsTools = toolset.openaiChatCompletionsDefinitions();
const bedrockTools = toolset.bedrockDefinitions();

const output = await toolset.execute("web_search", {
  query: "Node.js HTTP security",
  limit: 5,
});
```

OpenAI SDKとAWS SDKは不要です。ツール定義は通常のJSONとして生成します。

`web_search`は既定で5件を返し、外部由来のタイトルと要約を短く制限します。危険度が高いプロンプトインジェクションを含む検索結果は出力しません。`fetch_content`は既定5,000文字、最大20,000文字です。LLMへ返すのは引用用URL、可視本文、取得時刻、打ち切りの有無、短い安全性情報だけです。HTML構造、script、style、イベント属性、非表示内容、生のレスポンス情報、詳細な検査ログは含めません。

低レベルAPIの`SearchHit`と`searchAndRead().hits`にも`trust: "untrusted"`、`tainted: true`が付きます。タイトルと要約をsystem promptや命令文へ直接連結しないでください。LLMへ渡す場合は`toolset()`を使います。`openaiDefinitions()`はChat Completions形式の非推奨aliasとして残しています。

## Context Guardで行う検査

取得した文書は、検出結果が0件でも`trust: "untrusted"`、`tainted: true`になります。内蔵Context Guardは無効化できません。

検査では、可視本文、非表示内容、HTMLコメント、メタデータ、template、信頼度の低い属性を分けます。長すぎるsegmentは先頭と末尾を検査し、件数や文字数の上限で欠落が出た場合は必ず安全側へ倒して`limitations`へ理由を残します。HTTP charset、BOM、HTML metaはclientと単独Guardで同じdecoderを使い、BOMを優先します。未対応または不正な文字コードは`UNSUPPORTED_CONTENT_ENCODING`になります。

厳しめに判定する場合は`strict`プロファイルを指定します。

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
  contextGuard: { profile: "strict" },
});
```

組織独自の`ContentGuard`も追加できます。内蔵Guardとのうち、厳しい方の判定を採用します。追加Guardの既定期限は5秒で、`additionalGuardTimeoutMs`から変更できます。追加Guardが返す文字列、検出件数、理由にも上限があります。

Context Guardは、取得した文章が安全であることを証明する機能ではありません。HTTP取得では外部スタイルシートによる非表示状態まで判断できず、ブラウザ利用時も文章の意味を完全には判定できません。書き込みツール、コード実行、外部送信、memory更新、policy変更などの操作は、アプリケーション側で別の承認手順を設けてください。

`fetcher`は上級者向け設定で、内蔵のSSRF対策付き通信処理を置き換えます。本番の独自実装は、接続先IP、DNS rebinding、redirect、容量、content-type、期限をすべて負担します。clientは返されたURLの形式と明白なlocal/private literalを再検査しますが、独自実装が実際に接続したIPまでは保証できません。独自provider、retriever、fetcher、Guardが`AbortSignal`を無視した場合、clientは待機を終了できても内部処理までは停止できません。

## エラーを処理する

```ts
import { LlmFetchError } from "llm-fetch";

try {
  await web.read({ url: "http://127.0.0.1/admin" });
} catch (error) {
  if (error instanceof LlmFetchError) {
    console.error(error.code, error.retryable, error.guardDecision);
  }
}
```

内蔵プロバイダーとHTTP通信処理は、取得したHTML、検索レスポンス、Cookie、APIキーをエラーメッセージへ含めません。独自実装を追加する場合も、同じ情報をログや例外へ出さないでください。

`GUARD_DENIED`の`guardDecision`で`require_approval`と`deny`を区別できます。`warningCategories`には短い分類名だけが入り、JSON化しても本文やcauseは出ません。既定値と推奨処理は[API・エラー一覧](./docs/API.md)にまとめています。

## 制約、privacy、利用上の責任

Shadow DOM、CSS generated content、canvasや画像内の文字、iframe本文、外部CSS本文は抽出しません。接続先は標準HTTP / HTTPS portだけです。browser modeでは第三者JavaScriptを実行します。検索語は選択したproviderへ送られ、取得先サイトには利用者のIP、User-Agent、アクセス時刻などが伝わります。providerとsiteの利用条件、robots、頻度、個人情報、著作権を確認してください。詳しくは[Responsible use and privacy](./docs/RESPONSIBLE_USE.md)を参照してください。

`close()`は複数回呼んでも問題ありません。終了処理を始めたクライアントは再利用できず、新しい操作は`CONFIG_MISSING`になります。

## 開発と検証

```sh
npm install
npm run verify
npm pack --dry-run
```

Brave Providerをローカルで疎通確認する場合は、`.env.example`を`.env`へコピーして`BRAVE_SEARCH_API_KEY`を設定し、`npm run canary:brave`を実行します。`.env`はGitの除外対象であり、commitしないでください。成功時はprovider名と取得件数、失敗時はprovider、失敗状態、型付きerror codeだけを出力します。DuckDuckGoはsecret不要の`npm run canary:duckduckgo`で確認できます。

インストール済みChromiumを使う結合テストは、明示的に有効化します。

```sh
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 \
  npx vitest run test/playwright/integration.test.ts
```

`npm run verify`はLint、型検査、単体・セキュリティテスト、coverage、本番依存のlicense、pack後のESM / CommonJS / NodeNext / bundler、core-only install、`publint`、Are The Types Wrongを確認します。Chromiumは非rootのsandbox付きcontainerで別jobとして検証します。

保守担当者向けの公開準備と、初回だけ必要なnpmパッケージ名の登録手順は[Release runbook](./docs/RELEASE.md)にまとめています。

## ライセンス

llm-fetchは[MIT License](./LICENSE)で公開します。DuckDuckGo、Brave、Playwright、Chromiumなどの外部サービスや依存ソフトウェアには、それぞれの利用条件とライセンスがあります。
