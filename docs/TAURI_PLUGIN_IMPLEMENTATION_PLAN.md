# `tauri-plugin-llm-fetch` 実装計画書

- ステータス: Implemented / macOS release gate passed
- 最終レビュー日: 2026-08-31
- 対象リポジトリ: `/Users/y.noguchi/Code/llm-fetch`
- 対象成果物: Cargo crate `tauri-plugin-llm-fetch`
- 基準バージョン: Tauri `2.11.5`、`tauri-plugin` `2.6.3`
- 初版の正式対象: macOS 14 以降

この文書は実装前の判断理由と実装後のas-built仕様を一つに保持する。保守時の優先順位は、(1) public contract/config、(2) Section 27のas-built file責務、(3) production codeと同じmoduleのtest、(4) [`TAURI_PLUGIN_VALIDATION.md`](./TAURI_PLUGIN_VALIDATION.md)、(5) その他の設計詳細とする。詳細節に旧案の型名や分割案が残っていても、存在しないAPI/moduleを実装済みと解釈してはならない。

## 1. この計画で確定すること

本計画は、Tauri 2 の非表示 `WebviewWindow` でページを読み込み、動的 DOM から LLM 向け本文を抽出する Cargo-only プラグインを実装するための確定仕様である。

実装者は次の方針を変更しない。

1. 取得経路は Tauri のシステム WebView だけを使う。
2. Playwright、Chromium 同梱、Node.js sidecar、別ブラウザへの fallback は実装しない。
3. HTTP client を先に試す HTTP-first 構成にはしない。
4. `fetch` は `window.fetch()` のラッパーではなく、WebView のトップレベル navigation と DOM 抽出を意味する。
5. TypeScript 版は、契約、抽出品質、安全判定、制限値の参考に留め、制御フローは移植しない。
6. プラグインは Cargo crate だけを配布し、guest-js/npm パッケージを作らない。
7. 初版の public API は GET 相当の top-level navigation だけを扱う。method、body、任意 header は API に追加しない。ただし読み込んだ page 自身の JavaScript が送る HTTPS request method/body は tunnel の外から検査できず、厳密な side-effect-free は保証しない。
8. 外部ページには Tauri IPC、plugin command、event API、host capability を一切公開しない。
9. DOM の回収には Tauri `WebviewWindow::eval_with_callback` を使う。remote IPC や custom protocol bridge は使わない。
10. 検索エンジン固有の parser は plugin core に含めない。

Phase 0 に技術的な出荷可否ゲートはあるが、そこで方式を選び直すことはしない。決めた方式が対象 OS で成立するかを検証し、成立しなければ実装を停止する。

## 2. 目的

- Tauri app process が動いている間、main window を表示せずに browser rendering を伴うページ取得を実行する。
- client-side rendering、Cookie、Web Storage など、同じ background session 内の browser state を利用できるようにする。
- 取得内容を常に `untrusted` / `tainted` として返す。
- URL、network、DOM、IPC、同時実行、timeout、終了処理に明確な上限を設ける。
- prompt injection の finding と policy decision を Rust 側で生成する。
- plugin consumer が Node.js、npm、別 browser binary を導入せずに利用できるようにする。

## 3. 非目標

初版では次を実装しない。

- Playwright との切り替え、互換 adapter、fallback
- `reqwest` 等を取得主経路にした静的 HTTP fetch
- POST、PUT、PATCH、DELETE、request body、任意 header
- CAPTCHA や bot challenge の自動突破
- 自動 login、password manager、credential injection
- persistent browser profile、app 再起動をまたぐ Cookie 保存
- main UI WebView との Cookie/storage 共有
- popup、download、permission prompt、file picker
- click、scroll、form input、infinite scroll 自動化
- Google、Brave、DuckDuckGo 等の検索結果専用 parser
- Tauri app 終了後も動く daemon/service
- mobile 対応
- 既存 npm package の unpublish または破壊的削除

Tauri WebView で取得できない場合は typed error を返す。他の取得方式へ再送しない。

## 4. 用語

| 用語 | 本計画での意味 |
|---|---|
| background WebView | `visible(false)` で作成した desktop `WebviewWindow`。headless browser や OS service ではない |
| one-shot session | `fetch` のために作成し、完了後に破棄する incognito WebView |
| reusable session | app process 内で明示的に作成・close される incognito WebView。再起動後には残らない |
| fetch | 対象 URL への top-level navigation、DOM settle、抽出、安全判定の一連の処理 |
| worker WebView | plugin が内部生成する background WebView。host frontend の capability を持たない |
| egress proxy | worker WebView の HTTP(S) 通信を public Internet に限定する loopback proxy |
| DOM probe | `eval_with_callback` で ready state と mutation revision を読み取る同期 JavaScript |
| extraction payload | `eval_with_callback` が返す上限適用済み JSON object |

## 5. 現在の TypeScript 版との関係

現行 npm package は、静的 HTTP 取得、任意 browser 取得、search provider、安全判定を TypeScript で実装している。Rust 版はその API 全体を置き換えるものではなく、Tauri background navigation に必要な範囲だけを実装する。

### 5.1 参考にする領域

| TypeScript | 参考にする内容 | Rust/JavaScript の実装先 |
|---|---|---|
| `src/contracts.ts` | `untrusted`、`tainted`、document/security の意味 | `contracts.rs` |
| `src/errors.ts` | stable error code と serialization | `errors.rs` |
| `src/retrieval/extract-content.ts` | title、本文、excerpt の品質 | `assets/extractor.js`、`manager.rs` |
| `src/retrieval/html-limits.ts` | node/depth/candidate の上限 | `assets/extractor.js`、`webview.rs` |
| `src/retrieval/quality.ts` | empty/insufficient/challenge 判定 | `manager.rs` |
| `src/retrieval/dynamic-content.ts` | DOM settle の観点 | `assets/bootstrap.js`、`webview.rs` |
| `src/retrieval/outbound-policy.ts` | URL、public IP、DNS pinning の意味 | `network/policy.rs`、`network/proxy.rs` |
| `src/security/*` | segment、finding、decision、fail-closed policy | `security.rs`、`security_normalize.rs` |
| `src/internal/*` | deadline、queue、deduplication の考え方 | `manager.rs`、`session.rs` |

### 5.2 採用しない領域

- `src/playwright/*` の API、browser 起動、request interception
- `src/retrieval/http-fetcher.ts` の取得経路
- `src/retrieval/content-retriever.ts` の backend 切り替え
- `src/client.ts` の HTTP-first と `render: never | auto | always`
- `src/providers/*` の search provider 実装
- TypeScript class/module 構造の逐語移植

TypeScript と比較するのは、取得方式に依存しない contract、normalization、limit、security decision だけとする。

## 6. 配布と既存 npm package の扱い

plugin consumer 向けの配布単位は crates.io の `tauri-plugin-llm-fetch` だけとする。`tauri plugin new llm-fetch --no-api` 相当の構成とし、次を作らない。

- `guest-js/`
- `dist-js/`
- plugin 用 `package.json`
- plugin 用 npm release workflow
- Node/browser download script

host frontend からは Tauri 標準の `invoke("plugin:llm-fetch|fetch", { request })` を直接使う。npm を使わない example app では `app.withGlobalTauri: true` を設定し、`window.__TAURI__.core.invoke` を使う。

既存 TypeScript project は Rust parity fixture の参照元として当面ルートに残す。Cargo build/test/package は `package.json`、`node_modules`、`dist` に依存しない。既存 npm package の保守終了は plugin 初版とは別の release decision とし、本計画では削除しない。

## 7. モノレポの完成形

最初の実装では既存 TypeScript ファイルを移動しない。

```text
llm-fetch/
  Cargo.toml
  Cargo.lock
  crates/
    tauri-plugin-llm-fetch/
      Cargo.toml
      build.rs
      README.md
      permissions/
        default.toml
        autogenerated/
      src/
        lib.rs
        commands.rs
        config.rs
        contracts.rs
        errors.rs
        manager.rs
        manager/tests.rs
        session.rs
        lifecycle.rs
        platform.rs
        network/
          mod.rs
          policy.rs
          proxy.rs
          proxy/tests.rs
        security.rs
        security_normalize.rs
        webview.rs
        webview/types.rs
        webview/tests.rs
      assets/
        bootstrap.js
        extractor.js
      tests/
        fixtures/
          security/
            ts-guard-v1.json
  examples/
    tauri-background-fetch/
      Cargo.toml
      build.rs
      tauri.conf.json
      capabilities/default.json
      dist/index.html
      dist/app.js
      src/main.rs
  docs/
    TAURI_PLUGIN_IMPLEMENTATION_PLAN.md
  scripts/
    export-rust-guard-fixtures.mjs
  src/                                  # 既存 TypeScript reference
  test/                                 # 既存 TypeScript tests
```

初版では `llm-fetch-core` を別 crate にしない。純 Rust consumer が実際に必要になるまで分割を保留する。

## 8. Cargo workspace と依存関係

### 8.1 root `Cargo.toml`

```toml
[workspace]
members = [
  "crates/tauri-plugin-llm-fetch",
  "examples/tauri-background-fetch",
]
resolver = "2"

[workspace.package]
edition = "2021"
rust-version = "1.90"
license = "MIT"
repository = "https://github.com/ugnoguchigxp/LLM-fetch"

[workspace.lints.rust]
unsafe_code = "deny"

[workspace.lints.clippy]
all = "warn"
```

`Cargo.lock` は example binary を含む workspace の再現性確保のため commit する。

### 8.2 plugin `Cargo.toml`

実装開始時は次を基準にする。version range を独自判断で広げない。

```toml
[package]
name = "tauri-plugin-llm-fetch"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true
links = "tauri-plugin-llm-fetch"

[package.metadata.platforms.support]
macos = { level = "full", notes = "macOS 14+" }
windows = { level = "partial", notes = "preview; hidden background reliability is best effort" }
linux = { level = "partial", notes = "preview; hidden background reliability is best effort" }
android = { level = "none", notes = "not supported" }
ios = { level = "none", notes = "not supported" }

[features]
default = []

[dependencies]
bytes = "1"
base64 = "0.22"
http = "1"
http-body-util = "0.1"
hyper = { version = "1", features = ["client", "http1", "server"] }
hyper-util = { version = "0.1", features = ["tokio"] }
ipnet = "2"
regex = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
sysinfo = { version = "=0.37.2", default-features = false, features = ["system"] }
tauri = { version = "=2.11.5", default-features = false, features = ["wry", "macos-proxy"] }
thiserror = "2"
time = { version = "0.3", features = ["formatting", "macros", "serde"] }
tokio = { version = "1", features = ["io-util", "macros", "net", "rt", "sync", "time"] }
tokio-util = { version = "0.7", features = ["rt"] }
unicode-normalization = "0.1"
url = { version = "2", features = ["serde"] }
uuid = { version = "1", features = ["serde", "v4"] }

[build-dependencies]
tauri-plugin = { version = "=2.6.3", features = ["build"] }

[lints]
workspace = true
```

`reqwest`、browser automation、process spawning crate は追加しない。`hyper` は WebView に指定する egress proxy の実装だけに使い、別の取得 backend には使わない。

production と異なる DNS/loopback 例外を crate に入れない。実 WebView の境界試験は public HTTPS canary を使い、plugin の feature は `default = []` だけに固定する。

### 8.3 build script

`build.rs` は command permission だけを生成する。global API script と global scope schema は指定しない。

```rust
const COMMANDS: &[&str] = &[
    "status",
    "create_session",
    "fetch",
    "cancel",
    "close_session",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
```

### 8.4 example `Cargo.toml` / `build.rs`

```toml
[package]
name = "tauri-background-fetch"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
publish = false

[features]
default = []
custom-protocol = ["tauri/custom-protocol"]

[dependencies]
serde_json = "1"
tauri = { version = "=2.11.5", features = ["wry"] }
tauri-plugin-llm-fetch = { path = "../../crates/tauri-plugin-llm-fetch" }
tokio = { version = "1", features = ["time"] }
uuid = "1"

[build-dependencies]
tauri-build = "=2.6.3"

[lints]
workspace = true
```

```rust
fn main() {
    tauri_build::build()
}
```

example は TLS test dependency や証明書を持たない。`--self-test-fast`、`--self-test-boundary`、`--self-test-long`、`--self-test-leak`、`--self-test-reuse` は production と同じ URL/DNS/proxy policy のまま public HTTPS canary を取得する。

## 9. 公開 API

初版で公開する command/Rust method は次の五つに固定する。

public request struct は `#[serde(rename_all = "camelCase", deny_unknown_fields)]`、public response struct は `#[serde(rename_all = "camelCase")]`、enum は各 snippet の `rename_all` を使う。UUID は hyphenated lowercase string、timestamp は UTC の RFC 3339 millisecond precision (`2026-08-30T12:34:56.789Z`) とする。optional response field は `#[serde(skip_serializing_if = "Option::is_none")]` を付け、`null` ではなく key 自体を省略する。

本書の `characters` / `code points` は Rust `str::chars()` と JavaScript `for...of` が数える Unicode scalar 単位、`bytes` は UTF-8 byte 単位である。JavaScript の UTF-16 `String.length` を limit 判定に使わない。

timestamp は `time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z")` を `contracts.rs` の private helper 一箇所だけで使う。`fetched_at` と `source.retrieved_at` は response 組み立て時に得た同じ文字列を clone し、JavaScript clock を使わない。

| operation | blocking behavior | repeat behavior |
|---|---|---|
| `status` | 即時 | idempotent |
| `create_session` | WebView と proxy の起動完了まで待つ | 非 idempotent。毎回新しい session ID |
| `fetch` | 抽出と guard 完了まで待つ | `request_id` で重複を拒否 |
| `cancel` | cancellation を設定して即時返す | registry に存在する間は `accepted=true`。完了・未知 ID は `false`。cancel effect 自体は idempotent |
| `close_session` | in-flight cancel と resource cleanup 完了まで待つ | registryから先に除去するため、並行する二件目・完了後・未知IDは`SESSION_NOT_FOUND`。closeと競合して既にArcを取得済みの`fetch`は`SESSION_CLOSED` |

### 9.1 Rust extension trait

