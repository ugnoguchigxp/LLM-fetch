# `tauri-plugin-llm-fetch` 検証記録

- 判定日: 2026-09-22
- 対象: `tauri-plugin-llm-fetch` 0.1.0
- 正式対象: macOS 14以降
- 現在の判定: macOS 14以降の0.1.0 release gateはPASS

## 検証環境

| 項目 | 値 |
|---|---|
| OS | macOS 26.5.2 (25F84) |
| host Rust | rustc 1.92.0 / cargo 1.92.0 |
| MSRV | rustc 1.90.0 |
| Node.js / npm | 24.11.1 / 11.6.4 |
| Tauri | 2.11.5 |
| tauri-plugin | 2.6.3 |

## Release gate

| Gate | 結果 | 証拠 |
|---|---|---|
| Cargo build / unit | PASS | workspace 43 tests、doc tests成功 |
| Clippy | PASS | workspace/all-targets/all-features、warning 0 |
| MSRV | PASS | Rust 1.90.0でworkspace/all-targets check成功 |
| Rustdoc | PASS | warningをerror扱いして生成成功 |
| Cargo package | PASS | 37 files、Node/TypeScript/Playwright/別browser binaryなし |
| fast hidden WebView | PASS | reusable 2回、one-shot 1回 |
| debug worker visibility (new) | PASS | `debug_worker_visible/devtools` config追加。hidden既定・debug可視・release拒否のunit testに加え、visible/hidden実WebViewの2 checkpointが同一結果 |
| boundary suite | PASS | deny origin、Alt-Svc、Cookie分離、continuous DOM、queue/cancel/close |
| one-shot lifecycle | PASS | 100/100、終了時registry/window残存なし |
| reusable lifecycle | PASS | 100/100、終了時registry/window残存なし |
| 10-minute background | PASS | 2026-09-22再実行で0、2、6、10分の同一hidden WebView取得、終了時one-shotとregistry/window cleanup成功。long試験のDNS期限は製品と同じ10秒 |
| TypeScript reference | PASS | 21 files、239 passed、7 skipped、guard fixture一致 |
| SAAA integration | PASS（WebFetch scope） | Rust検索live canary、SAAA dispatcher→実WebView content fetch、20 offline tests、sidecar cancel/fallbackを確認。依存は検証commitへrev固定 |
| Source size | PASS | plugin/exampleのRust・JavaScript sourceは全て800行未満 |

## 実行コマンド

```sh
cargo fmt --all -- --check
cargo test --workspace --all-features
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo +1.90.0 check --workspace --all-targets
RUSTDOCFLAGS='-D warnings' cargo doc -p tauri-plugin-llm-fetch --no-deps
cargo package -p tauri-plugin-llm-fetch --allow-dirty
cargo package -p tauri-plugin-llm-fetch --allow-dirty --list
node --check crates/tauri-plugin-llm-fetch/assets/bootstrap.js
node --check crates/tauri-plugin-llm-fetch/assets/extractor.js
npm run verify
```

実WebView gate:

```sh
cargo run -p tauri-background-fetch -- --self-test-fast
cargo run -p tauri-background-fetch -- --self-test-boundary
cargo run -p tauri-background-fetch -- --self-test-leak
cargo run -p tauri-background-fetch -- --self-test-reuse
cargo run -p tauri-background-fetch -- --self-test-long
```

SAAA consumer gate（`/Users/y.noguchi/Code/SAAA/src-tauri`）:

```sh
cargo check --all-targets
cargo clippy --all-targets -- -D warnings
cargo test
```

## Boundary suiteの確認内容

- exact allowlist外のcross-origin subresourceを`UNSAFE_URL`にし、該当reusable sessionを破棄する。
- `Alt-Svc: h3`応答後の2回目のnavigationもloopback proxyの送受信counterが増える。
- Cookieは同一incognito session内で保持し、別sessionへ漏れない。
- 10万文字の単一hidden text nodeをboundedに切り、末尾の隠し命令を検知してtool chainingをdenyする。
- DOMが連続更新されてもsettle timeout後にbounded extractionし、`dom_settle_timeout`を記録する。
- 実行1件・queue 1件の状態で3件目を`QUEUE_FULL`にする。
- queued cancelとrunning closeの後にrequest/session/window registryが0へ戻る。
- extraction後からinternal resetまでにnavigationが競合した場合は成功payloadを破棄する。
- WebView callbackのNUL、許可外C0、C1制御文字をRust側でも拒否する。

## 非干渉UI条件

self-testはexample main windowとworker WebViewの両方に次を適用する。

- `visible = false`
- `focus/focused = false`
- `focusable = false`
- `closable = false`
- `skipTaskbar = true`
- `alwaysOnTop/always_on_top = false`

設定ファイルと起動時APIの両方で適用し、API設定失敗時はself-testを開始しない。未知の`--self-test-*`はTauri起動前にexit 2とし、誤って対話UIを表示しない。

## Cargo-only確認

- plugin/example treeにplugin用`package.json`、guest-js、Node sidecar、Playwright、Chromium downloadがない。
- Cargo dependency treeにPlaywright、Node.js、Chromium dependencyがない。
- Cargo package 37 filesに`node_modules`、TypeScript source、別browser binary、`.env`がない。
- Tauri経路はHTTP-first fallbackを持たず、`fetchMethod`は常に`tauri_webview`。

## SAAAへの組み込み

SAAAはplugin managerをRust backendから直接利用し、macOSではRust検索 + WebView content fetchを既定にする。frontend capabilityは削除済みで、Windows/Linuxは従来sidecarへfallbackする。依存はこの検証済みplugin commitへrevision固定し、隣接checkoutを必要としない。2026-09-22のSAAA scope検証ではoffline 20 testsとlive検索canaryが成功し、SAAA dispatcherから実workerで取得するE2Eも成功した。

## 継続canary

次は環境状態を変更するため、この作業中には実行していない。

- system sleep/wake中のsession維持
- network offline/recovery
- Windows/Linux preview WebView

これらはmacOS 14以降を正式対象とする0.1.0のコード残タスクではない。OS/WebView更新後の回帰確認として扱う。週次CIはmacOSのlong/leak/reuseを実行し、public HTTPS canaryの変化と実装regressionを区別して確認する。

## 既知の境界

- loopback proxyは同一OS accountの別processに対する認証境界ではない。
- CONNECT内部のHTTPS method/bodyはpluginから検査できない。allowlist済みoriginにも副作用requestを送れる前提で扱う。
- hardeningとextractorはpageと同じJavaScript worldにあり、OS sandboxではない。
- consumerはremote WebViewから到達できる副作用付きcustom URI schemeを登録しない。
- guard findingが0でも安全の証明にはならず、全結果を`untrusted` / `tainted`として扱う。
