# `llm-fetch` 実装計画

## 1. 結論

`llm-fetch` は、Node.js / TypeScriptだけで動く軽量なWeb検索・本文取得SDKとして実装する。

- 検索Provider: DuckDuckGo、Brave、Custom
- 本文取得: 標準はHTTP/HTTPSのみ。Playwright / Chromiumは任意subpathとして追加済み
- 実装言語: TypeScript
- 実行環境: Node.js 22以上
- 外部常駐サービス: 不要
- Python、Docker、SearXNG、Puppeteer: 使用しない
- Playwright: コアから分離した任意subpathでのみ使用し、HTTP-firstを維持する
- コンテキスト防御: 外部コンテンツを常に未信頼・taintedとして隔離
- Prompt Injection検査: 純TypeScriptの内蔵Context Guardを標準有効化
- パッケージライセンス: Apache-2.0を第一候補とする

SearXNGはAGPL-3.0のため採用しない。DuckDuckGoは公式の安定したWeb検索APIではないため、通常検索ページが発行する署名付きpreloadを主経路、公式に案内されているHTML/Lite版を代替経路とするbest-effort Providerとして扱う。

標準インストールはTypeScriptだけで動かし、Prompt Shieldをruntime依存にしない。`llm-fetch`本体にtaint、provenance、hidden content検出、難読化解除、rule scanning、action-aware policy、権限分離を内蔵する。Prompt Shieldは脅威モデル、型、検査順序、fixtureの設計参考としてのみ使用する。

DuckDuckGoの通常検索preload、HTML版、Lite版はいずれもアプリケーション向けの安定したAPI契約ではない。そのため、構造変更、rate limit、bot challengeを正常な空結果として扱わず、型付きエラーとして呼び出し側へ返す。preloadはDuckDuckGoがbootstrap内で発行したURLだけを許可し、JavaScriptとして実行せず結果JSONだけを解析する。

- [DuckDuckGoの非JavaScript版](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript)
- [DuckDuckGoのアプリ・パートナー向けガイドライン](https://duckduckgo.com/duckduckgo-help-pages/company/partnerships)
- [SearXNGのライセンス](https://github.com/searxng/searxng/blob/master/LICENSE)

## 2. 目的

複数のLLMアプリで繰り返し実装している以下の処理を、npmパッケージの導入と数行の設定だけで利用できるようにする。

1. Web検索
2. 検索結果URLの正規化と重複除去
3. SSRF対策付きのページ取得
4. HTMLからの本文抽出
5. LLMへ渡しやすい共通Document形式への変換
6. OpenAI / Bedrock向けツール定義とツール実行
7. 取得コンテンツを命令ではなく未信頼データとして扱うコンテキスト防御

利用側の基本形は次の通りとする。

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";

const web = createLlmFetch({
  search: duckDuckGo(),
});

const result = await web.searchAndRead({
  query: "TypeScript Web Retrieval",
  limit: 5,
});
```

Braveを利用する場合もクライアント側APIは変えない。

```ts
import { brave, createLlmFetch } from "@scope/llm-fetch";

const web = createLlmFetch({
  search: brave({
    apiKey: process.env.BRAVE_SEARCH_API_KEY!,
  }),
});
```

DuckDuckGo障害時だけBraveへ切り替える構成も提供する。

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

`fallbackSearch`は順番に実行し、最初のProviderがretryable errorを返した場合だけ次へ進む。空結果や入力エラーでは切り替えない。Braveへの不要な課金を避けるため、race/hedged requestは初版では実装しない。

## 3. スコープ

### v0.1に含めるもの

- DuckDuckGo署名付きWeb preload検索Provider
- DuckDuckGo HTML/Lite限定フォールバック
- Brave Search Provider
- Custom Providerインターフェース
- Providerの直列フォールバック
- SSRF対策付きHTTP本文取得
- 高速なCheerioベース本文抽出
- 本文品質判定
- URL正規化、追跡用リダイレクトURLの解除、重複除去
- 同時実行数制御
- in-flight requestの重複排除
- 小容量のメモリキャッシュ
- 構造化エラー
- 全取得結果へのtaint・provenance付与
- hidden要素、HTML comment、低信頼属性をLLM可視本文から除外
- 標準有効の純TypeScript Context Guard
- 追加検査用の`ContentGuard`インターフェース
- LLM向け共通ツール定義
- OpenAI / Bedrock形式への変換
- ESM / CommonJS両対応
- 任意のPlaywright / Chromiumによる動的ページ取得

### v0.1に含めないもの

- SearXNG
- Pythonサービス
- Docker Compose
- CAPTCHAやbot challengeの回避
- Proxyローテーション
- 大規模クロール、サイトマップ巡回、robots.txt管理
- PDF、Office文書、画像、動画の本文抽出
- 検索結果の永続DBキャッシュ
- 検索ランキングの独自再学習
- Rust/WASM、外部semantic modelを使う検知エンジン
- 取得コンテンツからのwrite tool、外部送信、コード実行、memory/policy更新

### 任意Playwright拡張に含めるもの

- CSR-only SPAなど、HTTP取得後の本文が不足した場合のChromiumフォールバック
- `@scope/llm-fetch/playwright` subpath
- Chromium 1プロセスの遅延起動と再利用
- ページ取得ごとの非永続BrowserContext
- `domcontentloaded`後のboundedなDOM安定待ち
- 画像、動画、音声、font、download、popup、WebSocket、Service Workerの標準ブロック
- HTTP(S)のGET / HEADだけを許可する全request interception
- loopbackで動く認証付きDNS-pinning forward proxy
- rendered DOM、computed style、hidden contentを同じ内蔵Context Guardへ渡す処理
- `render: "never" | "auto" | "always"`による明示的な取得方法選択

初版のPlaywright拡張はChromiumだけを対象とする。Firefox、WebKit、永続profile、CDP接続、利用者の既存ブラウザへの接続は、安全設定を一貫して強制できないため対象外とする。

高速稼働とは、アクセス制御を回避して大量リクエストを送ることではない。1回の検索・取得で発生するSDKオーバーヘッドを抑え、接続再利用、並列取得、キャッシュ、早期打ち切りによって低レイテンシ化することを指す。

## 4. 公開API

### 4.1 検索

```ts
export interface SearchInput {
  query: string;
  limit?: number; // 1〜20、既定値10
  safeSearch?: "strict" | "moderate" | "off";
  locale?: string;
  timeRange?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
}

export interface SearchHit {
  provider: string;
  rank: number;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(input: SearchInput): Promise<SearchHit[]>;
}
```

### 4.2 本文取得

```ts
export interface ReadInput {
  url: string;
  maxCharacters?: number;
  render?: "never" | "auto" | "always";
  signal?: AbortSignal;
}

export interface RetrievedDocument {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  excerpt?: string;
  contentType: string;
  fetchedAt: string;
  fetchMethod: "http" | "playwright";
  characterCount: number;
  truncated: boolean;
  source?: {
    provider: string;
    query: string;
    rank: number;
    snippet?: string;
  };
  security: {
    trust: "untrusted";
    tainted: true;
    guard: "builtin" | (string & {});
    findings: SecurityFinding[];
    assurance: "unassessed" | "low" | "medium" | "high";
    decision?: "allow" | "allow_with_warning" | "require_approval" | "deny";
    limitations: string[];
  };
}
```

### 4.3 検索と取得の一括実行

```ts
export interface SearchAndReadResult {
  hits: SearchHit[];
  documents: RetrievedDocument[];
  failures: Array<{
    url: string;
    error: LlmFetchError;
  }>;
  durationMs: number;
}
```

ページ1件の取得失敗で全体を失敗させない。検索自体が失敗した場合だけ`searchAndRead`をrejectし、ページ取得失敗は`failures`へ格納する。

### 4.4 LLMツール

```ts
const toolset = web.toolset();

const openaiTools = toolset.openaiDefinitions();
const bedrockTools = toolset.bedrockDefinitions();

const result = await toolset.execute(toolName, input);
```

OpenAI SDKやAWS SDKへ直接依存せず、JSONオブジェクトだけを生成する。アプリ固有ツールは利用側で結合する。

### 4.5 Context Guard

本文取得とコンテキスト利用判定を分離する。内蔵Context Guardは設定を省略しても必ず有効になり、追加の検査器を指定しても置き換えられない。

```ts
export type RequestedContextUse =
  | "summarize"
  | "answer_with_citation"
  | "extract_facts"
  | "search_more"
  | "call_readonly_tool";

export interface ContentGuard {
  inspect(input: {
    rawBody: Uint8Array;
    contentType: string;
    source: SourceMetadata;
    requestedUse: RequestedContextUse;
    signal?: AbortSignal;
  }): Promise<GuardResult>;
}

export interface SecurityFinding {
  category:
    | "instruction_override"
    | "role_redefinition"
    | "secret_exfiltration"
    | "tool_invocation"
    | "external_send"
    | "memory_write"
    | "policy_override"
    | "source_suppression"
    | "output_control"
    | "authority_claim"
    | "hidden_instruction"
    | "low_trust_attribute"
    | "benign_mention";
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  location:
    "visible" | "hidden" | "comment" | "attribute" | "meta" | "template";
  reason: string;
  techniques: string[];
  segmentHash: string;
}

export interface GuardResult {
  findings: SecurityFinding[];
  assurance: "unassessed" | "low" | "medium" | "high";
  decision: "allow" | "allow_with_warning" | "require_approval" | "deny";
  reasons: string[];
  limitations: string[];
}
```

通常は追加設定なしで利用する。

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
});
```

誤検知をより強く避ける用途と、疑わしいページを早めに遮断する用途のためにprofileだけを変更可能にする。無効化profileは提供しない。

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
  contextGuard: { profile: "strict" }, // 既定値はbalanced
  additionalGuard: companySpecificGuard,
});
```

検査器には抽出前のraw bodyを内部的に渡す。hidden contentを含む原文を検査した後、raw HTMLは破棄し、公開APIとLLM tool responseには含めない。追加guardを指定した場合は内蔵guardの結果と統合し、`deny > require_approval > allow_with_warning > allow`の順で厳しい判定を採用する。

## 5. 内部構成

```text
llm-fetch/
├── src/
│   ├── index.ts
│   ├── client.ts
│   ├── contracts.ts
│   ├── errors.ts
│   ├── providers/
│   │   ├── duckduckgo.ts
│   │   ├── duckduckgo-parser.ts
│   │   ├── brave.ts
│   │   ├── custom.ts
│   │   └── fallback.ts
│   ├── retrieval/
│   │   ├── content-retriever.ts
│   │   ├── outbound-policy.ts
│   │   ├── http-fetcher.ts
│   │   ├── extract-content.ts
│   │   ├── quality.ts
│   │   └── url-normalizer.ts
│   ├── playwright/
│   │   ├── index.ts
│   │   ├── retriever.ts
│   │   ├── browser-pool.ts
│   │   ├── pinned-proxy.ts
│   │   ├── request-policy.ts
│   │   └── rendered-dom-snapshot.ts
│   ├── security/
│   │   ├── contracts.ts
│   │   ├── context-guard.ts
│   │   ├── html-segments.ts
│   │   ├── normalize.ts
│   │   ├── rules.ts
│   │   ├── policy.ts
│   │   ├── untrusted-envelope.ts
│   │   └── merge-decisions.ts
│   ├── tools/
│   │   ├── canonical.ts
│   │   ├── openai.ts
│   │   └── bedrock.ts
│   └── internal/
│       ├── deadline.ts
│       ├── in-flight.ts
│       ├── lru-cache.ts
│       └── semaphore.ts
├── test/
│   ├── fixtures/
│   │   ├── duckduckgo-html/
│   │   ├── duckduckgo-lite/
│   │   └── articles/
│   ├── providers/
│   ├── retrieval/
│   ├── tools/
│   └── consumer/
├── bench/
│   ├── duckduckgo-parser.bench.ts
│   ├── extractor.bench.ts
│   └── search-and-read.bench.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## 6. DuckDuckGo Providerの実装