```rust
pub trait LlmFetchExt<R: tauri::Runtime> {
    fn llm_fetch(&self) -> &LlmFetch<R>;
}

impl<R: tauri::Runtime, T: tauri::Manager<R>> LlmFetchExt<R> for T {
    fn llm_fetch(&self) -> &LlmFetch<R> {
        self.state::<LlmFetch<R>>().inner()
    }
}
```

`LlmFetch<R>` は `Arc<LlmFetchManager<R>>` を持ち、manager が `AppHandle<R>` を所有する。command と Rust API は同じ async method を呼び、command 側だけ別実装を持たない。

### 9.2 command signature

```rust
#[tauri::command]
async fn status<R: Runtime>(app: AppHandle<R>) -> Result<PluginStatus, ErrorResponse>;

#[tauri::command]
async fn create_session<R: Runtime>(
    app: AppHandle<R>,
    request: CreateSessionRequest,
) -> Result<SessionInfo, ErrorResponse>;

#[tauri::command]
async fn fetch<R: Runtime>(
    app: AppHandle<R>,
    request: FetchRequest,
) -> Result<RetrievedDocument, ErrorResponse>;

#[tauri::command]
async fn cancel<R: Runtime>(
    app: AppHandle<R>,
    request: CancelRequest,
) -> Result<CancelResult, ErrorResponse>;

#[tauri::command]
async fn close_session<R: Runtime>(
    app: AppHandle<R>,
    request: CloseSessionRequest,
) -> Result<CloseSessionResult, ErrorResponse>;
```

### 9.3 request types

すべて `#[serde(rename_all = "camelCase", deny_unknown_fields)]` を付ける。

request struct は `Debug + Clone + Deserialize`、response struct は `Debug + Clone + Serialize`、command の両側で使う enum/newtype は `Debug + Clone + Serialize + Deserialize + PartialEq + Eq` を derive する。`f32` を含む `SecurityFinding` は `Eq` を derive せず、生成時 validation を行う。

```rust
pub struct CreateSessionRequest {
    pub allowed_hosts: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
}

pub struct FetchRequest {
    pub request_id: String,
    pub session_id: Option<Uuid>,
    pub url: String,
    pub timeout_ms: Option<u64>,
    pub settle_quiet_ms: Option<u64>,
    pub max_characters: Option<usize>,
    pub requested_use: Option<RequestedContextUse>,
    pub source: Option<SourceInput>,
}

pub struct CancelRequest {
    pub request_id: String,
}

pub struct CloseSessionRequest {
    pub session_id: Uuid,
}
```

request override は global/session config を狭める方向にだけ適用する。上限を超える値は clamp せず `INVALID_INPUT` を返す。

`request_id` は `^[A-Za-z0-9._:-]{1,128}$` に一致させる。URL や free-form text を request ID に埋め込ませない。

request field の default/override rule:

- `timeout_ms`: 未指定は `config.request_timeout_ms`。指定値は 500..=global value
- `settle_quiet_ms`: 未指定は global value。指定値は 100..=global value かつ `<= settle_timeout_ms`
- `max_characters`: 未指定は global value。指定値は 1,000..=global value
- `requested_use`: 未指定は `summarize`
- `source`: 未指定なら response も `None`。指定時は `SourceKind::SearchResult`
- `session_id`: 未指定なら one-shot。指定時は reusable session 以外へ fallback しない

`create_session.allowed_hosts` は 1..=64 entries を必須とし、`"*"` を拒否する。reusable session は exact/subdomain pattern で利用 origin と必要 subresource origin を明示しなければ作れない。one-shot だけが global `allowedHosts: ["*"]` を利用できる。

`create_session.idle_timeout_ms` は未指定なら `config.session_idle_timeout_ms`、指定時は 1,000..=global value とする。session host pattern は IDNA/lowercase canonicalization 後の重複を `INVALID_INPUT` にし、`SessionInfo.allowed_hosts` には canonical form を返す。global config の不正 pattern は plugin setup error、command request の不正 pattern は `INVALID_INPUT` とし、両者を同じ public error に潰さない。

### 9.4 shared contract types

```rust
#[serde(rename_all = "snake_case")]
pub enum RequestedContextUse {
    Summarize,
    AnswerWithCitation,
    ExtractFacts,
    SearchMore,
    CallReadonlyTool,
}

pub struct SourceInput {
    pub provider: String,
    pub query: String,
    pub rank: u32,
    pub snippet: Option<String>,
}

pub struct SourceMetadata {
    pub kind: SourceKind,
    pub trust: TrustLevel,
    pub url: String,
    pub final_url: String,
    pub provider: Option<String>,
    pub query: Option<String>,
    pub rank: Option<u32>,
    pub snippet: Option<String>,
    pub retrieved_at: String,
}

#[serde(rename_all = "snake_case")]
pub enum SourceKind { SearchResult }

#[serde(rename_all = "snake_case")]
pub enum TrustLevel { Untrusted }

pub struct SecurityResult {
    pub trust: TrustLevel,
    pub tainted: bool,
    pub guard: String,
    pub findings: Vec<SecurityFinding>,
    pub assurance: Assurance,
    pub decision: GuardDecision,
    pub reasons: Vec<String>,
    pub limitations: Vec<String>,
}

pub struct SecurityFinding {
    pub category: SecurityFindingCategory,
    pub severity: SecurityFindingSeverity,
    pub confidence: f32,
    pub location: SecurityFindingLocation,
    pub reason: String,
    pub techniques: Vec<String>,
    pub segment_hash: String,
}

#[serde(rename_all = "snake_case")]
pub enum GuardDecision { Allow, AllowWithWarning, RequireApproval, Deny }

#[serde(rename_all = "snake_case")]
pub enum Assurance { Low }

#[serde(rename_all = "snake_case")]
pub enum SecurityFindingSeverity { Info, Low, Medium, High, Critical }

#[serde(rename_all = "snake_case")]
pub enum SecurityFindingLocation {
    Visible, Hidden, Comment, Attribute, Meta, Template,
}

#[serde(rename_all = "snake_case")]
pub enum SecurityFindingCategory {
    InstructionOverride,
    RoleRedefinition,
    SecretExfiltration,
    ToolInvocation,
    ExternalSend,
    MemoryWrite,
    PolicyOverride,
    SourceSuppression,
    OutputControl,
    AuthorityClaim,
    HiddenInstruction,
    LowTrustAttribute,
    BenignMention,
}
```

input validation:

- `provider`: `^[A-Za-z0-9._-]{1,64}$`
- `query`: trim 後 1..=1,024 characters。response には trim 後の値を返す
- `rank`: 1..=10,000
- `snippet`: 0..=4,096 characters
- `query` / `snippet` は NUL、C0/C1 control を拒否する。ただし query/snippet 内の LF/TAB/CR は single space に normalize してから長さを測る
- `confidence`: Rust rule engine が finite 0.0..=1.0 で生成する。JavaScript input には含めない
- `guard`: crate version を含まない固定値 `llm-fetch-rust-guard-v1`

### 9.5 response types

```rust
pub struct RetrievedDocument {
    pub request_id: String,
    pub session_id: Option<Uuid>,
    pub url: String,
    pub final_url: String,
    pub title: String,
    pub text: String,
    pub excerpt: Option<String>,
    pub content_type: String,
    pub language: Option<String>,
    pub fetched_at: String,
    pub fetch_method: FetchMethod,
    pub character_count: usize,
    pub truncated: bool,
    pub source: Option<SourceMetadata>,
    pub security: SecurityResult,
    pub diagnostics: FetchDiagnostics,
}

#[serde(rename_all = "snake_case")]
pub enum FetchMethod {
    TauriWebview,
}
```

`diagnostics` は秘密を含まない count/timing だけを返す。

```rust
pub struct FetchDiagnostics {
    pub queued_ms: u64,
    pub navigation_ms: u64,
    pub settle_ms: u64,
    pub extraction_ms: u64,
    pub guard_ms: u64,
    pub navigation_count: u32,
    pub dom_nodes_visited: u32,
    pub network_received_bytes: u64,
    pub network_sent_bytes: u64,
    pub network_budget_exhausted: bool,
    pub truncation_reasons: Vec<TruncationReason>,
}
```

`RetrievedDocument.truncated` は dedupe 済み `diagnostics.truncation_reasons` が一件以上なら `true`、0 件なら `false`。reason の順序は DOM node/depth/candidate/text/segment 処理で発生した順、その後に settle、network budget、security character、finding limit を merge した順に固定する。`security.trust` は常に `untrusted`、`security.tainted` は常に `true` とする。これらを request/JavaScript payload から受け取らない。

public serialization に現れる `FetchStage` と `TruncationReason` は `contracts.rs` に定義し、`session.rs` と extraction/security module が import する。`ErrorCode/ErrorResponse` は `errors.rs` に置き、`contracts.rs -> errors.rs` の逆参照を作らない。

補助 response は次に固定する。

```rust
pub struct SessionInfo {
    pub session_id: Uuid,
    pub created_at: String,
    pub idle_timeout_ms: u64,
    pub allowed_hosts: Vec<String>,
}

pub struct CancelResult {
    pub accepted: bool, // request が active/queued なら true。unknown/completed は false
}

pub struct CloseSessionResult {
    pub session_id: Uuid,
    pub closed: bool, // success response では常に true
}
```

### 9.6 status types

```rust
pub struct PluginStatus {
    pub version: String,
    pub platform: String,
    pub support: PlatformSupport,
    pub active_sessions: usize,
    pub active_requests: usize,
    pub queued_requests: usize,
    pub shutting_down: bool,
}

pub struct PlatformSupport {
    pub overall: SupportLevel,
    pub proxy_enforcement: SupportLevel,
    pub background_execution: SupportLevel,
    pub incognito_storage: SupportLevel,
    pub reasons: Vec<String>,
}

#[serde(rename_all = "snake_case")]
pub enum SupportLevel {
    Supported,
    BestEffort,
    Unsupported,
}
```

## 10. Error contract

```rust
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    UnsupportedPlatform,
    BackgroundUnsupported,
    WebviewUnavailable,
    SessionNotFound,
    SessionClosed,
    SessionCapacity,
    QueueFull,
    DuplicateRequest,
    UnsafeUrl,
    DnsFailure,
    ProxyFailure,
    NavigationFailed,
    NavigationUnstable,
    EvaluationFailed,
    ResponseTooLarge,
    UnsupportedContentType,
    ContentInsufficient,
    BotChallenge,
    GuardFailed,
    Timeout,
    Cancelled,
    Internal,
}

pub struct ErrorResponse {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub stage: Option<FetchStage>,
    pub request_id: Option<String>,
    pub session_id: Option<Uuid>,
}
```

内部依存エラーは発生箇所で固定 `ErrorCode` へ変換し、未使用の総称error wrapperは置かない。OS error、full URL query、page body、Cookie、proxy payload、JavaScript payload は serialize/log しない。

retryable の既定は次のとおりとする。

