# `llm-fetch` npm公開に向けた実装計画書

## 1. 文書情報

| 項目 | 内容 |
| --- | --- |
| 対象 | `llm-fetch` |
| 目標 | 公開npmパッケージ `v0.1.0` |
| 基準日 | 2026-08-29 |
| 現在の判定 | NO-GO。社内・限定alpha相当 |
| この文書の役割 | コード監査で確認した課題を、実装順序・完了条件・検証方法へ変換する |
| 関連文書 | [plan.md](./plan.md)、[README.md](./README.md)、[README.ja.md](./README.ja.md)、[SECURITY.md](./SECURITY.md) |

`plan.md`は製品の設計経緯と全体仕様を保持する。本書は、公開前の残作業と品質改善を実行するための計画として使用する。

## 2. 目標と完了状態

公開版`v0.1.0`は、次の状態を満たすものとする。

1. 未信頼HTMLを入力しても、設定した期限と構造上限を大きく超えず、生の実装例外を公開境界へ漏らさない。
2. 検査対象を切り捨てた場合は必ず安全側の判定になり、利用者が検査限界を確認できる。
3. Node.js 22 / 24のESM、CommonJS、型定義、core-only構成が梱包後も動作する。
4. Chromiumを使う統合テストが、独立したsandbox環境で安定して成功する。
5. npm上の最終パッケージ名、リポジトリ情報、ライセンス、provenance、公開手順が一致する。
6. OpenAI Responses API、OpenAI Chat Completions、Amazon Bedrockの対応範囲がAPI名と文書から判別できる。
7. 外部Providerの利用条件、best-effort性、データ送信、運用上の制約が公開文書に記載されている。
8. unit、security、consumer、browser、性能の各テストがリリースゲートとして自動実行される。

## 3. 実施原則

- P0を解消するまで、公開npmへの`0.1.0` publishは行わない。
- セキュリティ上限に達した場合は、空結果や`allow`ではなく型付きエラーまたは承認要求へ倒す。
- `private: true`の解除と本番publishは最後の独立作業にする。
- core packageへPlaywright、OpenAI SDK、AWS SDKをruntime dependencyとして追加しない。
- 外部SDKとの互換テスト用依存はdev / CIに限定する。
- 公開APIの破壊的変更は、まだ未公開の`0.1.0`前にまとめて行う。
- 既存の未コミット変更を上書きせず、機能ごとに小さな差分へ分ける。
- 実測値、テスト数、CI状態を文書へ固定値で書く場合は、自動更新または更新手順を用意する。

## 4. 優先度とリリースゲート

| ゲート | 必須条件 | 到達後の扱い |
| --- | --- | --- |
| G0: Security baseline | SEC-01、SEC-02、SEC-03が完了 | 限定alphaを継続可能 |
| G1: Package candidate | PKG-01、PKG-02、CI-01、CI-02が完了 | `0.1.0-alpha.1`をpackしてconsumer検証可能 |
| G2: Public API freeze | API-01〜API-07、EXT-01が完了 | `0.1.0-rc.1`のAPIを固定可能 |
| G3: Release candidate | TST-01〜TST-06、PERF-01、DOC-01〜DOC-04が完了 | 公開可否を再判定可能 |
| G4: Public release | 全CI成功、外部条件確認、provenance付きdry-run、明示的な公開承認 | `v0.1.0`をpublish |

G4は自動的に実行しない。npmへの実publishは、最終パッケージ名と公開内容を人が確認した後に明示的に開始する。

## 5. 実装フェーズ

### Phase A: セキュリティと期限保証

#### SEC-01: DOM構造上限と同期処理の期限保護

優先度: P0
規模: L
主対象: `src/retrieval/dynamic-content.ts`、`src/retrieval/extract-content.ts`、`src/client.ts`

実装内容:

- `isLikelyDynamicHtml()`から`body.clone()`とapp rootの再帰的cloneを除去する。
- DOM全体を繰り返し走査せず、単一走査で本文量、script有無、framework rootの状態を集計する。
- HTTP取得後のHTMLにも、最大DOM深度、最大ノード数、最大候補数を設定する。
- 本文候補の選択で、入れ子になった`.content`等を重複して全文走査しない。
- HTML / XML parse、動的判定、抽出、Guardの各同期境界の前後でdeadlineを確認する。
- Cheerio / domhandler等の例外を`LlmFetchError`へ変換する。
- 上限超過は`RESPONSE_TOO_LARGE`、期限超過は`TIMEOUT`、抽出不能は`CONTENT_INSUFFICIENT`に統一する。