### 6.1 通常経路

通常時は`https://duckduckgo.com/?q=...&ia=web`からbootstrap HTMLを取得し、ページ内の`https://links.duckduckgo.com/d.js`署名付きpreloadを1回取得する。

検索条件は以下に限定する。

- `q`: 検索文字列
- `kp`: Safe Search
- `kl`: locale/region
- `df`: 期間
- `ia`: web

bootstrapのVQD tokenとpreload URL内のtoken、queryを照合する。preloadはHTTPS、既定port、`links.duckduckgo.com`、`/d.js`に固定し、任意hostへの接続を許可しない。返却scriptは実行せず、`DDG.pageLayout.load("d", [...])`のJSON配列だけをbounded parserで抽出する。通常は2リクエストになるが、現行のHTML/Lite直アクセスより安定し、同一ホストで実通信が成功することを優先する。

### 6.2 Web preload解析

結果payloadから次の情報だけを抽出する。

- title
- destination URL
- snippet
- display URL
- rank

titleとsnippetのHTML entityおよび強調tagはCheerioでplain textへ変換する。destination URLは`http:`と`https:`以外を拒否し、正規化後のURLで重複を除去する。

`anomalyDetectionBlock`、`bot_challenge`、既知のchallenge markerを結果payloadより先に検査する。結果配列が空の場合だけ空配列を返し、非空payloadが期待する構造と一致しない場合は`PARSE_CHANGED`とする。

Provider通信は`redirect: "manual"`で実行し、DuckDuckGoが既知のDuckDuckGoホストへ返すリダイレクトだけを許可する。検索ProviderのHTTPリダイレクトを自動追跡して任意ホストへ接続しない。

### 6.3 HTML/Liteフォールバック

署名付きWeb経路でretryableなchallenge、5xx、network error、構造変更が発生した場合は、`https://html.duckduckgo.com/html/`へform POSTする。HTML版も同様のretryable errorなら`https://lite.duckduckgo.com/lite/`を1回だけ試す。

HTML/Liteはブラウザ互換headerを使用し、DOMからtitle、destination URL、snippet、display URL、rankだけを抽出する。既知の「検索結果なし」表示がある場合だけ空配列を返す。

429と明確な4xxに対して経路切替を行わない。いずれかの正規経路が成功すればchallenge解決操作は行わず検索を完了し、全経路がchallengeになった場合はProvider単位でcooldownを設定して同じプロセスから短時間に再送しない。CAPTCHAの解答やProxyローテーションは実装しない。