| retryable | code |
|---|---|
| `true` | `SESSION_CAPACITY`, `QUEUE_FULL`, `DNS_FAILURE`, `PROXY_FAILURE`, `NAVIGATION_FAILED`, `NAVIGATION_UNSTABLE`, `EVALUATION_FAILED`, `TIMEOUT` |
| `false` | `INVALID_INPUT`, `UNSUPPORTED_PLATFORM`, `BACKGROUND_UNSUPPORTED`, `WEBVIEW_UNAVAILABLE`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`, `DUPLICATE_REQUEST`, `UNSAFE_URL`, `RESPONSE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`, `CONTENT_INSUFFICIENT`, `BOT_CHALLENGE`, `GUARD_FAILED`, `CANCELLED`, `INTERNAL` |

public message は error code ごとの固定された英語文にし、internal cause を埋め込まない。validation で複数 field が不正でも最初の一件だけを返し、検証順は request struct の field 順、次に cross-field、URL/host policy の順に固定する。

| code | fixed `message` |
|---|---|
| `INVALID_INPUT` | `The request is invalid.` |
| `UNSUPPORTED_PLATFORM` | `This platform is not supported.` |
| `BACKGROUND_UNSUPPORTED` | `Reliable background WebView execution is not supported on this platform.` |
| `WEBVIEW_UNAVAILABLE` | `The background WebView is unavailable.` |
| `SESSION_NOT_FOUND` | `The session was not found.` |
| `SESSION_CLOSED` | `The session is closing or closed.` |
| `SESSION_CAPACITY` | `The background session capacity is exhausted.` |
| `QUEUE_FULL` | `The request queue is full.` |
| `DUPLICATE_REQUEST` | `The request ID is already active.` |
| `UNSAFE_URL` | `The URL or resolved network target is not allowed.` |
| `DNS_FAILURE` | `DNS resolution failed.` |
| `PROXY_FAILURE` | `The egress proxy failed.` |
| `NAVIGATION_FAILED` | `The WebView navigation failed.` |
| `NAVIGATION_UNSTABLE` | `The page continued navigating and could not be stabilized.` |
| `EVALUATION_FAILED` | `The page could not be evaluated safely.` |
| `RESPONSE_TOO_LARGE` | `The extraction response exceeded its size limit.` |
| `UNSUPPORTED_CONTENT_TYPE` | `The page content type is not supported.` |
| `CONTENT_INSUFFICIENT` | `The page did not contain enough readable text.` |
| `BOT_CHALLENGE` | `The page appears to be a bot challenge.` |
| `GUARD_FAILED` | `The content guard failed.` |
| `TIMEOUT` | `The request timed out.` |
| `CANCELLED` | `The request was cancelled.` |
| `INTERNAL` | `An internal error occurred.` |

`ErrorResponse.stage` は request registry insert 前の deserialize/validation/duplicate error では `None`、insert 後の session lookup を含む error は registry の現在 stage を `Some` で snapshot する。registry stage は insert 時 `Queued`、one-shot/session creation 時 `CreatingSession`、以後 Section 14 の state 更新と同じ値にする。`request_id` は有効な ID を取得できた場合だけ、`session_id` は caller が有効な UUID を指定した場合だけ含める。

## 11. Plugin configuration

Tauri config の `plugins.llm-fetch` から `Option<Config>` を読み、未指定時は `Default` を使う。`Builder::<R, Option<Config>>::new("llm-fetch")` を使い、`Config` には `deny_unknown_fields` を付ける。設定誤記は plugin setup を失敗させる。

```rust
#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub max_sessions: usize,
    pub max_queue_depth: usize,
    pub request_timeout_ms: u64,
    pub navigation_timeout_ms: u64,
    pub settle_quiet_ms: u64,
    pub settle_timeout_ms: u64,
    pub eval_timeout_ms: u64,
    pub session_create_timeout_ms: u64,
    pub session_idle_timeout_ms: u64,
    pub max_characters: usize,
    pub max_payload_bytes: usize,
    pub max_dom_nodes: usize,
    pub max_dom_depth: usize,
    pub max_candidates: usize,
    pub max_segments: usize,
    pub max_segment_characters: usize,
    pub max_security_characters: usize,
    pub allow_http: bool,
    pub allowed_hosts: Vec<String>,
    pub require_reliable_background: bool,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub network: NetworkConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    pub dns_timeout_ms: u64,
    pub connect_timeout_ms: u64,
    pub max_connections: usize,
    pub max_http_response_bytes: u64,
    pub max_tunnel_received_bytes: u64,
    pub max_tunnel_sent_bytes: u64,
    pub max_request_received_bytes: u64,
    pub max_request_sent_bytes: u64,
}
```

### 11.1 defaults

| setting | default |
|---|---:|
| `maxSessions` | 2 |
| `maxQueueDepth` | 32 |
| `requestTimeoutMs` | 30,000 |
| `navigationTimeoutMs` | 15,000 |
| `settleQuietMs` | 750 |
| `settleTimeoutMs` | 5,000 |
| `evalTimeoutMs` | 2,000 |
| `sessionCreateTimeoutMs` | 10,000 |
| `sessionIdleTimeoutMs` | 300,000 |
| `maxCharacters` | 100,000 |
| `maxPayloadBytes` | 2,000,000 |
| `maxDomNodes` | 100,000 |
| `maxDomDepth` | 512 |
| `maxCandidates` | 512 |
| `maxSegments` | 128 |
| `maxSegmentCharacters` | 4,096 |
| `maxSecurityCharacters` | 250,000 |
| `allowHttp` | `false` |
| `allowedHosts` | `["*"]` |
| `requireReliableBackground` | `true` |
| `viewportWidth` / `viewportHeight` | 1280 / 900 |
| `network.connectTimeoutMs` | 5,000 |
| `network.dnsTimeoutMs` | 3,000 |
| `network.maxConnections` | 32 |
| `network.maxHttpResponseBytes` | 5,000,000 |
| `network.maxTunnelReceivedBytes` | 15,000,000 |
| `network.maxTunnelSentBytes` | 1,000,000 |
| `network.maxRequestReceivedBytes` | 25,000,000 |
| `network.maxRequestSentBytes` | 2,000,000 |

### 11.2 validation ranges

| setting | accepted range |
|---|---|
| `maxSessions` | 1..=8 |
| `maxQueueDepth` | 0..=256 |
| 各 timeout | 100..=300,000 ms。`settleQuietMs <= settleTimeoutMs`。`navigationTimeoutMs + settleTimeoutMs + evalTimeoutMs + 1,000 <= requestTimeoutMs` を checked addition で検証 |
| `maxCharacters` | 1,000..=1,000,000 |
| `maxPayloadBytes` | 64,000..=5,000,000 |
| `maxDomNodes` | 1,000..=200,000 |
| `maxDomDepth` | 32..=1,024 |
| `maxCandidates` | 16..=2,048 |
| `maxSegments` | 16..=512 |
| `maxSegmentCharacters` | 256..=16,384 |
| `maxSecurityCharacters` | 10,000..=2,000,000 |
| `network.maxConnections` | 1..=256 |
| viewport | finite value。width 320..=3840、height 240..=2160 |
| network byte limits | 64 KiB..=250 MB。per-tunnel/per-response は request 上限以下 |

### 11.3 host pattern

`allowedHosts` は次の三形式だけを受け付ける。

- `"*"`: public HTTP(S) host 全体
- `"example.com"`: exact host
- `"*.example.com"`: subdomain のみ。apex は含まない

scheme、port、path、userinfo を含む pattern は拒否する。global config なら plugin setup error、`create_session` input なら `INVALID_INPUT` とする。Unicode domain は `url` crate の IDNA normalization 後に小文字比較する。session の `allowed_hosts` は global allowlist を狭めることだけができる。

```rust
pub enum HostPattern {
    AnyPublic,
    Exact(String),
    SubdomainsOf(String),
}

pub struct HostPolicy {
    global: Vec<HostPattern>,
    session: Option<Vec<HostPattern>>,
}
```

`HostPolicy::allows(host)` は global のいずれかに一致し、かつ session がある場合は session のいずれかにも一致した時だけ true。pattern の集合演算で新しい wildcard を生成しない。

validation 完了後は raw `Config` を runtime へ渡さず、duration、non-zero limit、compiled `HostPolicy` を持つ immutable `ValidatedConfig` に変換して `Arc` で共有する。runtime code で default/range validation を再実装しない。

global `allowedHosts` も 1..=64 entries、canonicalization 後に重複なしを必須とする。`"*"` と個別 pattern の併記は冗長設定として setup error にする。host canonicalization は IDNA ASCII lowercase 化後に末尾の root dot を一つ除去し、full host 1..=253 bytes、各 label 1..=63 bytes、label 先頭/末尾 hyphen なしを検証する。空 label、連続 dot、pattern 内の IP literal を拒否する。

## 12. Runtime architecture

```text
trusted host frontend / Rust caller
  |
  | plugin command or LlmFetchExt
  v
LlmFetchManager
  |-- request registry + CancellationToken
  |-- bounded queue + global semaphore
  |-- session registry + idle reaper
  |
  v
Session
  |-- one operation mutex
  |-- one hidden incognito WebviewWindow
  |-- one loopback egress proxy
  |-- navigation generation/state
  |
  +--> public HTTP(S) through proxy
  |      |-- URL/IP policy
  |      |-- DNS answer pinning
  |      `-- connection/byte/time budgets
  |
  +--> untrusted target page in system WebView
  |      |-- bootstrap.js at document start, all frames
  |      `-- normal page JavaScript and DOM rendering
  |
  `--> Rust-originated eval_with_callback
         |-- settle probe
         `-- bounded extraction object
               |
               v
          Rust schema validation
               -> normalization
               -> quality check
               -> context guard
               -> RetrievedDocument
```

trust boundary は次のとおりである。

- host frontend/Rust caller、plugin manager、proxy policy は trusted。
- target URL、DNS answer、page、DOM、JavaScript evaluation result は untrusted。
- `bootstrap.js` と `extractor.js` は plugin asset だが、page と同じ JavaScript world で実行されるため、出力値は trusted に昇格しない。
- external page に remote capability は設定しない。

## 13. WebView の作成仕様

`webview.rs` は session ごとに `WebviewWindowBuilder` を一回だけ構築する。build failure は page由来の文字列を返さず `WEBVIEW_UNAVAILABLE` へ写像する。

### 13.1 builder parameters

次の設定をそのまま適用する。

```rust
use tauri::{
    utils::config::{BackgroundThrottlingPolicy, WebviewUrl},
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    WebviewWindowBuilder,
};
```

```rust
WebviewWindowBuilder::new(
    app,
    worker_label,
    WebviewUrl::CustomProtocol(Url::parse("llm-fetch-internal://localhost/worker")?),
)
.visible(false)
.focused(false)
.focusable(false)
.decorations(false)
.resizable(false)
.minimizable(false)
.maximizable(false)
.closable(false)
.always_on_top(false)
.skip_taskbar(true)
.inner_size(config.viewport_width, config.viewport_height)
.incognito(true)
.devtools(false)
.zoom_hotkeys_enabled(false)
.general_autofill_enabled(false)
.background_throttling(BackgroundThrottlingPolicy::Disabled)
.proxy_url(proxy_url)
.initialization_script_for_all_frames(BOOTSTRAP_JS)
.on_navigation(navigation_handler)
.on_new_window(|_, _| NewWindowResponse::Deny)
.on_download(download_handler)
.on_page_load(page_load_handler)
.build()
```

`worker_label` は `llm-fetch-worker-{uuid_simple}` とする。host capability は worker label の wildcard を含めてはならない。

plugin は `llm-fetch-internal` custom protocol で script/subresource を持たない固定 HTML だけを返す。この内部 URL は build と成功後 cleanup にだけ許可し、consumer の `index.html` を worker へ読み込まない。active request がない状態の external navigation は拒否する。

worker作成時は内部URLの`PageLoadEvent::Finished`を`session_create_timeout_ms`の全体上限内で待つ。`eval_timeout_ms`は起動済みWebViewのJavaScript評価と成功後resetにだけ使い、cold-startの初期ページ待機には使わない。proxy起動、WebView build、初期ページ待機を含む全作成処理にはmanager側でも同じ`session_create_timeout_ms`を適用する。

custom protocol 文書では WebKit の全 frame initialization script が実行されないため、内部待機ページを hardening probe の根拠にしない。HTTP(S) target の `PageLoadEvent::Finished` 直後に probe 成立を待ち、DOM settle 後にも再検証する。初期化スクリプト自体は target document の document-start に注入される。

### 13.2 callbacks

callback は Tauri event-loop thread を block してはならない。

- `on_page_load`: `PageLoadPayload::url()` と `event()` を clone し、capacity 32 の共通 `tokio::mpsc<ControllerEvent>` へ `try_send` する。channel overflow は session fatal error にする。
- `on_navigation`: synchronous `NavigationGate::accept(&Url)` だけを実行する。許可時は `NavigationAccepted`、拒否時は redacted `NavigationViolation` を同じ channel へ `try_send` し、許可 boolean を返す。DNS lookup は行わない。
- `on_new_window`: 常に `Deny`。
- `on_download`: `DownloadEvent::Requested` で `false` を返す。完了 event は記録だけして `false` を返す。

callback 内で `Mutex` の長時間 lock、network I/O、`block_on`、page body の log を行わない。

### 13.3 navigation gate

`NavigationGate` は `Arc` 内に次を持つ。

```rust
pub struct NavigationGate {
    active_request: RwLock<Option<ActiveNavigation>>,
    generation: AtomicU64,
    event_tx: tokio::sync::mpsc::Sender<ControllerEvent>,
    controller_fatal: CancellationToken,
}

pub struct ActiveNavigation {
    request_id: String,
    host_policy: HostPolicy,
    allow_http: bool,
    accepted_navigations: u32,
    max_navigations: u32, // 8 固定
}

pub enum ControllerEvent {
    NavigationAccepted { generation: u64 },
    PageLoad { generation: u64, event: PageLoadEvent, url: Url },
    NavigationRejected { generation: u64, violation: NavigationViolation },
    Fatal { generation: u64, reason: ControllerFatal },
}