完了条件:

- 1,000階層以上の入れ子HTMLが、設定期限を大幅に超えて正常終了しない。
- 2,000階層以上の入力でも、生の`RangeError`が公開APIから返らない。
- 通常の静的HTMLとSPA shellの既存判定を維持する。
- 新規回帰テストを`test/retrieval`と`test/client.test.ts`へ追加する。

#### SEC-02: セグメント切り捨て情報の伝播

優先度: P0
規模: M
主対象: `src/security/html-segments.ts`、`src/security/rules.ts`、`src/security/context-guard.ts`

実装内容:

- `ContentSegment`へ`truncated`、`originalLength`を追加する。
- `boundedText()`は文字列だけでなく、切り捨て状態を返す。
- hidden、comment、meta、template、attribute、closed detailsの全経路で情報を保持する。
- segment件数上限と文字数上限のどちらで欠落したかをGuardへ伝える。
- 一部だけを検査する場合は先頭だけでなく、上限内で末尾サンプルまたは分割走査も検討する。
- 検査欠落時は最低でも`require_approval`とし、`limitations`へ理由を追加する。

完了条件:

- 64,000文字を超えるhidden要素の後半に高危険度命令を置いたfixtureが`allow`にならない。
- comment、meta、template、attributeについて同等の回帰テストがある。
- `excludedSummary`とGuardのtruncation情報が矛盾しない。

#### SEC-03: 文字コード処理の統一

優先度: P1
規模: M
主対象: `src/retrieval/extract-content.ts`、`src/security/context-guard.ts`

実装内容:

- HTTP `Content-Type`、BOM、HTML `meta charset`の優先順位を定義する。
- `decodeBody()`と公開`inspectRaw()`で同じdecoderを使用する。
- 未対応charsetをUTF-8へ黙って置き換えず、型付きエラーまたは明示的なlimitationにする。
- UTF-8、UTF-16LE/BE、Shift_JIS、宣言不一致、無効charsetのfixtureを追加する。

完了条件:

- client経由と`createBuiltinContextGuard().inspectRaw()`経由で同じ本文・Guard判定になる。
- 文字化けによる既知のGuard回避fixtureが成功しない。

### Phase B: npm公開基盤とCI

#### PKG-01: パッケージIDと公開メタデータの確定

優先度: P0
規模: M
依存: 最終npm scope / package名の決定

実装内容:

- npm上の最終パッケージ名とscope所有権を確認する。
- `package.json`へ`repository`、`homepage`、`bugs`、`keywords`、`author`、`packageManager`を追加する。
- `repository.url`を公開GitHubリポジトリと大文字小文字を含めて一致させる。
- README、plan、consumer test、install例の`@scope/llm-fetch`を一括置換する。
- `scripts/verify-package.mjs`がpackage名を`package.json`から読み、scopeをハードコードしないようにする。
- package内のLICENSE、NOTICE、README、SECURITYの存在とMIT表記をpack testで確認する。

完了条件:

- `npm pack --dry-run --json`のname、version、files、licenseが期待値と一致する。
- 仮scopeが公開物とリポジトリ内に残っていない。
- `private: true`は本番publish直前まで維持する。

#### PKG-02: Trusted Publishingとprovenance

優先度: P0
規模: M

実装内容:

- npm Trusted PublisherをGitHub Actionsに関連付ける。
- tagまたはGitHub Releaseを起点とするpublish workflowを追加する。
- workflowへ最小権限の`contents: read`と`id-token: write`を設定する。
- publish jobの前にverify、pack内容、versionとtagの一致を確認する。
- npm tokenを長期secretとして保存しない。
- npm environmentに承認者を設定し、誤publishを防ぐ。

完了条件:

- publish workflowのdry-runが成功する。
- provenance statementが対象GitHubリポジトリを示す。
- tagとpackage versionが不一致の場合はpublish前に失敗する。

#### CI-01: Chromium sandbox対応

優先度: P0
規模: L

実装内容:

- Chromium sandboxを有効にできる非root実行環境をCI用コンテナとして固定する。
- container / seccomp / user namespaceの前提をリポジトリ内で再現可能にする。
- `externalSandbox: true`を通常CIの回避策として使用しない。
- Playwright browserと`playwright-core`のversion対応を検証する。
- integration jobへ`timeout-minutes`を設定する。

完了条件:

- GitHub ActionsのPlaywright jobが3回連続で成功する。
- CIログから`chromiumSandbox: true`相当の実行を確認できる。
- sandboxを無効化した経路は、独立sandboxを検証する専用job以外では使用しない。

#### CI-02: CIマトリクスと重複実行制御

優先度: P1
規模: M

実装内容:

- UbuntuのNode.js 22 / 24に加え、Windows Node.js 22のconsumer testを追加する。
- 必要に応じてmacOS Node.js 22をrelease前またはscheduled jobで実行する。
- workflowへ`concurrency`を設定し、同じbranchの古い実行をcancelする。
- core jobとbrowser jobに明示的なtimeoutを設定する。
- production dependencyだけでなくdev dependencyのauditも別jobで確認する。

完了条件:

- 全OSでESM、CJS、型定義、pack後installが成功する。
- branch更新時に古いCIが自動cancelされる。

#### EXT-01: DuckDuckGoの公開方針確定

優先度: P0
規模: 外部確認を含む

既定案:

- DuckDuckGo Providerは明示的opt-inのexperimental / best-effort機能とする。
- SLAや安定APIでないこと、rate limitやbot challengeがあることをREADMEへ記載する。
- 公開・商用利用の予定を整理し、必要ならDuckDuckGoへ問い合わせる。
- 条件が確定しない場合は、Braveまたはcustom Providerを本番推奨経路とする。

完了条件:

- 利用条件に関する判断と根拠をリリース記録へ残す。
- npm説明文がDuckDuckGoを公式APIと誤認させない。

### Phase C: 公開APIの整理

#### API-01: read-only利用で検索Providerを任意化

優先度: P1
規模: M

実装内容:

- `LlmFetchOptions.search`をoptionalにする。
- Provider未設定時も`read()`と`fetch_content`を利用可能にする。
- `search()`、`searchAndRead()`、`web_search`実行時だけ`CONFIG_MISSING`を返す。
- `toolset()`の定義一覧は、利用可能な機能だけを返す。

完了条件:

- 検索依存なしのcore-only consumer testが成功する。
- Providerありの既存API動作を維持する。

#### API-02: Guard拒否結果の構造化

優先度: P1
規模: M

実装内容:

- `require_approval`と`deny`を呼び出し側が区別できる型を追加する。
- エラーへ`guardDecision`、安全に短縮したreason、warning categoryを保持する。
- raw HTML、hidden原文、攻撃文字列はエラーへ含めない。
- toolsetは従来どおり本文をfail-closedで非公開にする。

完了条件:

- アプリが`require_approval`だけを人の承認フローへ送れる。
- ErrorのJSON化・loggingで本文やsecretが漏れない。

#### API-03: `searchAndRead()`の部分結果方針

優先度: P1
規模: M

既定案:

- 検索段階の失敗は例外にする。
- 読み取り段階で総期限に達した場合、完了済みdocumentとfailureを保持し、`timedOut: true`を返す。
- caller自身のAbortSignalによる中止は、従来どおり例外にする。
- 未開始・中止されたURLをfailureとして区別する。

完了条件:

- 総期限直前に一部ページが完了したfixtureで、その結果が失われない。
- timeout、caller abort、page failureを型で区別できる。

#### API-04: locale / language / regionの再設計

優先度: P1
規模: M

実装内容:

- DuckDuckGoの`kl`とBraveの`search_lang`の意味と許容形式を公式仕様で再確認する。
- 共通入力を`language`と`region`へ分けるか、Providerごとのmappingを明文化する。
- BCP 47、ISO language、country codeのどれを受け付けるかを型とvalidatorで固定する。
- fallback Provider間で意味が失われる設定は、事前にエラーまたは明示的な変換にする。

完了条件:

- 日本語、日本地域、英語、米国地域のmapping testがある。
- READMEの用語と実際のquery parameterが一致する。

#### API-05: OpenAI / Bedrockツール定義の明確化

優先度: P1
規模: M

実装内容:

- Responses API用にフラットなfunction tool定義を返す`openaiResponsesDefinitions()`を追加する。
- Chat Completions用は`openaiChatCompletionsDefinitions()`へ明示的に命名する。
- 既存`openaiDefinitions()`は未公開段階で置換するか、移行期間を設けてdeprecatedにする。
- 可能なAPIではstrict schemaを有効にする。
- Bedrockを含め、実SDKの型に代入できるconsumer compatibility testを追加する。
- runtime dependencyには各SDKを追加しない。

完了条件:

- OpenAI Responses、Chat Completions、Bedrockそれぞれの完全なtool-call loop例が動作する。
- API名から対象サービス形式を誤解しない。

#### API-06: SearchHitのtaint明示

優先度: P1
規模: S

実装内容:

- `SearchHit`またはそのwrapperへ`trust: "untrusted"`、`tainted: true`を追加する。
- `searchAndRead().hits`にも同じ印を保持する。
- direct APIとtoolsetの安全性の差をREADMEへ記載する。

完了条件:

- 型定義を見るだけで検索タイトル・snippetが外部入力だと分かる。

#### API-07: custom transportの責任境界

優先度: P1
規模: M

実装内容:

- custom fetcher / retrieverがSSRF、DNS、redirect、size、deadlineを担うことを型と文書で統一する。
- custom transport利用時に明示的なopt-in名を要求する案を検討する。
- custom retrieverが返す`finalUrl`を再検証する。ただし、実際に接続したIPをclientが保証できない点は明記する。
- AbortSignalを無視する実装は待機を終了できても内部作業を停止できないことを文書化する。

完了条件:

- 安全でないcustom transportを誤って本番利用しにくいAPIになる。

### Phase D: 抽出品質とブラウザ境界

#### EXT-02: dynamic判定と抽出fixtureの拡充

優先度: P1
規模: M

実装内容:

- SSR、CSR shell、hydration、本文よりboilerplateが多いページをfixture化する。
- `render: "auto"`のfalse positive / false negativeを記録する。
- candidate選択の重複走査をSEC-01と合わせて解消する。
- Shadow DOM、CSS generated content、canvas、画像内文字、iframeを取得しないことを公開仕様にする。

完了条件:

- frozen fixtureで抽出文字数、title、render切替の期待値を固定する。
- 対応外コンテンツを空の成功結果として返さない。

#### EXT-03: browser modeの事前検査差を明文化

優先度: P1
規模: S

実装内容:

- `auto`はHTTP raw HTMLをGuard後にbrowserへ切り替えることを説明する。
- `always`は二重取得を避けるためJavaScript実行前検査を行わないことを説明する。
- `always`へsecret、cookie、binding、高権限toolを渡さない要件をREADMEとSECURITYへ記載する。

完了条件:

- `auto`と`always`のセキュリティ差が公開READMEだけで理解できる。

#### EXT-04: response type設定の整合

優先度: P2
規模: S

実装内容:

- `allowedContentTypes`をclientが抽出可能な形式へ制限するか、対応extractorを追加する。
- fetcherでは成功しclient境界で拒否される設定を、構築時に検出する。

完了条件:

- 設定として受理したcontent typeが後段で必ず処理可能になる。

### Phase E: テスト、性能、外部互換性

#### TST-01: coverage導入

優先度: P1
規模: S

実装内容:

- `@vitest/coverage-v8`をdev dependencyへ追加する。
- `test:coverage`を追加し、CIで実行する。
- 初期閾値を全体lines / functions / statements 85%、branches 80%とする。
- `src/security`と`src/retrieval`はlines 90%以上を目標にする。
- 閾値変更は理由をPRへ残す。

完了条件:

- coverage不足でCIが失敗する。
- generated codeや型だけのfileを除外する場合は設定に理由を書く。

#### TST-02: Context Guard評価コーパス

優先度: P1
規模: L

実装内容:

- 高危険度攻撃、難読化、引用・教育目的の正常文、日英混在文をfixture化する。
- location、requestedUse、profile別に期待decisionを持つ。
- 高危険度攻撃が`allow`になった件数と、正常文が`deny` / `require_approval`になった件数を集計する。
- 精度指標をリリース成果物へ残す。

完了条件:

- 高危険度攻撃fixtureが`allow`になるケースは0件。
- benign fixtureの`deny`は0件。
- benign fixtureの`require_approval`率は5%以下を初期目標とする。

#### TST-03: PlaywrightフルE2E

優先度: P1
規模: L

対象シナリオ:

- `playwrightRetriever.retrieve()`を通した正常取得。
- subframe、popup、download、WebSocket、Service Worker、非GET/HEADの遮断。
- publicからprivateへのredirect、DNS変化、request上限、network byte上限。
- computed-hidden、DOM API改変、過大DOM、期限超過。
- fresh BrowserContext、cookie / storage非共有、close後のresource解放。

完了条件:

- unitの直接snapshot testだけでなく、retriever入口から最終`RetrievedDocument`まで検証する。
- fixture環境は外部実サイトへ依存せず、隔離されたCIネットワークで再現できる。

#### TST-04: pinned proxy境界テスト

優先度: P1
規模: M

対象シナリオ:

- 認証済みHTTP / CONNECTの成功経路。
- response size、request size、header数、header長、hop-by-hop header。
- DNS resolver timeout、複数address、private address混在、接続途中close。
- 複数回close、同時close、active socketを含むclose。

完了条件:

- proxyの全エラーがsocket leakを残さず終了する。

#### TST-05: 外部Provider互換テスト

優先度: P1
規模: M

実装内容:

- DuckDuckGo signed Web / HTML / Liteのfrozen fixtureを増やす。
- Braveのlive smokeをrelease前手動jobとして実行する。
- secretをfork PRへ渡さないworkflow条件を設定する。
- DuckDuckGoの軽量canaryをscheduled jobで実行し、parser変更とchallengeを区別する。

完了条件:

- fixture parser testは通常CIで完結する。
- live failureは空結果として成功扱いしない。

#### TST-06: package consumer互換テスト

優先度: P1
規模: M

対象:

- ESM、CommonJS、TypeScript NodeNext、bundler resolution。
- core-only install、Playwright subpath import、browser runtimeあり / なし。
- OpenAI Responses、OpenAI Chat Completions、Bedrockの型互換。
- Windows pathとscoped / unscoped package名。

完了条件:

- `npm pack`したtarballだけを使って検証する。
- `publint`とAre The Types WrongをCIへ組み込む。

#### PERF-01: 再現可能な性能ゲート

優先度: P1
規模: M

実装内容:

- benchmark runner、CPU、Node version、warm-up、sample数を固定する。
- meanだけでなくp50、p95、p99、ばらつきを出力する。
- DDG parser、50KiB Guard、1MiB HTML抽出、深いDOM、browser cold / warmを分ける。
- 現在の絶対目標を再計測し、達成できない場合は最適化または根拠付きで更新する。
- 承認済みbaselineから20%以上悪化した場合にCIで失敗させる。

暫定目標:

- DuckDuckGo 50KiB parser: p95 15ms以下。
- Context Guard 50KiB: p95 10ms以下。
- HTML 1MiB抽出＋Guard: p95 75ms以下。達成不能の場合は、公開前に新目標と理由を記録する。
- すべての入力で構造上限とdeadlineを優先し、性能のためにfail-closedを弱めない。

#### PERF-02: soak / resource leak試験

優先度: P2
規模: M

実装内容:

- BrowserContext、CDP session、proxy、socketを数百回作成・破棄する。
- heap、RSS、active handle、file descriptorを開始前後で比較する。
- caller abort、timeout、queue full、browser crashを混ぜる。

完了条件:

- 安定状態でresourceが継続増加しない。

### Phase F: 運用、文書、保守性

#### OPS-01: per-host負荷制御と429処理

優先度: P1
規模: M

実装内容:

- `searchAndRead()`へper-host concurrency上限を追加する。
- 429の`Retry-After`を上限付きで解析し、`cooldownMs`へ反映する。
- Provider cooldownのプロセス内限定性を文書化する。
- 分散環境向けに外部cooldown storeを注入できる最小interfaceを検討する。

完了条件:

- 同一hostへ16並列のような集中アクセスを標準設定で行わない。
- 不正な`Retry-After`で長時間停止しない。

#### OPS-02: 安全なobservability hook

優先度: P2
規模: M

実装内容:

- cache hit、provider route、fallback、duration、error code、Guard decisionをイベント化する。
- query、URL、本文、API key、cookieを既定イベントへ含めない。
- loggerをruntime dependencyとして追加せず、callback interfaceだけ提供する。