### 6.4 DuckDuckGo固有エラー

- `RATE_LIMITED`
- `BOT_CHALLENGE`
- `UPSTREAM_HTTP`
- `PARSE_CHANGED`
- `RESPONSE_TOO_LARGE`
- `TIMEOUT`

エラーには`provider`、`retryable`、`status`、`cooldownMs`を付与する。HTML本文、Cookie、検索語をエラーメッセージやログへ出さない。

### 6.5 利用上の位置付け

DuckDuckGo ProviderはAPIキー不要で利用できるが、公式APIやSLAではない。公開・商用利用前にDuckDuckGoのガイドラインと利用形態を確認する。Providerは明示的opt-inとし、SDKが暗黙にDuckDuckGoへ問い合わせないようにする。

## 7. 高速化方針

### 7.1 依存関係を抑える

v0.1および標準entrypointの直接runtime依存は原則として`cheerio`だけにする。

- Node.js標準`fetch`を検索Provider通信に使う
- URL、AbortSignal、zlib、DNS、HTTP/HTTPSはNode.js標準機能を使う
- `duck-duck-scrape`、`ddg-kit`、Axios、Needleをruntime依存にしない
- JSDOM、Readability、ブラウザをv0.1および標準entrypointに入れない

既存ライブラリは実装・fixture設計の比較対象にはできるが、公開APIやruntime依存にはしない。

### 7.2 HTTP接続を再利用する

- 検索ProviderはNode.jsの接続poolを再利用する
- 本文取得はkeep-alive Agentをクライアント単位で共有する
- リクエストごとにAgentやClientを作らない
- クライアント終了用に`web.close()`を提供する

### 7.3 Deadlineを1回だけ設定する

リダイレクトやLiteフォールバックごとにtimeoutをリセットしない。呼び出し開始時にdeadlineを1つ作り、全処理で残り時間を共有する。

既定値:

- DuckDuckGo検索: 4秒
- Brave検索: 5秒
- HTTP transport: 10秒
- client `read`: 15秒
- `searchAndRead`: 15秒

### 7.4 並列取得

`searchAndRead`は検索結果を並列取得する。

- 既定同時実行数: 4
- 同一origin: 最大2
- 全体件数: 最大10
- 同一URLの同時リクエスト: 1回へ集約

無制限な`Promise.all`は使わず、軽量なTypeScript製Semaphoreで制御する。

### 7.5 キャッシュ

クライアント内に件数上限付きLRUキャッシュを持つ。

- 検索: 30秒
- 本文: 60秒
- 最大100エントリ
- 実行中Promiseは常に共有
- 完了後キャッシュは設定で無効化可能
- エラー、challenge、rate limitはキャッシュしない

### 7.6 本文抽出

Cheerioで一度だけHTMLをparseし、次の順序で本文候補を決定する。

1. `article`
2. `main`
3. `[role="main"]`
4. `#content`, `.content`, `.main`
5. `body`

`script`、`style`、`nav`、`header`、`footer`、`aside`、広告候補を除去し、候補ごとに本文長、リンク密度、段落数を計算して最良候補を選ぶ。

ReadabilityやJSDOMによる2回目のDOM構築は初版では行わない。品質不足は`CONTENT_INSUFFICIENT`として返し、将来の抽出器追加に備えてExtractorインターフェースだけ内部に設ける。

## 8. セキュリティ

### 8.1 HTTP・SSRF防御

`../nextjs-template/src/lib/mcp/outbound-url-policy.ts`を基礎に、以下をパッケージへ移植する。

- HTTP/HTTPS以外を拒否
- URL内認証情報を拒否
- private、loopback、link-local、reserved IPを拒否
- DNS解決結果を検証し、接続先IPを固定
- リダイレクトごとに再検証
- 最大リダイレクト数3
- wire sizeと展開後sizeの両方を制限
- Content-Type制限
- 全体deadline

移植時は制限値を内部定数ではなく`createLlmFetch`の設定から上書き可能にする。ただしprivate networkを一括許可するオプションは提供しない。

DuckDuckGoとBraveのProvider endpointはパッケージ内の固定値とし、利用者が任意URLへ差し替えられないようにする。任意の社内検索APIは`custom()`経由で明示的に登録する。

### 8.2 コンテキストインジェクション防御

`../prompt-guard`は存在せず、同階層の実装は`../prompt-shield`だった。Prompt Shieldのthreat model、`GuardedReference`、HTML抽出、scanner、policy、regression fixtureを設計資料として再利用する。

内蔵Context GuardはTypeScriptだけで次を必ず行う。

- Web、検索結果、tool responseなど外部由来の全データを`trust: "untrusted"`、`tainted: true`にする
- findingが0件でも安全とは判定せず、`assurance`と`limitations`を残す
- URL、最終URL、取得時刻、検索Provider、query、rankのprovenanceを保持する
- `hidden`、`display:none`、`visibility:hidden`、`opacity:0`、`font-size:0`の要素をLLM可視本文から除外する
- HTML comment、`aria-label`、`title`、`alt`など本文ではない低信頼属性を通常本文へ混ぜない
- raw HTMLをtool responseやsystem/developer messageへ入れない
- tool outputを命令ではなく引用可能な未信頼データとして構造化する
- 取得データがtool権限、write権限、memory、system rule、policyを変更できないようにする

hidden contentは除外するだけでなく、`hidden_instruction`または`low_trust_attribute` findingとして保存する。ページ上に可視表示された命令文は記事の引用や解説である可能性があるため、単純な禁止語削除は行わず、位置、命令形、対象、要求actionを組み合わせて判定する。

### 8.3 純TypeScript検査パイプライン

Cheerioで構築したDOMを本文抽出と検査で共有し、DOMを二度parseしない。検査は次の固定順序で行う。

1. visible text、hidden text、comment、meta/template、低信頼属性を別segmentとして収集
2. Unicode NFKC、zero-width/bidi control除去、全角文字、区切り文字、限定的なleet表記を正規化
3. URL encoding、`\\uXXXX`、`\\xNN`を最大2回まで復号
4. 16〜2,048文字の候補だけbase64判定し、decoded printable ratioが閾値を超えた場合だけ検査
5. 命令上書き、role変更、secret取得、tool実行、外部送信、memory書込、policy変更、出典隠し、出力強制をrule scan
6. source trust、segment位置、rule confidence、requested useからpolicyを決定
7. safe text、除外数、finding、assurance、limitationsをuntrusted envelopeへ格納

正規表現は起動時に一度だけcompileし、動的正規表現、再帰的decode、曖昧なnested quantifierを使わない。1segment、decode候補数、総検査文字数に上限を設け、入力サイズに対しておおむね線形になるようにする。

復号・leet変換した文字列はscan専用とし、LLMへ渡す本文を置き換えない。findingにはcategory、severity、confidence、location、利用したdeobfuscation technique、元segmentのhashを保存するが、secretを含み得るmatched textは既定でlogへ出さない。