pub enum NavigationViolation {
    InactiveRequest,
    DisallowedScheme,
    UserInfo,
    NonStandardPort,
    HostPolicy,
    NavigationLimit,
}
```

この `RwLock` は synchronous callback から使うため `std::sync::RwLock` とし、critical section では in-memory field の読書きだけを行う。poison 時は navigation を拒否して session fatal error flag を立てる。

accept 条件:

1. plugin 固有 internal URL は active request がない場合と cleanup navigation の場合だけ許可する。
2. scheme は `https`、または config で許可された `http`。
3. userinfo がない。
4. explicit port がなく、effective port が 443/80。
5. normalized host が global/session host policy を満たす。
6. HTTP(S) top-level navigation を受け入れる前に `accepted_navigations < 8` である。許可後に一回 increment するため、最初の request URL と redirect/self-navigation を合わせて最大 8 回。initial/cleanup の internal URL は数えない。

`generation` は許可した HTTP(S) top-level navigation ごとに increment する。scheme/userinfo/port/host 違反は `UNSAFE_URL`、navigation count 超過は `NAVIGATION_UNSTABLE`、active request 外の external navigation と callback channel failure は session fatal `WEBVIEW_UNAVAILABLE` へ map する。manager は page-load 待機中に `ControllerEvent` も `select!` し、拒否を navigation timeout まで放置しない。

callback の `try_send` が `Full/Closed` の場合は、同じ channel へ fatal event を再送せず `controller_fatal.cancel()` を呼ぶ。manager は全 navigation/settle/extraction await でこの token も select し、`WEBVIEW_UNAVAILABLE` と session destroy に直結させる。

DNS/IP の安全性は async proxy 側で再検証する。`on_navigation` の判定だけで SSRF safe とみなさない。

## 14. `fetch` の正確な実行順序

`manager.fetch()` は次の順序を変えない。

1. request JSONをdeserializeし、unknown field、request ID、override、source metadataを検証・正規化する。
2. root tokenのchildとしてrequest `CancellationToken`を作り、`request_id`とともにregistryへ`Vacant` insertする。既存なら`DUPLICATE_REQUEST`。
3. request timeoutで以降の`fetch_inner`全体を包む。queue待機とone-shot session生成もこのtimeoutに含める。
4. reusableはsessionをlookupし、one-shotはglobal host policyでtarget URLとDNSを先に検証してから`session_slots.try_acquire_owned()`でslotを取る。満杯は`SESSION_CAPACITY`。
5. one-shotは`session_create_timeout_ms`内にloopback proxyとhidden WebViewを生成し、内部sessionとしてregistryへ入れる。
6. `Session::begin()`でclosed stateを再確認し、active useをRAIIでcountする。
7. session host policyでURLを再検証し、全DNS answerがpublicであることを確認する。
8. session operation mutexを即時取得できなければqueue slotを予約してcancellation-awareに待つ。続いてglobal operation permitも同じ一つのqueue reservationで待つ。両方取得後にreservationをdropする。
9. `NavigationGate::begin()`でactive requestとnavigation generationを初期化し、proxyへfresh `RequestGeneration`とrequest単位の送受信budgetをinstallする。
10. page-load eventとnavigation violationをsubscribeしてから`webview.navigate(validated_url)`を呼ぶ。
11. proxy cancellation、navigation violation、またはmain-frameのHTTP(S) `Started`→`Finished` pairのいずれかを待つ。navigation waitは`navigation_timeout_ms`、fetch全体はstep 3のtimeoutでboundedにする。
12. hardening probeが成立するまで`eval_timeout_ms`内で25msごとに検証する。
13. `WaitingForDom`へ進み、mutation revisionとpage-load eventを100ms以下の間隔で監視する。quiet到達または`settle_timeout_ms`で終了し、後者は`dom_settle_timeout`を記録する。
14. hardeningを再検証し、settle時のnavigation generationと`webview.url()`を記録する。
15. `Extracting`へ進み、bounded extraction evalを一回実行する。eval後のgenerationとWebView URLが記録値と一致し、payload `finalUrl`も同じでなければ`NAVIGATION_UNSTABLE`。
16. Rustでpayload byte数、closed schema、文字・node・candidate・segment上限、truncation reason、制御文字を再検証する。
17. `NavigationGate::prepare_reset(expected_generation)`で抽出後のnavigation raceがないことを確定してから、plugin内部URLへresetする。
18. navigation violationのlate eventとproxy snapshotをreset後にも確認する。policy violationは`UNSAFE_URL`、budget超過は`RESPONSE_TOO_LARGE`とし、page本文を成功扱いしない。
19. final URLをURL/DNS policyで再検証し、content type、empty content、bot challengeを判定する。
20. `Guarding`へ進み、title、visible text、request/final URL、source provider/query/snippet、hidden segmentsからsecurity findingとdecisionを生成する。
21. Rustのclockと固定provenanceを使い、常に`fetchMethod = tauri_webview`、`trust = untrusted`、`tainted = true`のresponseを組み立てる。
22. successならrequest generationのsocket/taskをcancel・joinしてproxyをinactiveへ戻す。one-shotまたはfatal errorならsessionをregistryから除去してWebView/proxyをcloseする。最後にrequest registryとRAII guardを解放する。

step 11 で `Finished` が来ても HTTP success を意味しない。Tauri API から HTTPS status を安定して取得できないため、status code を response contract に含めない。browser error page や空 page は quality check で判定する。

fetch全体は一つの`tokio::time::timeout`でboundedにし、navigation、settle、eval、session creationはさらに短いstage timeoutを持つ。cancellation-awareなwaitではrequest/root cancellationを同じ`tokio::select!`へ入れる。proxy policy cancellationを監視する外側のselectは`biased`とし、同着時に成功payloadよりpolicy violationを優先する。

success時のproxy request cleanupはsocket/taskのjoin完了を待ってからresponseを返す。timeout/cancel/typed fatal errorではtoken cancellationとsession invalidationを行い、`Session`、`Worker`、`ProxyRequest`のRAII `Drop`も二重のclose保証として働く。resetまたは必須cleanupが成功しなければresponseを返さずtyped fatal errorとしてsessionを破棄する。

## 15. DOM settle algorithm

Promise を `eval_with_callback` に返して待たせない。callback API が Promise を await する保証はないため、Rust が同期 probe を反復する。

### 15.1 bootstrap state

`assets/bootstrap.js` はHTTP(S) targetのdocument startで全frameに入り、Section 18のhardeningとextractorが使うprimordial captureを適用する。main frameでは`documentElement`を監視する`MutationObserver`を直ちに設置し、WebKitの`readyState = uninitialized`等でrootがまだ無い場合は`DOMContentLoaded`で再試行する。

```javascript
(() => {
  "use strict";
  // 実装ではpage codeより前にbuilt-in getter/methodをcaptureし、
  // browser API hardeningを全frameへ適用する。
  let revision = 0;
  let observer = null;
  const observe = () => {
    const root = capturedDocumentElementGetter();
    if (!root) return false;
    observer = new CapturedMutationObserver(() => { revision += 1; });
    observer.observe(root, { subtree: true, childList: true,
      attributes: true, characterData: true });
    return true;
  };
  if (!observe()) capturedAddEventListener(document, "DOMContentLoaded", observe, { once: true });
  const bootstrap = Object.freeze({
    hardeningComplete,
    mutationState: () => Object.freeze({
      revision,
      lastMutation,
      observerActive: observer !== null,
    }),
    // extractor用のcapture済みhelper
  });
  Object.defineProperty(globalThis, "__LLM_FETCH_BOOTSTRAP__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: bootstrap,
  });
})();
```

extractorが使うhelperはfrozen bootstrap objectへ置き、pageによるprototype差し替え後もcapture済み`Reflect.apply`で呼ぶ。必須captureは次の範囲である。

- `Object.defineProperty`、`Object.freeze`、`Object.getPrototypeOf`
- `Reflect.apply`
- 使用する`Array`、`String`、`Date.now`、`EventTarget.addEventListener` method
- `MutationObserver`、`Promise.reject`、`DOMException`
- `Document.prototype.documentElement`、`Node`/`Element`/`Attr`の必要getter
- `Element.prototype.getAttribute`、`hasAttribute`
- `HTMLTemplateElement.prototype.content` getter。template security segment の走査だけに使う
- `window.getComputedStyle`
- `CSSStyleDeclaration.prototype.getPropertyValue`
- `JSON.stringify`
- `TextEncoder` instanceのbound `encode`

hardeningは対象propertyを`configurable: false`、`writable: false`で定義できた場合だけ成功とし、descriptorを再読して検証する。main frameのhardening probeは全block対象、`observerActive`、bootstrap/extractor entry pointが成立した場合だけ成功する。

### 15.2 Rust settle loop

mutation probe resultは次のclosed typed payloadとしてvalidationする。browser API hardeningは別の`HardeningProbe`で各booleanを検証する。

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationState {
    pub revision: u64,
    pub last_mutation: u64,
}
```

- poll interval: 100 ms 固定
- 同じ `revision` が `settle_quiet_ms` 続けば settle 完了。
- `settle_timeout_ms` 到達時は現在 DOM の抽出へ進み、`dom_settle_timeout` を truncation/limitation に追加する。
- 各probe callbackは`min(eval_timeout_ms, 500ms)`内に来なければtyped timeout/errorにする。
- page-load eventを受けた場合もquiet timerをresetする。
- settle前後のhardening probe、navigation generation、`webview.url()`、extraction payload `finalUrl`の組み合わせでdocument/navigation raceを拒否する。

`eval_with_callback`へPromiseは返さない。同期objectまたは`null`だけを返し、callback byte cap適用後にRustでclosed schemaへdeserializeする。

```javascript
globalThis.__LLM_FETCH_BOOTSTRAP__?.mutationState?.() ?? null
```

## 16. DOM extraction bridge

### 16.1 採用方式

DOM 回収には `WebviewWindow::eval_with_callback` だけを使う。

```rust
let config_json = serde_json::to_string(&extraction_config)?;
let script = format!(
    "globalThis.__LLM_FETCH_EXTRACT__?.({config_json}) ?? null"
);
let (tx, rx) = tokio::sync::oneshot::channel();
webview.eval_with_callback(script, move |serialized_json| {
    let _ = tx.send(serialized_json);
})?;
let serialized_json = timeout(eval_timeout, rx).await??;
```

`ExtractionConfig` は次の field だけを持つ。すべて validation 済みの整数であり、URL、page text、host input を JavaScript source へ連結しない。

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionConfig {
    max_characters: usize,
    max_payload_bytes: usize,
    max_dom_nodes: usize,
    max_dom_depth: usize,
    max_candidates: usize,
    max_segments: usize,
    max_segment_characters: usize,
}
```

Tauri/WRYはevaluation resultをJSON stringとしてcallbackへ渡すため、document-startでinstall済みの`extractor.js`はplain objectを返し、Rustは`serde_json::from_str::<PageSnapshot>()`を一回だけ行う。JavaScript側で巨大JSON stringを二重encodeしない。

### 16.2 採用しない方式

- remote capability / remote Tauri IPC
- `dangerousRemoteDomainIpcAccess`
- Tauri event を外部 page から emit
- custom URI scheme への payload navigation
- localhost HTTP result server
- `window.name`、document title、URL fragment での payload 搬送
- Promise を直接 `eval_with_callback` に返す方式

worker WebView には command capability が不要であり、外部 page は backend method を一つも呼べない。

### 16.3 extraction envelope

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSnapshot {
    pub title: String,
    pub text: String,
    pub final_url: String,
    pub node_count: u32,
    pub candidate_count: u32,
    pub content_type: String,
    pub language: Option<String>,
    pub truncated: bool,
    pub truncation_reasons: Vec<TruncationReason>,
    pub security_segments: Vec<RawSecuritySegment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawSecuritySegment {
    pub location: SecurityFindingLocation,
    pub text: String,
    pub truncated: bool,
    pub original_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TruncationReason {
    DomNodeLimit,
    DomDepthLimit,
    CandidateLimit,
    TextLimit,
    SegmentLimit,
    SegmentTextLimit,
    DomSettleTimeout,
    NetworkBudgetExhausted,
    SecurityCharacterLimit,
    FindingLimit,
}
```

Rust は次を再検証する。

- callback string byte length `<= max_payload_bytes`
- `finalUrl`が`webview.url()`と完全一致し、UTF-8 bytes `<= 2,048`
- title `<= 1,000`、content type `<= 64`、language `<= 64`、text `<= max_characters`
- segment数`<= max_segments`、segment text `<= max_segment_characters`、locationがhidden/comment/attribute/meta/templateのいずれか
- `nodeCount <= max_dom_nodes`、`candidateCount <= max_candidates`
- segmentの`originalLength >= text length`であり、`truncated`との大小関係が整合する
- `truncated == !truncation_reasons.is_empty()`
- string 中の NUL、LF/TAB/CR 以外の C0、C1 control は reject する。bidi/invisible format character は response schema 上は許容するが Section 23 の scan variant では除去する
- truncation reason は enum として deserialize し、未知値なら payload 全体を拒否する。`DomSettleTimeout`、`NetworkBudgetExhausted`、`SecurityCharacterLimit`、`FindingLimit` は Rust だけが追加し、JavaScript から受け取った場合は拒否する

`assets/extractor.js`はpayloadを返す直前に、bootstrapがcaptureした`JSON.stringify`とbound `TextEncoder.encode`でserialized byte lengthを測る。`max_payload_bytes`を超える場合は、(1)末尾のsecurity segment、(2)visible textの順でcode point境界を保って削減し、`segment_limit` / `text_limit`を付ける。callback boundaryではRustが受信直後、deserialize前に同じbyte上限を再確認し、超過時は`RESPONSE_TOO_LARGE`としてsessionを破棄する。

JavaScript が返せる `RawSecuritySegment.location` は `hidden`、`comment`、`attribute`、`meta`、`template` だけであり、`visible` は拒否する。Rust `security.rs` は visible payload とこれらの追加 segment を順に検査する。

visible scan文字列はtitle、本文、request/final URL、source provider/query/snippetを改行で連結する。続いてJavaScriptのhidden/comment/attribute/meta/template segmentをDOM orderで検査する。rankは数値provenanceでありscan文字列へ含めない。

Rust が `segment_hash` を SHA-256 で計算する。JavaScript から hash、trust、decision、severity を受け取らない。

public `RetrievedDocument.character_count`は実際に返す`text.chars().count()`とする。excerptはRustが返却textの先頭240 code pointsから生成する。

payload error mappingは固定する。受信byte超過は`RESPONSE_TOO_LARGE`、generation/final URL mismatchは`NAVIGATION_UNSTABLE`、unsupported content typeは`UNSUPPORTED_CONTENT_TYPE`、それ以外のschema/invariant違反は`EVALUATION_FAILED`。これらのfatal errorではreusable sessionを再利用せず破棄する。

## 17. Extraction quality reference

0.1.0のas-built extractorは、capture済みhelperだけを使う単一のiterative DOM walkで、visible textとhidden/comment/meta/template/selected attribute segmentを同時にbounded収集する。候補数はvisible text node数としてcountし、全文書から最大`max_characters`を返す。scriptはdocument startで`globalThis.__LLM_FETCH_EXTRACT__`へnon-configurable/non-writableにinstallし、外部module、dynamic import、npm bundleを使わない。

以下の二pass candidate scoringはTypeScript版から参照した品質改善案であり、0.1.0のpublic contract、release gate、実装済み機能ではない。導入する場合は抽出結果とsecurity segmentの回帰fixtureを追加する別変更として扱い、既存実装から暗黙に推測しない。

処理順:

1. `window.__LLM_FETCH_RUNTIME__` と必要な primordial helper がない場合は `ProbeUnavailable` error envelope。
2. `document.documentElement` がない場合は `DomUnavailable` error envelope。
3. recursion を使わない enter/exit frame の iterative stack で一回目の DOM walk を行う。`max_dom_nodes`、`max_dom_depth` を超える直前に停止して truncation reason を追加する。
4. `script`、`style`、`noscript`、`template`、`iframe`、`object`、`embed`、`svg`、`canvas`、`video`、`audio` を visible text から除外する。
5. captured `getComputedStyle` の `display:none`、`visibility:hidden|collapse`、`opacity:0` と `hidden` / `aria-hidden=true` を hidden 扱いにし、子へ hidden flag を継承する。computed style exception はその subtree を hidden として fail closed に扱う。
6. walk 中に `article`、`main`、`[role=main]`、`#content`、`.content`、`.main`、`body` に一致する element を重複なしで最大 `max_candidates` 件登録する。candidate は selector priority と DOM order を保持する。
7. candidate ごとに normalized Unicode code point 数、link text code point 数、visible content を持つ block 数だけを counter として計算し、この pass では本文文字列を保持しない。block は `blockquote,h1,h2,h3,h4,li,p,pre,td` とし、score 式の `paragraph_count` にはこの数を使う。各 text node は body candidate と内側から最大 15 件、合計最大 16 件の active candidate にだけ加算する。candidate nesting が 16 を超えた場合は `candidate_limit` を付ける。
8. score が最大の candidate を選ぶ。同 score は selector priority、次に DOM order が小さい方を選ぶ。候補がなければ `body`、body もなければ `CONTENT_INSUFFICIENT`。
9. 選択 candidate subtree だけを同じ node/depth/visibility rule で二回目に walk し、block 境界で改行、連続 whitespace を normalize しながら visible text を `max_characters` まで保持する。総文字数 counter は保持上限後も node limit 内で加算し、超過時に `text_limit` を付ける。
10. comment、meta content、template、最外側 hidden root の element text、`alt`、`title`、`aria-label`、`data-*` を一回目の walk で security segment として別収集する。nested hidden root は親 segment に含めて重複収集しない。element/template text は `textContent/innerText` を一括取得せず、同じ stack 上の bounded head buffer + tail ring buffer へ流す。
11. 同じ walk で `ChallengeSignals` を boolean OR だけで収集する。frame は `iframe` の `src/title/id/class` に `captcha|challenge|turnstile`、reCAPTCHA/hCaptcha marker は element の `id/class/src` に `g-recaptcha|recaptcha|h-captcha|hcaptcha` を case-insensitive substring match する。form/input は tag name の存在だけを見る。
12. segment text が `max_segment_characters` を超える場合は先頭 `ceil(max/2)` と末尾 `floor(max/2)` code points を連結して `truncated=true`、`segment_text_limit` とする。件数は `max_segments` で切る。一つの element の `data-*` は attribute name の DOM order で処理し、全体 cap を共有する。
13. title は最初の non-empty `meta[property="og:title"]` content、`document.title`、最初の visible `h1`、final URL hostname の順で選び、1,000 characters に切る。language は `document.documentElement.lang` を 64 characters に切る。どちらも inline whitespace normalization を行う。
14. excerpt は返却する visible text の先頭 240 code points とし、text が空の場合だけ `None`。本文とは別の body text を連結しない。
15. tag name は 64 characters、attribute name は 128 characters に制限する。
16. Section 16.3 の serialized byte budget を適用する。
17. closed Shadow DOM は対象外、open Shadow DOM も初版では走査しない。limitation に明記する。