完了条件:

- 利用者がProvider劣化と性能回帰を秘密情報なしで監視できる。

#### DOC-01: READMEと実装の一致

優先度: P1
規模: S

修正対象:

- 「non-GETをblock」を「GET / HEAD以外をblock」へ修正する。
- `auto`と`always`の事前検査差を追加する。
- SearchHitが未信頼であることを型と例で示す。
- charset、Shadow DOM、canvas、外部CSS、標準port限定をlimitationsへ追加する。
- OpenAI Responses / Chat Completions / Bedrockのメソッドを分けて説明する。

完了条件:

- README英語版と日本語版の見出し・コード例・制約が対応する。

#### DOC-02: API / Error reference

優先度: P1
規模: M

実装内容:

- 全optionの型、既定値、最小値、最大値を表にする。
- error code、retryable、cooldown、承認要否、推奨処理を一覧化する。
- OpenAI / Bedrockの完全な実行例を追加する。
- custom Provider / fetcher / retriever / Guardの契約を記載する。

#### DOC-03: PrivacyとResponsible Use

優先度: P1
規模: S

実装内容:

- 検索queryが選択Providerへ送信されることを明記する。
- 取得先サイトへ利用者のIP、User-Agent、アクセス時刻が伝わることを明記する。
- browser modeが第三者JavaScriptを実行することを明記する。
- サイト規約、アクセス頻度、robots、個人情報、著作権を利用者が確認する責任を記載する。

#### DOC-04: 検証記録の更新方式

優先度: P1
規模: S

実装内容:

- `plan.md`のテスト件数、benchmark、CI成功記録を現在値へ更新する。
- 頻繁に変わる値は固定記載せず、CI artifactまたはrelease noteへ移す。
- `npm run verify:release-report`等でpack size、test数、coverage、benchmark summaryを生成する案を検討する。

#### MNT-01: 大型moduleの分割

優先度: P2
規模: L

分割案:

- `client.ts`: validation、search pipeline、read pipeline、cache / lifecycleへ分割する。
- `playwright/retriever.ts`: launch、request policy、navigation、snapshot、lifecycleへ分割する。
- 分割前後でpublic exportsとbundle sizeを変えない。

完了条件:

- 1ファイルの変更が無関係な機能へ波及しにくくなる。
- 循環依存を追加しない。

#### MNT-02: buildとversion情報

優先度: P2
規模: S

実装内容:

- package versionからUser-Agent文字列をbuild時に生成する。
- source mapを公開するか決定し、公開する場合はconsumer stack trace testを追加する。
- `packageManager`と利用npm versionを固定する。

#### GOV-01: リポジトリ運用

優先度: P2
規模: S

実装内容:

- main branch protectionと必須CIを設定する。
- Dependabotまたは同等のdependency update監視を有効にする。
- CHANGELOG、CONTRIBUTING、必要に応じてCODEOWNERSと行動規範を追加する。
- release tag、GitHub Release、npm versionの対応ルールを決める。

## 6. 推奨PR分割

| 順序 | PR | 主な作業 | 依存 |
| ---: | --- | --- | --- |
| 1 | `fix/bounded-html-processing` | SEC-01 | なし |
| 2 | `fix/guard-segment-truncation` | SEC-02 | なし |
| 3 | `fix/content-decoding` | SEC-03 | PR 1推奨 |
| 4 | `test/security-coverage-corpus` | TST-01、TST-02 | PR 1〜3 |
| 5 | `refactor/pre-release-api` | API-01〜API-04、API-06、API-07 | PR 1〜3 |
| 6 | `feat/tool-definition-formats` | API-05、TST-06の一部 | PR 5 |
| 7 | `test/playwright-sandbox-e2e` | CI-01、TST-03、TST-04 | PR 1 |
| 8 | `test/provider-canaries-performance` | TST-05、PERF-01 | PR 1〜3 |
| 9 | `docs/public-contracts` | EXT-01、EXT-03、DOC-01〜DOC-04 | PR 5〜8 |
| 10 | `chore/package-identity` | PKG-01、MNT-02 | 最終package名決定後 |
| 11 | `ci/trusted-publishing` | PKG-02、CI-02、GOV-01の一部 | PR 10 |
| 12 | `release/v0.1.0-rc.1` | 全ゲート再検証 | PR 1〜11 |