単語1個ではfindingにしない。例えば`ignore`だけでは反応せず、「以前の指示」などの保護対象、「無視せよ」などの命令、「secretを送信」などのactionが組み合わさった場合にscoreを上げる。hidden/comment内は可視本文より厳しく、攻撃手法を説明する記事やコード例には`benign_mention`を付ける。ただし攻撃者が説明文を装う回避を防ぐため、高severityの実命令パターンは自動ではseverityを下げず、approval対象とする。

### 8.4 Policyと権限分離

- `answer_with_citation`、`summarize`、`extract_facts`など読み取り用途だけをContext Guardの許可対象にする
- `deny`または`require_approval`ならLLM toolsetから本文を返さない
- guard内部例外はLLM toolsetでfail-closedとし、`GUARD_FAILED`を返す
- 追加guardの判定は内蔵判定と合成し、より厳しいdecisionを採用する
- 取得時の読み取り許可をwrite tool、外部送信、コード実行、memory/rule/policy更新へ引き継がない
- 高影響actionを持つアプリはprovenanceとfindingを保持し、アプリ側のpolicyで改めて判定する

既定policyは次を基準にする。

| finding / requested use                  | 判定                                                    |
| ---------------------------------------- | ------------------------------------------------------- |
| findingなし / 読み取り                   | `allow`。taintとcitation要件は維持                      |
| 低〜中severityの可視命令 / 読み取り      | `allow_with_warning`。tool chainingは禁止               |
| hiddenまたは高severity / 読み取り        | `require_approval`。自動tool responseには本文を含めない |
| 高severity / `search_more`・tool呼び出し | `deny`                                                  |
| 外部送信・write・実行・memory/policy変更 | `llm-fetch`の許可対象外。アプリ側で再判定               |

Context GuardはPrompt Injectionのリスクを減らす層であり、安全性を証明するものではない。検知をすり抜けたコンテンツがあっても権限を取得できないよう、taint、構造分離、最小権限、action gateを併用する。

標準HTTP modeはブラウザを起動しないため、外部stylesheetや複雑なCSS cascadeによるcomputed visibilityは完全には再現できない。この制約を`limitations`へ常に記録し、静的に判定できるattribute、inline style、comment、template、metaを防御対象とする。Playwright modeではcomputed styleとbounding boxを追加で評価するが、色コントラスト、canvas、画像内文字、shadow DOM、短時間で変化するDOMを完全には判定できないため、ブラウザ利用時も「findingなし」を安全保証にしない。

設計基準:

- [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)
- [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)

## 9. 構造化エラー

```ts
export type LlmFetchErrorCode =
  | "INVALID_INPUT"
  | "CONFIG_MISSING"
  | "UNSAFE_URL"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "BOT_CHALLENGE"
  | "UPSTREAM_HTTP"
  | "PARSE_CHANGED"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "CONTENT_INSUFFICIENT"
  | "GUARD_FAILED"
  | "GUARD_DENIED"
  | "UNKNOWN";

export class LlmFetchError extends Error {
  readonly code: LlmFetchErrorCode;
  readonly provider?: string;
  readonly url?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly cooldownMs?: number;
}
```

利用者向けAPIで`"エラー: ..."`という正常文字列を返さない。エラーは必ずthrowまたは`failures`へ格納する。

## 10. パッケージ構成

```json
{
  "name": "@scope/llm-fetch",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "sideEffects": false,
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./playwright": {
      "types": "./dist/playwright/index.d.ts",
      "import": "./dist/playwright/index.js",
      "require": "./dist/playwright/index.cjs"
    }
  },
  "peerDependencies": {
    "playwright-core": "^1.62.0"
  },
  "peerDependenciesMeta": {
    "playwright-core": {
      "optional": true
    }
  }
}
```

TypeScript sourceからtsupでESM/CJSと型定義を生成する。公開物には`src`、fixture、bench、設定ファイルを含めない。Prompt Injection対策を含むHTTP機能は標準entrypointだけで利用できるようにする。Playwrightは`playwright-core`をoptional peer dependencyとし、`@scope/llm-fetch`の通常importやHTTP modeからは読み込まない。peerがない状態で`./playwright`をimportしても即座には失敗させず、最初のbrowser取得時に導入手順を含む`CONFIG_MISSING`を返す。

Playwright本体とbrowser binaryをnpm tarballへ同梱しない。browser mode利用者は次を実行する。

```bash
npm install @scope/llm-fetch playwright-core
npx playwright-core install --only-shell chromium
```

CIやコンテナでは必要に応じて`--with-deps`を付ける。Playwright更新時は対応browser binaryも同時更新が必要なため、互換性確認済みのpeer範囲とCI matrixをリリースごとに更新する。

browser downloadまでnpm install 1回で済ませたい場合は、Playwright公式のbrowser helperを使う次の導線も検証・記載する。これはinstall scriptで大容量binaryを取得するため、coreの標準依存にはしない。

```bash
npm install @scope/llm-fetch @playwright/browser-chromium
```

## 11. 実装フェーズ

### Phase 0: ベースラインとscaffold

- package.json、TypeScript、tsup、Vitest、ESLintを設定
- Node.js 22 / 24のCI matrixを用意
- `nextjs-template`の現行検索・本文取得をベースラインとして記録
- `npm pack`した成果物をESM/CJSのfixtureアプリから読み込むテストを作成

完了条件:

- 空のパッケージをbuild、pack、ESM/CJS双方からimportできる
- production依存のライセンス一覧をCIで出力できる

### Phase 1: 共通型とProvider基盤

- `SearchProvider`、`SearchHit`、`RetrievedDocument`を実装
- `LlmFetchError`を実装
- deadline、Semaphore、in-flight重複排除、LRUを実装
- Custom Providerとfallback Providerを実装

完了条件:

- `as any`なしで型検査が通る
- fallbackがretryable errorだけを対象にする
- deadlineがProvider切替後も延長されない

### Phase 2: DuckDuckGo Provider

- 通常検索bootstrapと署名付きpreload client/parser
- HTML POST client
- HTML Parser
- redirect URL解除
- Lite Parserと限定フォールバック
- challenge、429、parse change検出
- locale、Safe Search、time rangeのmapping
- frozen HTML fixtureを追加

完了条件:

- 通常検索は署名付き2リクエストで完了する
- Web preload/HTML/Liteの成功、空結果、202、429、5xx、構造変更をテストできる
- preload URLのhost、path、VQD、query改ざんを拒否できる
- live DuckDuckGoを使わなくても全unit testが再現可能
- live smoke testは環境変数指定時だけ1クエリ実行する

### Phase 3: 安全な本文取得

- `outbound-url-policy.ts`と既存51テストを移植
- keep-alive、全体deadline、stream size制限を追加
- Cheerio抽出器と品質判定を実装
- URL正規化と重複除去を実装

完了条件:

- private/reserved IP、DNS rebinding、危険なredirectを拒否する
- 取得上限をContent-Lengthあり/なしの両方で強制する
- 本文不足と通信エラーを区別できる

### Phase 4: Brave Providerと一括取得

- `nextjs-template`のBrave実装をProvider化
- API keyと`fetch`を注入可能にする
- `searchAndRead`を実装
- 部分失敗、同時実行数、origin制限を実装

完了条件:

- DuckDuckGoとBraveで同じ`SearchHit`を返す
- 1件の本文取得失敗で他の結果を失わない
- DuckDuckGoのretryable error時だけBraveへ切り替わる