DOM/API は page と同じ JavaScript world にある。document start で built-in を capture して monkey patch の影響を減らすが、isolated world と同等の保証はしない。結果が未信頼である理由として `security.limitations` に含める。

candidate score は TypeScript reference と同じ式を使う。

```text
min(character_count, 20_000)
+ min(paragraph_count, 20) * 120
- round(link_density * min(character_count, 10_000))
```

`link_density = min(1, link_text_length / character_count)`。同 score の場合は selector order が先、DOM order が先の候補を選ぶ。bot challenge 判定後、HTML/XHTML の normalized text が 80 characters 未満、または plain text が 20 characters 未満なら `CONTENT_INSUFFICIENT`。

対応 `document.contentType` は `text/html`、`application/xhtml+xml`、`text/plain` の三つだけとする。それ以外は `UNSUPPORTED_CONTENT_TYPE`。`text/plain` も body subtree の text node を iterative walk で直接収集し、unbounded `innerText/textContent` getter は呼ばない。candidate scoring だけを省略する。

bot challenge は normalized visible text が 5,000 characters 以下で、次のいずれかを満たす場合だけ `BOT_CHALLENGE` とする。通常記事内の単語だけで誤判定しない。

- `(has_captcha_or_challenge_frame || has_recaptcha_marker || has_hcaptcha_marker || (has_form && has_input))` かつ body が `captcha` / `verify you are human` のいずれかを含む
- title が `Just a moment...` / `Attention Required` で、body に `checking your browser` / `security check` を含む
- body に `unusual traffic from your computer network` を含む

challenge marker と phrase の組み合わせは fixture 化し、provider 固有 selector を core rule へ増やさない。

## 18. Browser API hardening

`bootstrap.js` は全 frame の document start で次を無効化する。property が configurable な場合は `undefined` を non-configurable/non-writable で定義し、失敗しても exception を page へ投げず内部 flag に記録する。

- `RTCPeerConnection`
- `webkitRTCPeerConnection`
- `WebTransport`
- `WebSocket`
- `EventSource`
- `Worker`
- `SharedWorker`
- `window.open`
- `navigator.sendBeacon`
- `navigator.mediaDevices.getUserMedia`
- `navigator.mediaDevices.getDisplayMedia`
- `navigator.geolocation.getCurrentPosition`
- `navigator.geolocation.watchPosition`
- `navigator.serviceWorker.register`
- `navigator.clipboard.read/readText/write/writeText`
- `navigator.credentials.create/get/store/preventSilentAccess`
- `navigator.usb.requestDevice`
- `navigator.serial.requestPort`
- `navigator.hid.requestDevice`
- `navigator.bluetooth.requestDevice`
- `window.showOpenFilePicker/showSaveFilePicker/showDirectoryPicker`
- `window.alert/confirm/prompt/print`
- `Notification.requestPermission`
- `navigator.share`
- document start ごとの `window.name = ""`

global constructor/function は `window`、nested method は実体の prototype に `Object.defineProperty` する。`Object.defineProperty`、`Object.getPrototypeOf`、`Object.freeze` と各 DOM accessor は bootstrap の最初に local binding へ capture する。denied async API は `Promise.reject(new DOMException("Blocked by llm-fetch", "NotAllowedError"))`、dialog は `alert/print => undefined`、`confirm => false`、`prompt => null` を返す。

bootstrapはhardeningの総合成否とDOM mutation revisionをclosure内に保持し、non-configurableな`globalThis.__LLM_FETCH_BOOTSTRAP__`のfrozen helper/probeだけを公開する。Rustの`HardeningProbe`は存在する対象APIがblock済みであること、mutation observerがactiveであること、bootstrap/extractor entry pointが残っていることをfetchごとに検証する。一つでも成立しなければ`EVALUATION_FAILED`としてsessionを破棄する。元からAPIが存在しない場合はfailureではない。

`fetch` と `XMLHttpRequest` は dynamic page に必要なため無効化しない。これらの HTTP(S) traffic は proxy を通す。

Phase 0 では、main frame と cross-origin iframe の最初の page script から上記 API が利用できないことを fixture で確認する。無効化に失敗する API が private network/proxy bypass を可能にする場合は正式リリースを止める。

main frame の hardening failure は probe で fetch ごとに検知できるが、same-origin policy のため cross-origin frame 内の failure を main frame から read back しない。cross-frame 成立性は fixed WebKit/runtime version の release fixture で保証し、個別 navigation 中の検知保証がないことを `SecurityResult.limitations` と SECURITY に明記する。frame からの `postMessage` は page が偽造できるため failure bridge に使わない。

## 19. Egress proxy

### 19.1 Tauri/WRY 制約

Tauri `proxy_url` / WRY `ProxyConfig` は proxy host と port だけを受け取り、username/password を指定する API を持たない。したがって認証付き proxy は仕様に含めない。

proxy は次の境界で運用する。

- `TcpListener::bind((Ipv4Addr::LOCALHOST, 0))`
- OS が割り当てた random ephemeral port
- session ごとに一つ
- WebView build 直前に開始し、session close 直後に停止
- public 80/443 宛て以外を拒否
- 厳格な connection/byte/time budget
- session の `HostPolicy` を top-level、redirect、plain HTTP request、HTTPS CONNECT authority のすべてへ適用

同一 user の別 local process が ephemeral port を発見して proxy を使う脅威は完全には防げない。ただし proxy は private network、non-standard port、unbounded transfer を許可しない。local malware からの防御は threat model 外として `SECURITY.md` に記載する。

### 19.2 HTTP proxy server

`network/proxy.rs` は `tokio::net::TcpListener` と Hyper HTTP/1 server connection を使う。

```rust
hyper::server::conn::http1::Builder::new()
    .max_headers(100)
    .max_buf_size(64 * 1024)
    .serve_connection(TokioIo::new(stream), service_fn(handler))
    .with_upgrades()
```

accepted connection ごとに semaphore permit を必要とし、`max_connections` 超過は connection close とする。

handler 共通で request target `<= 2,048 bytes`、header count `<= 100`、name+value 合計 `<= 64 KiB`、single value `<= 16 KiB` を再検証する。`Connection` header が列挙する header に加え、`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`proxy-connection`、`te`、`trailer`、`transfer-encoding`、`upgrade` を hop-by-hop として転送しない。ただし CONNECT upgrade 自体は内部処理する。

`ProxyHandle` は capacity 32 の `mpsc<ProxyEvent>` receiver を manager へ渡す。proxy は DNS failure と upstream connect/handshake failure を `TargetFailure { request_generation, normalized_host, code }` として `try_send` する。manager は current request generation の `Navigating` stage だけこの event を select し、event host が `NavigationGate` の最新 top-level host と一致すれば `DNS_FAILURE` / `PROXY_FAILURE` を直ちに返す。不一致の subresource failure は browser に local 502 を返すだけで document 全体を失敗させない。channel overflow/closed は controller fatal と同じく `WEBVIEW_UNAVAILABLE` + session destroy とする。host は in-process comparison 専用で log/response に含めない。

handler の response body type は全 branch で `http_body_util::combinators::BoxBody<Bytes, ProxyBodyError>` に統一する。small local error response は `Full<Bytes>` を `map_err` + `boxed`、upstream response は `BudgetBody<Incoming>` を `boxed` する。upstream HTTP/1 は validated `TcpStream` に対する `hyper::client::conn::http1::handshake(TokioIo::new(stream))` で接続する。

HTTP client handshake が返す connection future は `request_generation` の task set に即時 spawn し、同じ generation cancellation token と cleanup join の対象にする。sender の `send_request` だけを await して connection future を捨ててはならない。`BudgetBody<B>` の `poll_frame` は `pin-project-lite` で inner body を projection し、`Unpin` を仮定しない。

### 19.3 plain HTTP request

1. absolute-form URI を parse する。
2. method が GET/HEAD 以外なら 405。
3. body、`Transfer-Encoding`、non-zero `Content-Length` があれば 400。
4. Section 20 の URL/DNS policy を適用する。
5. validation 済み IP と port 80 に直接 `TcpStream::connect` する。
6. upstream URI を origin-form path/query に書き換える。
7. hop-by-hop と proxy header を除去し、`Host` を normalized authority、upstream `Connection` を `close` にする。
8. response も hop-by-hop header を除去し、header count 100、total 64 KiB、single value 16 KiB を超えたら 502。
9. response body は `BudgetBody` で streaming し、per-response/request budget を超えた時点で connection を閉じる。

### 19.4 HTTPS CONNECT

1. authority に userinfo、path、query、fragment がないことを確認する。
2. effective port が 443 であることを確認する。
3. request body、`Transfer-Encoding`、non-zero `Content-Length` があれば 400。
4. hostname を resolve/validate する。
5. validation 済み `SocketAddr` に直接接続し、DNS name で再接続しない。
6. `200 Connection Established` を返し、Hyper upgrade 後に双方向 copy する。
7. browser->upstream と upstream->browser を別 budget で count する。
8. per-tunnel/request budget、connect timeout、request/`request_generation` cancellation のいずれかで両 socket を shutdown する。

TLS は MITM しない。SNI/certificate validation は WebView が通常どおり行う。CONNECT 内の HTTP method、status、content type、個別 resource は plugin から見えない。

HTTPS tunnel 内の HTTP/2 origin coalescing、Alt-Svc、HTTP/3/QUIC は proxy 外から authority を再検査できない。Phase 0 では、同一 certificate/IP の allow host と deny host を用意し、deny host request が既存 tunnel に coalesce されないこと、Alt-Svc/QUIC が loopback proxy を迂回しないことを packet/socket fixture で確認する。いずれかが再現した場合は reusable session の host boundary を保証できないため No-Go とし、出荷しない。

したがって top-level API が GET でも、page script は同じ session の Cookie を伴う POST 等を public host へ送れる。reusable session を高権限 account や相互に信頼しない origin 間で共有してはならない。この制約を README/SECURITY と `SecurityResult.limitations` に記載する。

### 19.5 BudgetBody と tunnel copy

`network/proxy.rs` の `RequestGeneration` は session lifetime ではなく fetch request lifetime で新規作成する。reusable session の二回目以降へ byte count や exhausted flag を持ち越さない。

```rust
pub struct NetworkBudget {
    received: AtomicU64,
    sent: AtomicU64,
    exhausted: AtomicBool,
    policy_cancel: CancellationToken,
    limits: NetworkLimits,
}
```

session lifetime の proxy は次の control plane を持つ。

```rust
pub struct ProxyControl {
    active: std::sync::RwLock<Option<ActiveBudget>>,
    next_request_generation: AtomicU64,
    next_connection_id: AtomicU64,
    connections: tokio::sync::Mutex<HashMap<u64, ConnectionControl>>,
}

#[derive(Clone)]
pub struct ActiveBudget {
    request_generation: u64,
    budget: Arc<NetworkBudget>,
    cancel: CancellationToken,
}