大型refactorでP0修正を遅らせないため、MNT-01は`v0.1.0`後でもよい。P0修正とAPI変更は別PRにし、障害原因を切り分けられるようにする。

## 7. リリース検証手順

### 7.1 自動検証

最低限、次を1つのrelease verifyから実行できるようにする。

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run verify:licenses
npm run verify:package
npm run bench:ci
```

追加job:

- Node.js 22 / 24 core matrix。
- Windows packed-consumer test。
- sandbox有効のLinux Chromium integration。
- OpenAI / Bedrock type compatibility。
- scheduled Provider canary。
- production / development dependency audit。

### 7.2 リリース候補の手動確認

1. `git status`が意図した変更だけであることを確認する。
2. release commitとtagのversionが一致することを確認する。
3. `npm pack --dry-run --json`で公開ファイルを確認する。
4. tarballを空のESM / CJS / TypeScript projectへinstallする。
5. core-only環境に`playwright-core`が入らないことを確認する。
6. Chromium環境でHTTP、auto、alwaysを各1件実行する。
7. Brave live smokeとDuckDuckGo canaryを実行する。
8. npm publish dry-runとprovenance対象リポジトリを確認する。
9. READMEのinstall例を最終package名でコピー実行する。
10. 公開承認後にのみtag / release / publishを実行する。

## 8. リスク管理

| リスク | 影響 | 対応 |
| --- | --- | --- |
| DOM上限追加で正常な大規模記事を拒否する | 抽出率低下 | frozen実サイトfixtureと上限到達telemetryで調整する |
| Guard切り捨てを安全側へ倒すことで誤検知が増える | 利用者の承認負荷 | コーパスで計測し、切り捨て理由を構造化して返す |
| API整理で既存nextjs integrationが壊れる | 内部移行コスト | tarball consumer testと移行差分を同じPRへ含める |
| Chromium sandboxがCI環境に依存する | CI不安定 | version固定の非root containerと3回連続成功をゲートにする |
| DuckDuckGoの画面構造が変わる | 検索停止 | frozen fixture、scheduled canary、Brave fallbackを用意する |
| benchmarkがrunner負荷で揺れる | 誤った回帰判定 | 専用条件、複数sample、相対baseline、p95を用いる |
| publish workflowの誤作動 | 誤公開 | npm environment承認、tag/version検査、`private`解除を最終工程にする |

## 9. 規模の目安

| 規模 | 目安 |
| --- | --- |
| S | 半日程度。局所的な型・文書・設定変更 |
| M | 1〜3日程度。複数fileと回帰テストを含む |
| L | 3〜7日程度。設計変更、fixture、CIまたは外部環境を含む |

P0と公開必須P1だけを対象にした場合でも、単独作業でおおむね4〜7週間相当を見込む。外部利用条件の確認、npm scope取得、CI sandbox調整は待ち時間が読みにくいため、SEC-01 / SEC-02と並行して着手する。

## 10. 最終リリース判定チェックリスト

- [ ] SEC-01: 深いHTMLでdeadline逸脱や生の`RangeError`が発生しない
- [ ] SEC-02: segment切り捨てが必ずGuard判定へ反映される
- [ ] SEC-03: charset処理がclientとstandalone Guardで一致する
- [ ] GitHub Actionsの全必須jobが成功している
- [ ] Chromium sandbox有効のintegration testが成功している
- [ ] coverageとGuardコーパスの閾値を満たしている
- [ ] performance targetを満たすか、変更理由が承認されている
- [ ] OpenAI Responses / Chat Completions / Bedrockの互換テストが成功している
- [ ] Windowsを含むpacked consumer testが成功している
- [ ] final package名、README、repository metadataが一致している
- [ ] DuckDuckGoの公開上の扱いが確定している
- [ ] README英語版・日本語版・SECURITYの記述が実装と一致している
- [ ] production / development dependency auditに未解決の重大問題がない
- [ ] `publint`とAre The Types Wrongが成功している
- [ ] npm publish dry-runが成功している
- [ ] provenanceのリポジトリ情報が正しい
- [ ] CHANGELOGとrelease noteが用意されている
- [ ] 明示的な公開承認を得ている