### Phase 5: Context Guard統合

- `SecurityFinding`、`GuardResult`、`ContentGuard`を実装
- HTML segment分類、bounded normalization、rule scannerを純TypeScriptで実装
- action-aware policyとuntrusted envelopeを実装
- HTML抽出前にguardを実行し、処理後にraw bodyを破棄
- 本文抽出とguardで同じCheerio DOMを共有
- additional guardとのdecision統合を実装
- deny / approval / guard例外のfail-closed処理を実装

完了条件:

- findingがなくても全外部Documentがtaintedのままになる
- hidden contentとraw HTMLがLLM可視本文へ入らない
- Prompt Shield、WASM、外部semantic modelなしで全testが成功する
- 難読化decodeの回数・候補数・長さ上限が強制される
- pathological inputに対して処理時間が入力長へほぼ線形に増加する

### Phase 6: LLM toolset

- canonicalな`web_search`と`fetch_content`定義を実装
- OpenAI形式変換
- Bedrock Converse形式変換
- 入力validationとexecute routing
- LLM向け出力を本文・引用URL・取得時刻・最小security情報へ圧縮し、未検査page title、HTML構造、script、style、属性、hidden内容、詳細diagnosticを除外
- `web_search`は既定5件、title 200文字、snippet 500文字、`fetch_content`は既定5,000文字・最大20,000文字へ制限

完了条件:

- OpenAI/AWS SDKをproduction依存へ追加しない
- tool schemaと実行validationが同じ制約を使う
- アプリ固有ツールと配列結合できる
- guardがdeny / require approvalを返した本文をtool responseへ含めない
- tool outputが未信頼データであることを構造上明示する
- シリアライズしたtool outputにraw HTML、script/style本文、イベント属性、hidden本文、詳細finding/reason/limitationが含まれない

### Phase 7: `nextjs-template`への導入

- `npm pack`したtarballを`nextjs-template`へ導入
- `searchWeb`と`fetchContent`をパッケージ呼び出しへ置換
- `browsePolicyMaster`と`ActionRepository`はアプリ側に残す
- アプリ側adapterで既存loggerへ実行結果だけを記録する
- `WEB_SEARCH_PROVIDER=duckduckgo|brave`で切替可能にする

完了条件:

- 現在のチャットからDuckDuckGo/Braveの両方を利用できる
- 既存の認証、DB、施策マスタへ影響しない
- 旧実装と同じ入力で互換する検索・本文取得結果を確認できる
- 取得コンテンツ経由でアプリのwrite tool、memory、policyを変更できない

### Phase 8: 公開準備

- README、API reference、SECURITY.md、LICENSE、NOTICEを作成
- npm pack内容とunpacked sizeをCIで検査
- dependency license allowlistをCIへ追加
- provenance付きnpm publishを設定
- DuckDuckGo利用上の注意とSLAなしをREADMEへ明記

完了条件:

- installから最初の検索までREADMEだけで実行できる
- Apache-2.0/MIT/BSD/ISC以外のproduction依存がない
- 公開・商用利用時のDuckDuckGo確認事項が明文化されている

### Phase 9: 任意Playwright拡張

- 共通`ContentRetriever` contractを追加し、既存HTTP fetcherをadapter化
- `ReadInput.render`と`RetrievedDocument.fetchMethod`を拡張
- `@scope/llm-fetch/playwright`を別entrypointとしてbuild
- Chromiumのlazy launch、browser process再利用、fresh context、bounded queueを実装
- 認証付きDNS-pinning forward proxyとrequest policyを実装
- rendered DOM snapshotとcomputed-hidden segment分類を実装
- HTTP-first fallbackと単一deadlineを実装
- `close()`を非同期resource cleanupへ対応
- browser専用のunit、security、integration、consumer、benchmarkを追加

完了条件:

- 標準entrypointのbundle、cold import、依存数、HTTP性能がv0.1基準から悪化しない
- Playwright未導入でも標準entrypointの全機能と型検査が成功する
- browser pageが生成する全HTTP(S)接続がrequest policyとpinned proxyの両方を通る
- localhost、private/reserved IP、DNS rebinding、redirect、非標準portをbrowser modeでも拒否する
- cookie / storage / permissionが取得間で残らず、popup、download、WebSocket、非GET requestが標準拒否される
- HTTP本文が十分な場合はbrowserを起動しない
- rendered DOMのvisible / hidden / comment / attribute / meta / templateが同じContext Guard policyで判定される
- browser crash、timeout、AbortSignal、`close()`でpage、context、proxy、browser processが残らない
- browser binaryをnpm tarballへ同梱せず、PlaywrightとChromium由来のlicense・notice要件を文書化する

## 12. テスト計画

### Unit test

- DuckDuckGo Web preload/HTML/Lite Parser
- Safe Search、locale、time range mapping
- redirect URL解除
- URL重複除去
- Brave response mapping
- fallback条件
- deadlineとAbortSignal
- Semaphore、LRU、in-flight dedupe
- 本文抽出とquality gate
- Context Guardのsegment分類、正規化、rule score、policy matrix
- built-in guardとadditional guardのdecision統合
- エラーの秘密情報非表示

### Security test

- IPv4/IPv6 private network
- localhost、`.local`
- userinfo付きURL
- 非標準port
- redirect先の再検証
- DNS rebinding
- oversized Content-Length
- chunked oversized response
- gzip/brotli展開後のoversize
- HTML以外のContent-Type
- findingが0件でも`trust: "untrusted"`、`tainted: true`が維持される
- hidden要素、HTML comment、低信頼属性の命令がLLM可視本文から除外される
- 可視の`ignore previous instructions`が消去ではなくfinding / policy判定の対象になる
- URL、hex、base64、Unicode、zero-widthなどの難読化fixtureを内蔵Context Guardが検出する
- 攻撃例を説明する通常記事を誤ってdenyしないregression fixtureを持つ
- decode回数、候補数、segment長、総検査文字数の上限を確認する
- 長大な区切り文字や不完全encodingでReDoS・無制限loopが起きない
- `deny` / `require_approval`の本文をLLM toolsetが返さない
- guard例外時にLLM toolsetがfail-closedになる
- raw HTMLをsystem/developer messageへ配置しない
- 読み取り許可済みDocumentでも後続の高影響actionは再判定を要求する
- browser modeの全requestでprotocol、method、port、hostname、解決済みIPを再検証する
- Chromiumのproxy bypassを想定し、route側だけでもlocalhost / private IPを拒否する
- pinned proxyがCONNECTと通常HTTPの両方でDNS rebindingを拒否する
- popup、download、WebSocket、Service Worker、file/data URL、非GET / HEADを拒否する
- cookie、localStorage、sessionStorage、permissionが別contextへ引き継がれない
- browser modeでもguard deny結果とhidden contentをLLM可視本文へ含めない

### Contract test

- すべてのSearch Providerへ同じcontract suiteを適用
- `limit`、`signal`、timeout、空結果、構造化エラーを確認
- provider固有フィールドを公開型へ漏らさない
- HTTP retrieverとPlaywright retrieverへ同じ取得contract suiteを適用
- `render=never|auto|always`、fallback対象error、単一deadlineを確認

### Consumer test