pub struct ConnectionControl {
    request_generation: u64,
    cancel: CancellationToken,
    join: tokio::task::JoinHandle<()>,
}
```

handler は `active.read()` 中に `ActiveBudget::clone()` だけを行い、`RwLock` guard を drop してから await する。proxy は active budget がない時の request/CONNECT を `503` で拒否して upstream socket を作らない。accepted connection と tunnel は monotonic connection ID と受付時 `request_generation` に紐付ける。task completion は自分の ID を map から remove し、cleanup は同じ `request_generation` の entry を drain、全 token を cancel、全 `JoinHandle` を最大 2 秒で await する。これにより前回 page の keep-alive/CONNECT が次回 fetch の budget や Cookie context で動き続けることを防ぐ。

増分は `fetch_update` で overflow-safe に加算し、上限を超える frame/chunk を転送しない。上限超過時は `exhausted = true`、request 全体を即座に cancel せず該当 connection を閉じる。active request 中に URL/host/DNS/IP/port/method/body policy を一件でも拒否した時は local error response を返すと同時に `policy_cancel.cancel()` する。manager は全 stage でこの token を select して `UNSAFE_URL` を返し、reusable session も destroy する。したがって policy violation を含む page を成功 document として返さない。proxy inactive 時の `503` と connection concurrency 超過は policy violation に含めず、内部 metric だけを増やす。

`BudgetBody<B>` は `http_body::Body` を実装し、`poll_frame` で data frame の byte length を per-response と request counter に加える。limit を超える frame は返さず `ProxyBodyError::BudgetExceeded`。trailers は header count/size rule を適用してから転送する。

CONNECT copy は `tokio::select!` で二方向、deadline、session cancellation を競合させる。`copy_bidirectional` を無制限に呼ばない。

## 20. URL、DNS、IP policy

`network/policy.rs` は pure function、`resolver.rs` は async I/O に分離する。

### 20.1 URL policy

- input と normalized serialized URL の UTF-8 byte length がともに 1..=2,048
- scheme は HTTPS、または明示許可された HTTP
- username/password 不可
- fragment は navigation 前に削除
- public/top-level URL は explicit port 不可。proxy request の effective port は HTTPS 443 / HTTP 80 だけ
- host 必須
- target URL の host は DNS name に限定し、IPv4/IPv6 literal は public address であっても拒否する
- `localhost`、`*.localhost`、`*.local`、`home.arpa`、`*.home.arpa` を拒否
- host policy を満たすこと

### 20.2 DNS resolution

`tokio::net::lookup_host((host, port))` 全体を `dns_timeout_ms` で囲み、全 address を取得して重複排除する。timeout、0 件、64 件超は `DNS_FAILURE`。一つでも Section 20.3 の blocked address が混在した場合は安全な address だけを選ばず resolution 全体を `UNSAFE_URL` で拒否する。全件が public の場合だけ resolver order を維持し、最初に接続成功した一つを pin する。IPv4 は常に優先しない。connect は sequential に行い、共通 deadline は `connect_timeout_ms`、各 address の試行は `min(500 ms, remaining)` とする。全 address failure/timeout は `PROXY_FAILURE`。

### 20.3 blocked address

IPv4/IPv6 の次を拒否する。

- unspecified
- loopback
- private/unique-local
- link-local
- multicast
- broadcast
- carrier-grade NAT
- benchmarking
- documentation ranges
- reserved/future-use
- IPv4-mapped IPv6 の blocked IPv4
- 6to4、Teredo、ORCHID 等、blocked IPv4/network への tunnel に使える range

range は `ipnet::IpNet` の定数 table と unit/proptest で管理する。OS の `is_global` のみへ依存しない。

初版の conservative deny table は次に固定する。より specific な allow exception は作らない。

```text
IPv4:
  0.0.0.0/8
  10.0.0.0/8
  100.64.0.0/10
  127.0.0.0/8
  169.254.0.0/16
  172.16.0.0/12
  192.0.0.0/24
  192.0.2.0/24
  192.88.99.0/24
  192.168.0.0/16
  198.18.0.0/15
  198.51.100.0/24
  203.0.113.0/24
  224.0.0.0/4
  240.0.0.0/4

IPv6:
  ::/128
  ::1/128
  ::/96
  ::ffff:0:0/96
  64:ff9b::/96
  64:ff9b:1::/48
  100::/64
  2001::/23
  2001:db8::/32
  2002::/16
  3fff::/20
  5f00::/16
  fc00::/7
  fe80::/10
  fec0::/10
  ff00::/8
```

IPv4 broadcast `255.255.255.255` は `240.0.0.0/4` に含まれる。IPv4-mapped/NAT64/6to4 は embedded address を部分的に許可せず range 全体を拒否する。IANA special-purpose registry 更新で table を変更する場合は security review、境界 fixture、minor release を必須とする。

DNS rebinding 対策として、validation 後の hostname を upstream API に渡さない。選んだ `SocketAddr` へ直接接続する。redirect/subresource は browser が新しい proxy request/CONNECT を出すため、毎回同じ検証を行う。

## 21. Session model

### 21.1 storage

初版の session はすべて `incognito(true)` である。

- one-shot session は fetch 後に破棄する。
- reusable session は app process 内だけ Cookie/storage を保持する。
- persistent data directory と `data_store_identifier` は使用しない。
- main UI WebView の browser data を import/export しない。
- Cookie を command/Rust public API から列挙しない。

session close 時は `destroy()` して handle を drop する。`clear_all_browsing_data()` は WebView/data-store 間の scope が platform 実装に依存し、別 incognito session の state を消す危険があるため呼ばない。session state の廃棄は unique incognito store が WebView destroy で破棄されることを Phase 0 isolation test で確認して成立条件とする。

`Session<R>` は `OwnedSemaphorePermit` の worker slot、`Arc<tokio::sync::Mutex<()>>` の operation gate、WebView handle、proxy handle、state、cancel token、last-used time を所有する。manager registry から削除する前に state を `Closing` にし、resource close 後に `Closed`、最後に slot permit を drop する。

one-shot にも内部 UUID を割り当てて manager registry に登録するが `exposed = false` とし、command response の `session_id` は `None`。reusable は `exposed = true` で `create_session` が UUID を返す。`active_sessions` は両方を数える。

### 21.2 state machine

```rust
pub enum SessionState {
    Creating,
    Idle,
    Running { request_id: String, stage: FetchStage },
    Closing,
    Failed { code: ErrorCode },
    Closed,
}

pub enum FetchStage {
    Queued,
    CreatingSession,
    Navigating,
    WaitingForDom,
    Extracting,
    Guarding,
    CleaningUp,
}
```

`Queued` と `CreatingSession` は request registry と `ErrorResponse.stage` では使用するが、まだ `Session` を取得していないため `SessionState::Running` には格納しない。

許可する遷移:

```text
Creating -> Idle
Creating -> Failed -> Closing -> Closed
Idle -> Running(Navigating)
Running -> Running(next stage)
Running -> Idle                      # reusable success + cleanup success
Running -> Failed -> Closing -> Closed
Idle -> Closing -> Closed
```

それ以外は internal invariant violation とし、session を destroy する。`Closed` から再利用しない。

### 21.3 cancellation/timeout

- plugin root、request、session の三層 `CancellationToken` を持つ。
- `cancel(request_id)` は request token だけを cancel する。
- `close_session` は session token を cancel し、active request が終わるまで最大 2 秒待ってから強制 destroy する。
- request timeout は request cancel と同じ cleanup path を通る。
- reusable session で成功後の internal URL reset が完了しなければ session を `Failed` にして registry から除く。timeout/cancel/policy violation は reset を試みず session ごと破棄する。
- one-shot session は error の種類に関係なく破棄する。

active fetch の request token、`close_session` による session token、plugin shutdown の root token はいずれも caller へ `CANCELLED` を返す。`SESSION_CLOSED` は fetch 開始時に既に `Closing/Closed` の session を指定した場合だけに使う。deadline branch だけが `TIMEOUT` を返し、cancel と timeout の同着は上記 select priority により `CANCELLED` とする。

### 21.4 idle reaper

plugin setup で 30 秒周期の task を `tauri::async_runtime::spawn` する。reusable session が `Idle` かつ `last_used + idle_timeout <= now` の場合に close する。`Running` session は idle close しない。

reaper は session operation mutex を `try_lock_owned()` し、取得できない session を skip する。取得後に state と deadline を再確認し、registry 上の同じ `Arc<Session>` を `HashMap::remove_entry` で除去できた場合だけ `Closing` へ進める。これにより fetch lookup/explicit close との TOCTOU で別 session を閉じない。

## 22. Queue と concurrency

`LlmFetchManager` は次を持つ。

```rust
pub struct LlmFetchManager<R: Runtime> {
    app: AppHandle<R>,
    config: Arc<ValidatedConfig>,
    sessions: RwLock<HashMap<Uuid, Arc<Session<R>>>>,
    requests: RwLock<HashMap<String, RequestControl>>,
    session_slots: Arc<Semaphore>,
    global_permits: Arc<Semaphore>,
    queued: AtomicUsize,
    root_cancel: CancellationToken,
    shutting_down: AtomicBool,
}
```

manager/session registry と request registry の `RwLock` は `tokio::sync::RwLock` を使う。Section 13 の synchronous `NavigationGate` だけが `std::sync::RwLock` を使う。

`session_slots` と `global_permits` はともに `max_sessions` permits で初期化するが、責務が異なる。

- `session_slots`: 存在できる worker WebView 数。`OwnedSemaphorePermit` を `Session` が close まで保持する。
- `global_permits`: 同時に進行できる fetch job 数。fetch 完了時に解放する。

`create_session` は `session_slots.try_acquire_owned()` を使い、満杯なら `SESSION_CAPACITY`。one-shot fetch も同じく wait せず `SESSION_CAPACITY` とする。`QUEUE_FULL` は operation mutex/global permit の待機予約数が `max_queue_depth` に達した場合だけに使う。idle reusable session が全 slot を占有した場合に one-shot fetch を無期限 queue しないためである。

`create_session` は global fetch permit と queue slot を使わず、proxy bind から WebView build 完了までを `session_create_timeout_ms` で囲む。timeout は `TIMEOUT` + stage `creating_session`。途中で失敗した listener、WebView、task、slot permit は partial-session RAII guard が必ず破棄し、registry には `Idle` になった session だけを公開する。

acquisition order を固定する。

1. request registry
2. reusable session operation mutex の即時取得。待つ場合だけ queue reservation
3. global semaphore の即時取得。待つ場合だけ queue reservation
4. one-shot の session slot、または reusable session が保持済みの slot
5. session state lock は短時間だけ

`QueuedGuard::reserve()` は `queued` に対する compare-exchange loop で `current < max_queue_depth` の場合だけ increment する。一つの request は operation mutex と global permit の両方を待っても queue slot を一つだけ持つ。guard の `Drop` が必ず decrement し、underflow は debug assertion と internal metric で検知する。

state lock を保持したまま WebView call、DNS、socket、eval callback、guard を await しない。RAII guard で registry/queue/permit をすべて error path から解放する。

## 23. Security guard

### 23.1 Rust processing order

1. JavaScript payload schema/limit validation
2. NFKC normalization、NUL/control character 除去、whitespace normalization
3. segment location/tag/attribute normalization
4. rule matching
5. duplicate finding merge
6. severity/confidence calculation
7. requested use と truncation を使う policy decision

初版 profile は TypeScript 既定と同じ `balanced` に固定し、config/request へ profile selector を公開しない。rule table は TypeScript `src/security/rules.ts` の十 rule について、category、base severity、reason、AND 条件の pattern group を同じ順序で Rust 定数へ転記する。Rust `RegexBuilder` は Unicode + case-insensitive で process ごとに `OnceLock` へ一回 compile し、user input から pattern を作らない。rule compile failure は setup error とする。

`security_normalize.rs` は TypeScript corpusで必要な NFKC、invisible control除去、letter spacing、escaped code point、percent sequence、Base64候補をbounded scan variantとして生成する。Base64候補は最大32件、各候補はregexにより最大2,048文字とし、UTF-8かつ全文字がprintableな場合だけ採用する。percent decodeは連続する `%HH` byte列をUTF-8へ復元できる場合だけ採用し、invalid UTF-8/candidateはerrorにせずそのvariantだけを捨てる。TypeScript側の仕様追加はcommitted conformance fixtureへcaseを追加してからRustへ反映する。

finding の生成も TypeScript と同じ式に固定する。

- hidden location は `hidden/comment/template/meta`、attribute は `attribute`。
- hidden は base severity を最低 high、attribute は最低 medium に上げる。
- balanced profile なので medium の一律 high 化はしない。
- hidden category は `hidden_instruction`、attribute category は `low_trust_attribute`、その他は rule category。
- confidence は 0.72 から開始し、hidden なら +0.20、hidden でなく attribute なら +0.10、benign なら -0.20、最後に 0.99 で上限を取る。
- visible segment が benign-context pattern と rule の両方に一致した場合、rule finding に加えて `benign_mention/info/0.7` を一件作る。
- `segment_hash` は normalized scan 対象ではなく bounded original segment text の SHA-256 lowercase hex 先頭 16 characters。
- dedupe key は `output_category:rule_category:segment_hash`。finding は segment order、normalization variant order、rule table order を維持し、最大128件。上限へ到達したら `FindingLimit` を追加して decision を fail closed に進める。

scan は最大 `max_segments` 件、合計 `max_security_characters` code points。segment 数が上限を超える場合は前半 `ceil(max/2)` と後半 `floor(max/2)` を選ぶ。残り character budget は残り segment 数で均等配分し、segment が share を超える時は先頭 `ceil(share/2)` と末尾 `floor(share/2)` を連結して検査する。segment/character/finding を切った場合はそれぞれ `SegmentLimit` / `SecurityCharacterLimit` / `FindingLimit` を一度だけ追加し、policy の `truncated = true` とする。

### 23.2 decisions

`GuardDecision` は次の四値を維持する。

- `allow`
- `allow_with_warning`
- `require_approval`
- `deny`

policy の優先順位:

ここで hidden-like location は `hidden`、`comment`、`attribute`、`meta`、`template` の五つ、tool chain use は `search_more` と `call_readonly_tool` の二つを指す。`benign_mention` は strongest severity と hidden-like 判定から除外する。

1. truncation があり、requested use が `search_more` / `call_readonly_tool` なら `deny`。
2. truncation があれば `require_approval`。
3. high/critical finding があり tool chain use なら `deny`。
4. high/critical、または hidden location の medium 以上なら `require_approval`。
5. low 以上なら `allow_with_warning`。
6. finding がなければ `allow`。ただし untrusted のまま。

decision reason は該当した最初の branch に対応する次の一文だけを返す。

| branch | `SecurityResult.reasons[0]` |
|---|---|
| truncated + tool chain | `Truncated inspection cannot authorize another tool action.` |
| truncated | `Inspection limits were reached before all untrusted content was examined.` |
| high/critical + tool chain | `High-severity untrusted content cannot initiate another tool action.` |
| high/critical or hidden medium+ | `High-severity or hidden instructions require explicit approval.` |
| low+ | `Potential instructions were found in untrusted content.` |
| no relevant finding | `No known injection pattern was detected; content remains untrusted.` |

guard decision が `deny` でも fetch 自体は成功 response とし、`RetrievedDocument.security.decision = deny` と本文/findings を返す。plugin command が本文を隠すと caller が finding を監査できないためである。初版の `ErrorCode` に `GUARD_DENIED` は定義しない。

### 23.3 fixed limitations

`SecurityResult.limitations` の base entries は次の英語文字列をこの順序で常に入れる。

1. `No finding is not proof of safety.`
2. `Extraction runs in the same JavaScript world as the untrusted page.`
3. `Open and closed shadow roots are not inspected.`
4. `Iframe document bodies are not inspected.`
5. `Cross-origin frame hardening failures are covered by release tests, not per-fetch readback.`
6. `HTTPS tunnel methods, bodies, status codes, and coalesced authorities are not inspected.`
7. `Heuristic rules cannot detect every semantic prompt injection.`
8. `Page JavaScript CPU and WebView memory cannot be metered precisely by the plugin.`

reusable session の response だけ `A reusable session retains in-process cookies and storage for its allowed origins.`、`allow_http = true` の response だけ `Plain HTTP does not provide transport confidentiality.` を続ける。その後、`diagnostics.truncation_reasons` の順に `DOM node limit reached.`、`DOM depth limit reached.`、`Content candidate limit reached.`、`Returned text limit reached.`、`Security segment limit reached.`、`Per-segment text limit reached.`、`DOM settling timed out.`、`Network byte budget was exhausted.`、`Security character inspection limit reached.`、`Security finding limit reached.` の対応文字列を重複なしで追加する。その他の自由文を追加しない。

## 24. Permissions と Tauri capability

### 24.1 plugin permission set

`permissions/default.toml`:

```toml
[default]
description = "Allows status, ephemeral session management, background fetch, and cancellation."
permissions = [
  "allow-status",
  "allow-create-session",
  "allow-fetch",
  "allow-cancel",
  "allow-close-session",
]
```

command を追加・rename した場合は、同じ変更で次の四箇所を更新する。

1. command function
2. `tauri::generate_handler![]`
3. `build.rs` の `COMMANDS`
4. `permissions/default.toml`

### 24.2 example capability

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main",
  "description": "Local main window capability",
  "local": true,
  "windows": ["main"],
  "permissions": ["core:default", "llm-fetch:default"]
}
```

`remote` を書かない。`windows: ["*"]`、`webviews: ["*"]` を使わない。worker label は capability に含めない。

### 24.3 plugin initialization

```rust
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    AppHandle, Runtime,
};

#[derive(Default)]
pub struct Builder {
    config_override: Option<Config>,
}

impl Builder {
    pub fn config(mut self, config: Config) -> Self {
        self.config_override = Some(config);
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Option<Config>> {
        let config_override = self.config_override;

        PluginBuilder::<R, Option<Config>>::new("llm-fetch")
            .setup(move |app, api| {
                let config = config_override
                    .clone()
                    .or_else(|| api.config().clone())
                    .unwrap_or_default();
                setup(app, config)
            })
            .invoke_handler(tauri::generate_handler![
                commands::status,
                commands::create_session,
                commands::fetch,
                commands::cancel,
                commands::close_session,
            ])
            .on_event(lifecycle::on_event)
            .on_drop(lifecycle::on_drop)
            .build()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> {
    Builder::default().build()
}
```

`setup<R: Runtime>(app: &AppHandle<R>, config: Config) -> Result<(), Box<dyn std::error::Error>>` は config validation、platform support report の生成、`LlmFetch<R>` の `app.manage()`、idle reaper 起動までを行う。Rust `Builder::config` と Tauri config が二重指定された場合は上記コードどおり Rust 側を丸ごと優先し、field 単位 merge はしない。unsupported/best-effort platform でも `status` のため setup は成功させ、session 作成時に typed error を返す。setup を失敗させるのは invalid config または managed state 初期化失敗だけとする。

`lifecycle::on_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent)` と `lifecycle::on_drop<R: Runtime>(app: AppHandle<R>)` は Tauri 2.11.5 の callback signature に合わせる。`on_drop` は async await せず root cancellation と handle drop だけを行い、graceful drain は Section 26 の `shutdown().await` に限定する。

`PluginBuilder` には `global_api_script_path` を設定しない。plugin initialization script も使わず、worker ごとの `WebviewWindowBuilder::initialization_script_for_all_frames` だけを使う。

`Builder::build()` の handler/lifecycle は上記から分離せず、command 一覧の変更時は Section 24.1 の四箇所を同時更新する。

## 25. Platform support

### 25.1 macOS

- 正式対象は macOS 14+。
- Tauri Cargo feature `macos-proxy` を有効にする。
- `BackgroundThrottlingPolicy::Disabled` を使う。
- runtime OS version は safe API の `sysinfo::System::os_version()` で取得し、先頭の numeric major component が 14 以上か確認する。`None`、non-numeric、14 未満は `overall = unsupported` とする。
- consuming app の deployment target は 14.0 以上を README に必須条件として記載する。
- 10 分 hidden test、proxy bypass test、incognito isolation test を release gate にする。

### 25.2 Windows/Linux

crate は compile 可能にするが Preview とする。

- background throttling disable は Tauri/WRY で非対応のため `background_execution = best_effort`。
- `require_reliable_background = true` の既定では `create_session/fetch` を `BACKGROUND_UNSUPPORTED` で拒否する。
- host が明示的に `false` にした場合だけ短時間 fetch を許可する。
- proxy enforcement と hidden rendering の integration test が継続して通るまで正式対象にしない。
- 別 browser への fallback で正式対応扱いにしない。

### 25.3 mobile/macOS 13 以下

`overall = unsupported`。setup 自体は `status` を返せるよう成功させてもよいが、session 作成と fetch は `UNSUPPORTED_PLATFORM`。mobile module、Swift/Kotlin project は作らない。

## 26. App lifecycle

background fetch は Tauri process の寿命内だけ動く。

- main window を閉じても続行したい場合、host app が close request を prevent して window を hide する。
- tray、dock、終了 UI は plugin が変更しない。
- plugin `.on_event` で `RunEvent::Exit` を受けたら `root_cancel.cancel()` と `shutdown_now()` を呼ぶ。
- exit callback では async drain を保証できないため、proxy listener/socket の Drop が即時 close できる構造にする。
- normal command/Rust API から使う `shutdown().await` を public にし、host が graceful exit 前に最大 2 秒 drain できるようにする。ただし frontend command には公開しない。

main window の hide は worker WebView の visible state を変えない。worker は最初から hidden のままにする。

## 27. File-by-file implementation specification

以下はレビュー後の as-built 構成である。計画時に想定した小さな module は、責務の境界を保ったまま `proxy.rs`、`webview.rs`、`security.rs` へ統合した。production source はすべて800行未満とし、大きいtest suiteは各 module の `tests.rs` へ分離する。以後の実装者はこの表に存在しない旧想定パスを新設しない。

| order | file | action | responsibility / completion test |
|---:|---|---|---|
| 1 | `/Cargo.toml` | add | workspace、shared package/lints。`cargo metadata` success |
| 2 | `/crates/tauri-plugin-llm-fetch/Cargo.toml` | add | Section 8 の crate metadata/dependencies。Node 関連 dependency なし |
| 3 | `/crates/tauri-plugin-llm-fetch/build.rs` | add | 5 commands の permission generation |
| 4 | `/crates/tauri-plugin-llm-fetch/src/contracts.rs` | add | Section 9 の serde public types と unit tests |
| 5 | `/crates/tauri-plugin-llm-fetch/src/errors.rs` | add | internal error、public error mapping、redaction |
| 6 | `/crates/tauri-plugin-llm-fetch/src/config.rs` | add | defaults、range/cross-field/host-pattern validation |
| 7 | `/crates/tauri-plugin-llm-fetch/src/platform.rs` | add | support matrix、macOS runtime version、typed reasons |
| 8 | `/crates/tauri-plugin-llm-fetch/src/network/policy.rs` | add | URL/host/IP policy、DNS lookup、public-address validation |
| 9 | `/crates/tauri-plugin-llm-fetch/src/network/proxy.rs` | add | request generation、budget、DNS pinning、HTTP/CONNECT、listener/task cleanup |
| 10 | `/crates/tauri-plugin-llm-fetch/src/network/proxy/tests.rs` | add | inactive generation、host policy、header/connection/budget tests |
| 11 | `/crates/tauri-plugin-llm-fetch/assets/bootstrap.js` | add | hardening、mutation probe。self-contained static script |
| 12 | `/crates/tauri-plugin-llm-fetch/assets/extractor.js` | add | bounded synchronous DOM extraction function |
| 13 | `/crates/tauri-plugin-llm-fetch/src/webview.rs` | add | builder、NavigationGate、load/settle/eval/extract/reset/destroy |
| 14 | `/crates/tauri-plugin-llm-fetch/src/webview/types.rs` | add | bounded eval payload と hardening probe schema |
| 15 | `/crates/tauri-plugin-llm-fetch/src/webview/tests.rs` | add | load ordering と extraction/reset navigation race tests |
| 16 | `/crates/tauri-plugin-llm-fetch/src/security_normalize.rs` | add | TypeScript guard と共有する normalization |
| 17 | `/crates/tauri-plugin-llm-fetch/src/security.rs` | add | segments/rules/merge/policy と conformance fixture tests |
| 18 | `/scripts/export-rust-guard-fixtures.mjs` | add | TS guard の plain-text corpus/result を deterministic JSON 化。`--check` support |
| 19 | `/package.json` | modify | `verify:rust-guard-fixtures` script だけを追加。runtime dependency/export は変更しない |
| 20 | `/crates/tauri-plugin-llm-fetch/src/session.rs` | add | session resources/state/mutex/cancel/last-used |
| 21 | `/crates/tauri-plugin-llm-fetch/src/manager.rs`、`/crates/tauri-plugin-llm-fetch/src/manager/validation.rs` | add | fetch sequence、quality、registry、queue、reaper/shutdown と bounded input validation |
| 22 | `/crates/tauri-plugin-llm-fetch/src/manager/tests.rs` | add | source normalization、queue reservation、Unicode limit tests |
| 23 | `/crates/tauri-plugin-llm-fetch/src/commands.rs` | add | thin command adapters。business logic 禁止 |
| 24 | `/crates/tauri-plugin-llm-fetch/src/lifecycle.rs` | add | RunEvent exit と cleanup helpers |
| 25 | `/crates/tauri-plugin-llm-fetch/src/lib.rs` | add | modules、Builder/init、internal protocol、managed state、extension trait |
| 26 | `/crates/tauri-plugin-llm-fetch/permissions/default.toml` | add | Section 24 の permission set |
| 27 | `/examples/tauri-background-fetch/*` | add | npm-free UI、hidden self-test runner、public HTTPS canaries |
| 28 | `/.github/workflows/ci.yml` | modify | 既存 TS jobs を維持し、Rust unit jobs を追加 |
| 29 | `/.github/workflows/tauri-background.yml` | add | macOS smoke/long/leak/reuse schedule と manual controls |
| 30 | `/SECURITY.md` | modify | Tauri threat model、same-world、proxy/local-process/WebRTC limits |
| 31 | `/crates/tauri-plugin-llm-fetch/README.md` | add | install、config、permissions、platform support、example |

各 module はその責務の test と同じ commit/PR に入れる。`commands.rs`、`lib.rs`、example UI に security/business logic を置かない。

## 28. Implementation phases and gates

### Phase 0: feasibility/security spike

この phase は production module と同じ API を使った縦切り実装であり、別方式の prototype を作らない。

実装:

1. loopback proxy を起動する。
2. Section 13 の builder で macOS 14+ hidden WebView を作る。
3. `eval_with_callback` で `{ href, title, bodyLength }` を返す。
4. `bootstrap.js` で browser API hardening と revision probe を行う。
5. 0、2、6、10 分時点で eval callback と DOM mutation が進むことを確認する。
6. public HTTPS、redirect、subresource を proxy 経由で読み込む。
7. loopback/private/DNS rebinding、HTTP/2 origin coalescing、Alt-Svc/QUIC、WebRTC/WebTransport/WebSocket/Worker bypass fixture を試す。
8. close 後に WebView、listener、socket、task が残らないことを確認する。

Go criteria:

- remote Tauri IPC/capability なしで `eval_with_callback` が安定して返る。
- callback payload 2 MB と callback timeout を制御できる。
- 全 HTTP(S) navigation/subresource が proxy へ到達し、private/loopback が拒否される。
- hardening 後に WebRTC/WebTransport/WebSocket/Worker で proxy を迂回できない。
- denied HTTPS origin が HTTP/2 coalescing/Alt-Svc/QUIC で既存 tunnel または proxy を迂回できない。
- hidden のまま 10 分後にも probe/extraction が動く。
- 100 回の create/fetch/destroy 後に listener/socket/window が増え続けない。

No-Go の場合は issue と ADR を作成して停止する。remote IPC、別 browser、HTTP-first に設計変更しない。

### Phase 1: workspace、contracts、config

対象: file order 1〜8。

acceptance:

- `cargo metadata --format-version 1` success
- config default/invalid/unknown-field test success
- all public request/response JSON snapshot test success
- macOS 14+/13、Windows、Linux support matrix unit test success

### Phase 2: proxy/security boundary

対象: file order 9〜13。

acceptance:

- IPv4/IPv6 blocked range table/proptest success
- validated IP pinning、DNS rebinding、CONNECT 443、HTTP GET/HEAD test success
- method/body/header/connection/byte/time limit test success
- cancellation/close で全 proxy task が終了

### Phase 3: hidden WebView runtime

対象: file order 14〜19。

acceptance:

- static、CSR、redirect、never-settle fixture の expected result
- popup/download/browser API hardening test success
- eval invalid/oversized/no-callback、navigation race test success
- one-shot cleanup と reusable reset success

### Phase 4: extraction and guard

対象: file order 20〜23 と committed fixtures。

acceptance:

- node/depth/candidate/text/segment limit test success
- visible/hidden/comment/meta/template/attribute separation success
- TypeScript の transport-independent security corpus と decision 一致
- truncation + tool-chain use が fail-closed
- Cargo test は npm を起動しない

### Phase 5: manager/API/lifecycle

対象: file order 24〜29。

acceptance:

- duplicate、queue full、cancel、timeout、close、idle reap、exit test success
- state transition invariant test success
- frontend command と Rust API が同じ結果/typed error を返す
- worker WebView に capability がない

### Phase 6: integration/release

対象: file order 30〜34。

acceptance:

- npm-free example の interactive fetch success
- macOS self-test fast/long success
- `cargo package --list` に npm/TS/browser binary/secret がない
- crate README だけで新規 Tauri app に導入可能

## 29. Test specification

### 29.1 pure Rust unit/property tests

- config default、range、cross-field、unknown field
- host pattern exact/wildcard/IDNA
- URL scheme/userinfo/port/fragment/length
- 全 blocked IPv4/IPv6 boundary の直前/先頭/末尾/直後
- resolver 0/1/64/65 answers、duplicate、mixed safe/unsafe
- budget exact limit、limit+1、atomic concurrency、integer overflow
- state transition valid/invalid
- queue reservation RAII と cancellation
- error redaction/serialization
- security rule、merge、decision