- ESM Node.jsアプリ
- CommonJS Node.jsアプリ
- `nextjs-template`のtsup CJS build
- npm tarballからのinstall
- dependency treeにPrompt Shield、WASM runtime、外部semantic modelが含まれない
- Playwright未導入のcore-onlyアプリ
- `playwright-core`とChromiumを導入したPlaywrightアプリ
- core-only installでPlaywright/browser downloadが発生しない

### Live smoke test

通常CIではDuckDuckGoやBraveへアクセスしない。手動またはscheduleで少数のlive smoke testを実行し、DOM構造変更を検知する。

- DuckDuckGo: 1クエリ
- Brave: API keyがある場合だけ1クエリ
- 結果本文は保存しない
- query、snippet、HTMLをCI logへ出さない

## 13. 性能目標

外部サービスの応答時間は制御できないため、network込みの固定値だけで合否を決めない。SDK内部処理とリクエスト回数を主な性能ゲートにする。

| 対象                                  | 目標                                  |
| ------------------------------------- | ------------------------------------- |
| DuckDuckGo正常検索                    | 署名付きupstream request 2回           |
| DuckDuckGo fixture 50 KiB解析         | p95 15 ms以下                         |
| HTML 1 MiB本文抽出                    | p95 75 ms以下                         |
| Context Guard追加処理 50 KiB          | p95 10 ms以下                         |
| SDK cold import                       | 100 ms以下                            |
| 同一queryの同時10呼び出し             | upstream request 1回                  |
| 5 URL、各100 msのfixture取得、並列数4 | 250 ms以内                            |
| 1ページ処理の追加heap                 | 64 MiB以下                            |
| core entryのdist合計                  | 150 KiB以下、source map除外           |
| coreの直接runtime依存                 | 1パッケージを原則とする               |
| core-only import / bundle             | v0.1基準から5%超の悪化なし            |
| Playwright warm context作成・破棄     | p95 250 ms以下、navigation除外        |
| rendered DOM snapshot 1 MiB           | p95 100 ms以下、browser内評価を含む   |
| browser同時実行                       | 既定2 context、上限8、queue上限を強制 |
| HTTPで本文十分な`auto`取得            | browser launch 0回                    |

ベンチマークはNode.js 22と24で実行し、CIでは直近基準値から20%以上悪化した場合に検知する。共有CIの揺らぎを考慮し、初期段階では警告、基準が安定した後にhard failへ変更する。Context Guardは本文抽出と同じDOMを共有し、正規化済み文字列をsegment単位で一度だけ生成する。

## 14. ライセンスと利用条件

- `llm-fetch`: Apache-2.0を第一候補
- Cheerio: MIT
- SearXNG: 使用しない
- Puppeteer: 使用しない
- Playwright / `playwright-core`: Apache-2.0。任意拡張だけで使用
- Chromium binary: npm tarballへ再配布せず、利用環境でPlaywright CLIから導入する。Chromiumと同梱third-party noticeは別途確認・保持する
- DuckDuckGo clientライブラリ: runtime依存にしない
- Prompt Shield: runtime依存にせず、設計とfixtureの参照元として扱う
- production依存はpermissive license allowlistで検査

DuckDuckGo HTML/Lite版の存在は公式に案内されているが、プログラム向けの安定APIではない。技術的に利用可能であることと、任意の公開・商用用途で無条件に利用可能であることは分けて扱う。公開前に利用形態を確認し、必要ならDuckDuckGoへ問い合わせる。

## 15. 移行元コードの扱い

### コードを移植するもの

- `../nextjs-template/src/lib/mcp/outbound-url-policy.ts`
- `../nextjs-template/src/lib/mcp/outbound-url-policy.test.ts`
- `../nextjs-template/src/lib/mcp/mcp-tools.ts`のBrave response mapping
- `../nextjs-template/src/lib/mcp/mcp-tools.ts`のCheerio抽出処理をfixture作成の基準として使用

### 設計・fixtureだけを参考にするもの

- `../prompt-shield/packages/sdk/src/models.ts`のtaint、finding、assurance、limitationsという防御契約
- `../prompt-shield/packages/sdk/src/index.ts`のextract → scan → policyという処理順序
- `../prompt-shield/packages/sdk/src/html/extract-static-html.ts`のhidden content分類
- `../prompt-shield/packages/sdk/test/`のextractor、scanner、policy、regression fixture
- `../prompt-shield/spec/THREAT_MODEL.md`の脅威モデル

### 持ってこないもの

- `ActionRepository`
- `browsePolicyMaster`
- アプリ固有logger
- module import時の`process.env`読み込み
- Bedrock固有形式の`MCP_TOOLS`
- エラーを通常文字列へ変換する処理
- `../prompt-shield/packages/sdk/src/safe-fetch.ts`のHTTP transport
- Prompt ShieldのRust core、WASM binary、semantic scanner、CLI、MCP、audit機能

Prompt Shieldの実装を読んで、型、正規化、rule、policyは本パッケージ向けに純TypeScriptで新規実装する。fixtureを再利用または翻案する場合は出典を記録し、必要なMIT noticeと著作権表示をNOTICEへ反映する。

## 16. リリース判定

v0.1.0を公開できるのは、以下をすべて満たした場合とする。

- DuckDuckGo/Brave/Customが同じProvider contractを満たす
- SSRF security testがすべて成功する
- 全外部Documentが未信頼・taintedとして扱われる
- hidden content、raw HTML、guard deny結果がLLM可視contextへ漏れない
- guard例外時のtoolsetがfail-closedになる
- 標準設定だけでContext Guardが有効になる
- production dependency treeにPrompt Shield、WASM、外部semantic modelが含まれない
- unit、contract、consumer testが成功する
- 性能目標を満たすか、未達理由が明記されている
- `nextjs-template`で実利用できる
- production依存のライセンス検査が成功する
- DuckDuckGoの利用条件に関する公開上の確認が完了している
- READMEにbest-effort Providerであることが明記されている
- READMEに「findingなしは安全保証ではない」と高影響actionの再判定要件が明記されている

v0.1では機能数より、検索・取得の失敗理由が明確で、ブラウザなしに高速かつ安全に動くことを優先する。Playwright拡張はこの基準を崩さない任意subpathとして分離する。

## 17. 初期実装状況

2026-08-29時点で、縦切りMVPとして以下を実装済み。

- Phase 0: npm / TypeScript / tsup / Vitest / ESLint基盤
- Phase 1: 公開型、構造化エラー、deadline、Semaphore、in-flight dedupe、LRU
- Phase 2: DuckDuckGo署名付きWeb preload/HTML/Lite Provider、構造変更・challenge・rate limit検出
- Phase 3: DNS pinning、redirect再検証、単一deadline、圧縮前後size制限、本文抽出
- Phase 4: Brave Provider、fallback、`searchAndRead`、部分失敗
- Phase 5: 純TypeScript Context Guard、hidden content、難読化、policy、fail-closed
- Phase 6: OpenAI / Bedrock tool definitionとtool実行
- Phase 6追加: LLM context用のcompact tool出力、既定5件/5,000文字、HTML/control data非公開
- Phase 7: `nextjs-template`へのtarball導入、旧Brave/URL取得実装の置換、DuckDuckGo/Brave切替、Context Guard付きtool出力
- Phase 9（初期版）: optional Playwright subpath、HTTP-first fallback、lazy Chromium、fresh context、bounded queue、認証付きDNS-pinning proxy、rendered DOM Guard、async cleanup