### 29.2 proxy integration tests

- HTTP absolute-form GET/HEAD
- HTTP POST/body/transfer-encoding rejection
- CONNECT malformed authority/non-443/private/safe
- DNS answer pinning。validation 後の resolver 呼び出し回数が増えない
- upstream response header count/size/value limits
- response/tunnel/request byte budgets と reusable session 間の counter reset
- main/subresource の URL/host/DNS/IP/port/method/body policy violation が `UNSAFE_URL` で request 全体を cancel
- connect timeout、half-close、client abort、server abort
- close の idempotency と port release

### 29.3 WebView fixture tests

fixture pages:

- `static.html`
- `csr-delayed.html`
- `continuous-mutation.html`
- `redirect-a/b.html`
- `self-navigation-loop.html`
- `large-dom.html`
- `deep-dom.html`
- `hidden-injection.html`
- `popup-download.html`
- `browser-egress.html`
- `challenge.html`
- `empty.html`
- `eval-monkey-patch.html`
- `busy-loop.html`
- `memory-pressure.html`

assertions:

- correct final URL/title/text/contentType
- settle quiet and max timeout behavior
- computed hidden content exclusion + security segment inclusion
- max limits and truncation reasons
- popup/download denial
- `RTCPeerConnection`/WebTransport/WebSocket/Worker/SharedWorker/service worker registration failure
- private/deny-host subresource 一件で `UNSAFE_URL` となり reusable session が registry から除去される
- page が `JSON.stringify`、DOM method、probe property を変更しても host crash/privilege access がない
- eval callback missing/invalid JSON/oversize が typed error
- bounded busy-loop/memory-pressure fixture が timeout 後に WebView process/resource を解放

### 29.4 test fixture network exception

test 専用の DNS/loopback 例外は、production policy と異なる経路を検証してしまい、誤って package される面も増やすため採用しない。Cargo feature は `default = []` だけとし、raw `127.0.0.1`、localhost、private/reserved address、explicit port の拒否は test 時も変えない。

`--self-test-boundary` は production と同じ WebView/proxy で次を確認する。

- `httpbin.org` と wildcard certificate/IP を共有し得る `eu.httpbin.org` への page fetch を、session exact allowlist から外して実行する。request 全体が `UNSAFE_URL`、session が registry から除去されること。
- `www.cloudflare.com/robots.txt` の `Alt-Svc: h3` 応答を同じ reusable session で2回取得し、2回とも proxy の sent/received counter が 0 より大きいこと。2回目が proxy counter 0 で成功した場合は HTTP/3 bypass として No-Go。
- 同一 origin の Cookie が session 内で保持され、別 incognito WebView session では見えないこと。
- DOM が連続更新されるページでも settle timeout 後に bounded extraction を行い、`dom_settle_timeout` を truncation reason に記録すること。
- `maxQueueDepth = 1` で実行1件・待機1件の時、3件目が `QUEUE_FULL` になること。queued cancel と running close 後に request/session registry が 0 へ戻ること。

public canary の可用性低下は security regression と区別できるよう command error と CI log に残す。release 判定時は再実行し、canary 自体の header/certificate/DNS 特性が変わった場合はこの節と test を同時に更新する。

### 29.5 lifecycle/background tests

- main window visible/hidden/minimized
- worker creation 直後、2、6、10 分後
- one-shot 100 回
- reusable session 100 navigation
- cancel at queue/create/navigate/settle/extract/guard
- close during each stage
- system sleep/wake、network offline/recovery
- app graceful shutdown / immediate exit
- final active window/socket/task/registry count が baseline に戻る

### 29.6 TypeScript conformance fixture

`scripts/export-rust-guard-fixtures.mjs` は `npm run build` 後の public `createBuiltinContextGuard` と `test/fixtures/context-guard-corpus.js` を読み、`contentType` が plain text の fixture だけを name で sort して実行する。HTML fixture は Cheerio transport に依存するため除外し、Section 29.3 の WebView fixture で検証する。

出力先は `/crates/tauri-plugin-llm-fetch/tests/fixtures/security/ts-guard-v1.json` に固定する。top-level schema は `schemaVersion: 1`、`profile: "balanced"`、`cases: [{ name, text, requestedUse, expected }]`。`expected` は findings の category/severity/confidence/location/techniques/segmentHash、decision、reasons を含め、limitations は runtime 固有差があるため含めない。object key order は上記 schema order、JSON は 2-space indent + final LF、case は name 昇順、各 case の finding は guard output order を維持する。

引数なしは file を更新し、`--check` は memory 上の生成結果と committed bytes を比較して差があれば exit 1、書き込みはしない。`package.json` の `verify:rust-guard-fixtures` は `npm run build && node scripts/export-rust-guard-fixtures.mjs --check` とし、既存 TypeScript CI に追加する。Rust CI は committed JSON だけを読み、npm/Node を起動しない。

比較する:

- finding category/location/severity/confidence/techniques/segment hash
- guard decision と fixed reason

比較しない:

- HTTP status/header
- Playwright/Chromium 固有 DOM serialization
- whitespace の完全 byte 一致
- HTML/DOM segment extraction と truncation。Section 29.3 で別検証
- transport timing

## 30. npm-free example/self-test

`examples/tauri-background-fetch` は static `dist/index.html` と `dist/app.js` を同梱し、package manager を使わない。

`tauri.conf.json` の要点:

```json
{
  "build": { "frontendDist": "./dist" },
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "label": "main",
      "title": "llm-fetch example",
      "visible": false,
      "focus": false,
      "focusable": false,
      "closable": false,
      "skipTaskbar": true,
      "alwaysOnTop": false
    }]
  },
  "plugins": {
    "llm-fetch": {
      "requireReliableBackground": true
    }
  }
}
```

frontend は `window.__TAURI__.core.invoke` で session/fetch/cancel/close/status を操作する。worker WebView を直接参照しない。

引数なしの対話モードだけ setup 後に main window を focusable/closable に戻して表示する。全 self-test は main window と worker WebView を非表示・focus 不可・taskbar 非表示のまま実行し、`alwaysOnTop` は使わない。`--self-test` は `--self-test-fast` の alias とし、未知の `--self-test-*` は window を作る前に exit 2 とする。

`--self-test-fast` は reusable 2回と one-shot 1回、`--self-test-boundary` は Section 29.4、`--self-test-long` は 0/2/6/10 分の background reuse、`--self-test-leak` は one-shot 100回、`--self-test-reuse` は同じ session で100 navigation を実行する。成功時 `app.exit(0)`、失敗時は bounded error summary を stderr に出して process exit 1 とする。

## 31. CI

### 31.1 PR jobs

既存 TypeScript jobs は reference package のため維持する。次を追加する。

Ubuntu job は Rust command 前に Tauri/Wry の system package を固定して入れる。

```sh
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev
```

```text
rust-format-lint (ubuntu)
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings

rust-unit (ubuntu)
  cargo test --workspace --all-features

rust-msrv (ubuntu, Rust 1.90)
  cargo +1.90 check --workspace --all-targets

rust-package (ubuntu)
  cargo package -p tauri-plugin-llm-fetch --allow-dirty
  cargo package -p tauri-plugin-llm-fetch --list

tauri-macos-smoke (macos-14)
  cargo run -p tauri-background-fetch -- --self-test-fast
  cargo run -p tauri-background-fetch -- --self-test-boundary
```

macOS では `MACOSX_DEPLOYMENT_TARGET=14.0` を job env に固定する。
dependency update PR は `rust-msrv` と `cargo package` の両方を必須とし、`Cargo.lock` だけを更新して MSRV を暗黙に上げない。

### 31.2 scheduled/manual jobs

- 週次 schedule で macOS `--self-test-long`、`--self-test-leak`、`--self-test-reuse` をすべて実行する
- public HTTPS origin-coalescing/Alt-Svc proxy canary は PR fast の `--self-test-boundary` でも実行する
- `workflow_dispatch` では long/leak/reuse を個別に選択して再実行できる
- Windows/Linux Preview smoke。failure は正式 macOS release を block しないが issue を作る

### 31.3 dependency absence gate

- Cargo-only jobs は Node setup をしない。
- plugin/example tree に `package.json` を置かない。
- plugin source から `Command`/child process を起動しない。
- `cargo tree -p tauri-plugin-llm-fetch` を artifact に保存する。
- `cargo package --list` に `node_modules`、`dist-js`、browser binary、`.env`、TypeScript build output がない。

## 32. Logging/observability

`tracing` field allowlist:

- request ID の hash または caller 提供 ID
- session UUID
- stage
- duration/count/byte totals
- error code
- URL は scheme + host のみ。path/query/fragment は log しない

禁止:

- page title/text/HTML/segment
- Cookie/storage
- query parameter
- DNS full answer list at info level
- JavaScript error stack
- raw proxy header/body

debug build でも禁止 field を出さない。diagnostic payload は response contract の count/timing に限定する。

## 33. Review findings resolved by this revision

| previous ambiguity/problem | resolution |
|---|---|
| result bridge の方式が未決定 | `eval_with_callback` に固定。external page IPC はゼロ |
| Promise eval が暗黙前提 | 同期 probe を Rust が polling。Promise は使わない |
| 認証付き proxy を Tauri API で設定できない | 認証を削除し、loopback/random port/lifetime/budget に固定 |
| persistent profile の platform 差が大きい | 初版は incognito in-process session のみ |
| HTTP status 取得可否が曖昧 | status を contract から除外し、quality check へ統一 |
| background support が曖昧 | macOS 14+ full、Windows/Linux Preview、既定は非保証環境を拒否 |
| WebRTC 等の proxy bypass | document-start all-frame hardening と release gate を追加 |
| callback/threading が曖昧 | main-thread build、non-blocking callback、channel/oneshot を指定 |
| config/default/limit が未確定 | type、default、validation range を固定 |
| 実装順が phase 単位だけ | file-by-file order と acceptance を追加 |
| Cargo-only の検証が弱い | no-Node jobs、package contents、dependency tree gate を追加 |
| reusable session で network counter/CONNECT が次 request に残る | request generation ごとの budget、socket cancel、join、inactive proxy rejection に固定 |
| extraction の文字上限だけでは callback byte 上限を保証できない | JS serialized-byte trimming と Rust pre-deserialize cap の二重検証を追加 |
| queue wait と WebView slot 枯渇が同じ error | `QUEUE_FULL` と `SESSION_CAPACITY` を分離 |
| HTTPS tunnel の method/authority 不可視性 | side-effect limitation、HTTP/2 coalescing/Alt-Svc/QUIC release gate を追加 |
| blocked subresource 後に本文を成功扱いできる | policy cancellation で request 全体を `UNSAFE_URL`、reusable session destroy に固定 |

## 34. Definition of Done

初版は次をすべて満たした場合だけ完成とする。

- `tauri-plugin-llm-fetch` が Cargo crate だけで build/test/package できる。
- plugin/example consumer に npm、Node.js、Playwright、別 browser binary が不要。
- すべての取得が Tauri hidden WebView navigation を通る。
- external page へ Tauri IPC/capability/event/command を公開していない。
- DOM は `eval_with_callback` で bounded JSON object として回収する。
- macOS 14+ hidden 状態で 10 分後も probe/extraction が動く。
- HTTP(S) traffic の proxy 強制と private/loopback/reserved rejection を実証する。
- WebRTC/WebTransport/WebSocket/Worker/SharedWorker/service worker による test bypass がない。
- timeout/cancel/close/exit 後に WebView、proxy port、socket、task、registry entry が残らない。
- one-shot と reusable incognito session の isolation test が通る。
- queue/state machine の property/integration test が通る。
- extraction と security decision の committed conformance fixture が通る。
- response は常に `fetch_method = tauri_webview`、`trust = untrusted`、`tainted = true`。
- unsupported/best-effort platform は typed status/error で明示し、別 backend へ fallback しない。
- README、Rustdoc、permissions、SECURITY、npm-free example が揃う。
- `cargo fmt`、`clippy -D warnings`、全 Rust test、macOS fast/long self-test、`cargo package` が成功する。

## 35. Implementation stop conditions

次のいずれかが発生した場合、実装者は workaround architecture を追加せず作業を止め、再設計を依頼する。

1. macOS 14+ で `eval_with_callback` が bounded synchronous payload を安定して返さない。
2. worker WebView に remote capability を付けなければ DOM を回収できない。
3. WebView が loopback proxy を迂回して private network へ到達できる。
4. document-start hardening 後も WebRTC/WebTransport/Worker 等で private network へ到達できる。
5. HTTP/2 origin coalescing、Alt-Svc、HTTP/3/QUIC により deny host または proxy 外へ到達できる。
6. hidden WebView が 10 分以内に suspend され、`BackgroundThrottlingPolicy::Disabled` で防げない。
7. incognito session 間または main UI WebView へ browser state が漏れる。
8. resource cleanup 後に port/socket/window/task leak が再現する。

停止条件に到達しても Playwright、Node sidecar、HTTP-first は追加しない。

## 36. Official API references

実装は次の fixed version の API を基準にする。

- [Tauri 2.11.5 `WebviewWindowBuilder`](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindowBuilder.html)
- [Tauri 2.11.5 `WebviewWindow::eval_with_callback`](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindow.html#method.eval_with_callback)
- [Tauri 2.11.5 `PageLoadPayload`](https://docs.rs/tauri/2.11.5/tauri/webview/struct.PageLoadPayload.html)
- [Tauri 2 capability model](https://v2.tauri.app/reference/acl/capability/)
- [Tauri plugin development](https://v2.tauri.app/develop/plugins/)
- [WRY `ProxyConfig`](https://docs.rs/wry/latest/wry/enum.ProxyConfig.html)
- [WRY `WebView::evaluate_script_with_callback`](https://docs.rs/wry/latest/wry/struct.WebView.html#method.evaluate_script_with_callback)
- [`sysinfo::System::os_version`](https://docs.rs/sysinfo/0.37.2/sysinfo/struct.System.html#method.os_version)

Tauri/WRY の minor version を上げる場合は、proxy、background throttling、eval callback、incognito、initialization script の platform notes を再レビューしてから lockfile を更新する。