検証済み:

- lint、型情報を使うPromise規則を含むstrict typecheck、174件の通常unit/security testと、実Chromiumを使う4件の分離integration test
- ESM / CommonJS buildと、npm install後の両形式import
- package exports / ESM / CJS型定義検査（Are the Types Wrongで問題0件）
- core-only consumerでは`playwright-core`がinstallされず、標準entrypoint、Playwright subpath import、`isAvailable() === false`が成功
- production/development dependency audit（既知の脆弱性0件）
- runtime直接依存はCheerio 1件のみ
- Context Guard 50 KiBは平均約3.3 ms、約1 MiB HTMLのDOM抽出＋guardは平均約53.4 ms
- ESM/CJS/型定義を含むdistと、npm tarball約76.0 KiB（browser binaryは非同梱）
- callerごとのAbortSignalを分離したin-flight dedupe、source-aware document cache、DNS解決を含む総deadline
- 途中切断、予約IPv6、`home.arpa`、不正resolver/fetcher/guard結果、検査上限到達時のfail-closed
- ツール出力のprovider/URL/snippet検査と、難読化されたcontrol文字・delimiter・Base64の回帰テスト
- compact tool出力からHTML構造、script/style、イベント属性、hidden内容、詳細finding/reason/limitationが除外される回帰テスト
- Provider単位のrate limit / challenge cooldownと、client全体の検索deadline
- `render: "auto"`はPlaywright/Chromiumが存在する場合だけ動的shellから切替し、不在時は元の`CONTENT_INSUFFICIENT`を維持
- 実Chromiumで`render: "always"`によるExample Domain取得と、page側DOM API改ざん下でもisolated worldによるcomputed-hidden分類・返却抑止を確認
- Node.js 22 / 24のcore CIと、任意Chromium integrationを分離したGitHub Actions
- `nextjs-template`の専用branchでtarballを導入し、DuckDuckGo実検索、Playwright未構成時のHTTP維持、CSRページの実Chromium自動切替を3件のE2Eで確認
- 同一ホストから特殊文字と日本語を含むqueryでも署名付きDuckDuckGo経路が2リクエストともHTTP 200、2.121秒、3結果で完了することを確認
- DuckDuckGo signed Web parserは20結果で平均約0.455 ms。重複URL、challenge語の正常結果、重複署名parameter、challenge/rate-limit優先度、外部redirect、response-size metadataを回帰テスト済み
- Playwright公式seccomp profile、非root UID、Chromium sandbox有効、headless-shell単独のproduction containerでCSR取得を確認

未着手または継続項目:

- frozen実サイトfixtureの拡充
- live Brave smoke test（API key未設定）
- npm公開scopeの確定とCI publish設定

## 18. Playwright拡張の詳細実装設計（初期版実装済み）

### 18.1 採用方式

Playwrightを既存HTTP fetcherの内部へ直接埋め込まず、共通`ContentRetriever` contractを介して接続する。コアの既定動作は変えず、browser modeを設定した利用者だけがuntrusted JavaScriptを実行する。

拡張側の実装コードもTypeScriptだけとし、native addon、Python、WASM、常駐外部serviceを追加しない。Chromium binary自体はPlaywright実行に不可欠な外部runtimeとして分離管理する。

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";
import { playwrightRetriever } from "@scope/llm-fetch/playwright";

const web = createLlmFetch({
  search: duckDuckGo(),
  browser: {
    retriever: playwrightRetriever({
      concurrency: 2,
      navigationTimeoutMs: 8_000,
      settleTimeoutMs: 750,
    }),
    defaultRender: "auto",
  },
});

const document = await web.read({
  url: "https://example.com/app",
  render: "auto",
});

await web.close();
```

`ContentRetriever`は少なくとも取得方法、最終URL、status、content type、bounded body、transport limitationsを返す。Playwright retrieverは加えて、computed visibilityを反映した本文抽出用DOMと、hidden / comment / attribute / meta / templateの検査segmentを内部結果として返す。`SafeHttpFetcher`の利用者互換性はadapterで維持する。

`close()`はbrowser、proxy、queueを確実に終了する必要があるため`Promise<void>`へ変更する。v0.1公開前のためここで型を整え、二重closeは成功するidempotent APIにする。

### 18.2 取得戦略

| `render` | 動作                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| `never`  | HTTPだけ。Playwrightをimport・launchしない                                                  |
| `auto`   | HTTPで取得・抽出・品質判定し、`CONTENT_INSUFFICIENT`の場合だけPlaywrightへ1回フォールバック |
| `always` | outbound URL検証後、最初からPlaywrightを使用                                                |

`auto`でbrowser fallbackしてよいのは`CONTENT_INSUFFICIENT`だけとする。`UNSAFE_URL`、`GUARD_DENIED`、`RESPONSE_TOO_LARGE`、`BOT_CHALLENGE`、`RATE_LIMITED`、401 / 403 / 429、timeout、利用者abortでは実行しない。CAPTCHAやアクセス制御の回避にも使用しない。

read単位でdeadlineを1つ作り、HTTP取得、抽出、browser queue待ち、navigation、DOM settle、snapshot、guardの全工程で共有する。HTTPで時間を使い切った後にbrowser用timeoutを新しく開始しない。AbortSignalまたはdeadline到達時は対象BrowserContextを閉じて、page内の未完了処理も止める。

### 18.3 browser lifecycleと高速化

- `playwright-core`は最初のbrowser取得時にdynamic importする
- Chromiumはheadlessかつ`chromiumSandbox: true`で1プロセスだけ起動し、`--no-sandbox`を標準では許可しない。kernel sandboxを利用できない環境は、明示的なexternal sandbox modeとcontainer隔離がない限りfail-closedにする
- browser processは共有するが、取得ごとに`browser.newContext()`を作成して`finally`で破棄する
- contextはcookie、storageState、client certificate、HTTP credential、permissionを持たない
- `acceptDownloads: false`、`serviceWorkers: "block"`、`ignoreHTTPSErrors: false`、`bypassCSP: false`を固定する
- 同時context数は既定2、設定上限8、queue長にも上限を設け、超過時は構造化errorを返す
- browser未起動時の同時要求はsingle-flightで1回だけlaunchする
- crash時は実行中要求を失敗させ、次回要求で1回だけ再起動する
- 一定context数またはidle timeout後にbrowserを再起動・終了できるようにし、長時間processの劣化を抑える
- image、media、fontは本文抽出に使わないため標準blockし、document、script、stylesheet、XHR / fetchだけを許可する
- `networkidle`は使わず、`domcontentloaded`後に本文文字数とDOM node数が連続2回変化しないことを100 ms間隔で確認する。最大待機は既定750 msとする
- Chromium CDPの受信byte eventでrequest単位とcontext合計のnetwork budgetを監視し、上限超過時はcontextを閉じる。main responseの`Content-Length`も取得直後に検証する
- trace、video、screenshot、HAR、console本文、response bodyを標準では保存・log出力しない

browser binaryのcold launchは環境差が大きいため、外部page込みの固定SLAにはしない。core回帰、warm context、snapshot処理、browser起動回数、request数、最大同時context数を性能gateにする。

### 18.4 browser network policy

Playwrightの`browserContext.route()`だけではDNS pinningを保証できない。routeでURLを検証した後、Chromium自身が別のDNS結果へ接続できるためである。次の二層を標準強制する。

1. `browserContext.route("**/*")`でpageが生成する全requestを検査する
2. ChromiumのHTTP proxyを、Node.js / TypeScriptで実装したloopbackのDNS-pinning forward proxyへ固定する

request routeでは次を実施する。

- `http:` / `https:`以外を拒否
- credential入りURL、localhost / `.local` / `.localhost` / `.home.arpa`、非標準portを拒否
- GET / HEAD以外を拒否
- `resolveSafeOutboundUrl()`で全解決先がpublic IPか確認する。同一hostの並行requestはsingle-flightし、短いbounded DNS cacheで重複lookupを抑える
- redirect、script、stylesheet、XHR / fetchを含むrequestごとに再検証し、subframe documentは拒否
- document redirect回数、総request数、DOM node数へ上限を設定
- `routeWebSocket()`でWebSocketを拒否し、Service Workerをblock
- popupで作られた追加pageを直ちに閉じ、main pageを1枚に限定

pinned proxyは`127.0.0.1`のephemeral portだけへbindし、browserごとのrandom credentialを要求する。通常HTTP requestとHTTPS CONNECTのhost / portを再検証し、proxy自身が解決したpublic IPへsocketをpinする。CONNECTは443、通常HTTPは80だけを許可し、redirect後も新しい接続を同じ手順で検証する。`Proxy-Authorization`などhop-by-hop headerをupstreamへ転送せず、header数・各値・合計長にも上限を設ける。URL、header、本文、cookieをlogへ残さない。

HTTPS CONNECT内のmethodやresponse sizeをproxyから完全には検査できないため、method制限はrouteとの組み合わせで強制する。またPlaywright route / proxyはChromium processの全機能に対するOS-level network sandboxではない。WebRTC等の非HTTP経路をpage初期化scriptでも無効化するが、これだけを完全な隔離とみなさない。browser modeの`security.limitations`にはこの点を必ず記録し、機密networkへ到達できる本番環境ではcontainer / network namespace / egress firewallによりproxy以外の外向き通信を拒否する。OS-level隔離を検証できない初版のbrowser modeはassuranceを`medium`より上にしない。

### 18.5 rendered DOMとPrompt Injection対策

Playwrightは取得精度を上げる一方、未信頼JavaScriptを実行する攻撃面を増やす。browser pageへNode.js function、環境変数、filesystem、既存cookie、認証済みstorageState、LLM toolを公開しない。pageからSDKやアプリのwrite actionを呼べるbindingも作らない。

render完了後、`rendered-dom-snapshot.ts`がpage JavaScriptから分離されたChromium isolated world内でboundedなtree walkを1回だけ行う。

- `getComputedStyle()`の`display`、`visibility`、`opacity`、`font-size`とbounding boxを取得
- computed-hidden nodeを本文用DOMから除外し、`hidden` segmentとして別に保持
- script / style / noscript / template / comment / meta / low-trust attributeを本文へ混ぜず、検査segmentへ送る
- visible DOMだけを既存Cheerio本文抽出器へ渡す
- visible text、hidden segment、serialized DOM、node数、segment数、総文字数へ個別上限を設ける
- 上限到達、不整合、browser evaluate失敗は安全側に倒し、`GUARD_FAILED`または`RESPONSE_TOO_LARGE`にする

`auto`ではpre-renderとpost-renderの二段でguardする。HTTPで得た元HTMLをbrowser fallback判定前に検査し、deny / require approvalならJavaScriptを実行しない。その後、JavaScriptで追加・変更された内容をrendered snapshotで再検査する。`always`は二重network取得を避ける明示モードのため、main responseのstatus、content type、Content-Lengthと総network byteを検査したうえでpost-render guardを行うが、JavaScript実行前のraw HTML検査は行わない。この制約から、browserへsecretや高権限bindingを渡さないことを第一防御にし、事前検査が必要な通常利用では`auto`を選ぶ。

内蔵Context Guardのnormalization、rule scanning、action-aware policy、additional guard統合はHTTP modeと共通化する。additional guardへは元のnetwork responseではなく、JavaScript反映後のbounded rendered snapshotを`rawBody`として渡す。公開Documentとtool responseにはsnapshot、raw HTML、hidden原文を含めない。

LLM向け`fetch_content` tool schemaには`render`を公開しない。browser modeを許可するか、`auto`を既定にするかはアプリ初期化時の信頼済み設定だけで決め、検索snippetや取得ページの命令から`always`へ切り替えられないようにする。

`../prompt-shield/spec/CONCEPT.md`のBrowser Rendered Modeにあるcookie / storageなし、private IP・file URL・非GET・popup・download・permissionのblock、timeout必須という境界を採用する。一方、`../prompt-guard`というdirectoryは現workspaceに存在しないため、実在する`../prompt-shield`を参照元とする。`../nextjs-template`からはChromium設定そのものではなく、`domcontentloaded`待機、context / pageの`finally` cleanup、bounded timeoutの運用パターンを参考にする。

### 18.6 実装順序

1. `ContentRetriever`、`RetrievalResult`、`render`、async `close()`を追加し、既存HTTP経路をadapter化する
2. 複数entry build、subpath exports、optional peer、Playwright未導入consumer testを追加する
3. bounded queue、lazy import、close、optional runtime不在時のlifecycleをunit testする
4. pinned proxyを実装し、CONNECT、redirect、DNS rebinding、abort、timeoutをsocket injection付きでtestする
5. Playwright request policyとfresh contextを実装し、全resource typeとmethodの許否をtestする
6. rendered DOM snapshot、computed-hidden分類、既存抽出器・Context Guard統合を実装する
7. HTTP-first fallback、cache key、in-flight dedupe、toolsetの`fetchMethod`反映を実装する
8. 実Chromiumを使うintegration / security / benchmark jobをcore-only CIから分離して追加する
9. README、SECURITY.md、NOTICE、導入手順、container egress例、既知のlimitationsを更新する
10. `npm pack`したtarballを`nextjs-template`へ導入し、CSR fixtureでHTTP-onlyとbrowser fallbackを比較する

各段階で159件の通常test、lint、strict typecheck、pack後のESM / CJS / TypeScript consumer test、core-only install、audit、package検査を回す。実Chromium jobは通常suiteから分離し、computed visibilityとisolated world境界を確認する。

初期版では1〜10を実装済み。8は通常suiteから分離した実Chromium integration testと手動smokeまで実装し、browser benchmarkの継続計測はCI追加時に行う。10は`nextjs-template`の`feat/llm-fetch-integration` branchでtarball導入、旧実装置換、CSR E2E、production container smokeまで確認した。

参考:

- [Playwright Library](https://playwright.dev/docs/library)
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)
- [Playwright Network](https://playwright.dev/docs/network)
- [Playwright browser管理](https://playwright.dev/docs/browsers)
- [Playwright Apache-2.0 LICENSE](https://github.com/microsoft/playwright/blob/main/LICENSE)
