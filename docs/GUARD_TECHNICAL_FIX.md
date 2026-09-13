# 技術文書のガード誤検知修正・検証報告

2026-09-13。基準コミット: `dbce109ab45b8baaa3524d1b09c2eab4030b1d74`。
本報告の前後比較はこのコミットに対する改修時の測定。リリース用コミット確定後の最新証跡は `.release-evidence/` のリリース報告を参照。npm公開は別工程。

## 結果

依頼書の無害4例はすべて `require_approval` から `allow` になり、high/critical findingもなくなった。
こちらで復元した攻撃対照4例はすべて `require_approval` を維持する。
添付されていなかった元の `reproduce.mjs` / `baseline-0.1.0.jsonl` の代わりに、本文の例と対照カテゴリから `scripts/reproduce-technical-guard.mjs` を作成した。原本8例の完全一致検証を実施したという意味ではない。

既存300例（攻撃175・無害125）の判定・カテゴリ・重大度に変更なし。
追加54例（攻撃27・無害27）を含む354例の比較では、無害25例だけが保留から許可になり、攻撃の読み取り可能への退行は0件。
全ケースの前後判定とfinding一覧は [guard-technical-comparison.json](guard-technical-comparison.json) に保存している。reasonの診断文追加はこの判定比較から除いている。

## 設計

`secret_exfiltration`、`tool_invocation`、`external_send`、`memory_write`、`policy_override` に、カテゴリ固有の動作語・対象語と要求表現の関係検査を追加した。既存の共起検査は候補抽出に使い、最終判定には使わない。

- 英語は命令形、please、you must、could you等と対象の結び付きを確認する。通常の主語付き説明、目的を述べるto、不用意なand/then共起だけでは命令としない。
- 日本語は「保存してください」「実行せよ」等の要求形を確認する。「保存します」「保存しています」は命令としない。
- token probabilities / token embeddings / トークンの確率等の語句をNLP用途として区別する。同じ文のAPIキー等は引き続き検査する。意味が曖昧な「send the token」は保留する。
- 句読点で命題を分けるが、全命題を検査する。単一の改行はPDFの折り返しとして扱い、空行、箇条書き、区切り見出し等は命令開始位置の候補とする。
- it / this / それ等の明示的な参照があれば、同じ検査セグメント内で前後の対象に結び付ける。途中に説明文を挟む指示も検査する。単なる隣接文への距離制限ではない。
- article/exampleや引用を理由とした免除は追加していない。実際の命令は説明の前置きや引用中でも保留する。
- 正規化後の全variantに適用し、hidden/comment/template/meta/attributeの収集、重大度、要求用途ごとのポリシー、検査上限、切り詰め処理は変更していない。
- `instruction_override`、役割変更、出典抑制、出力制御、権威主張の既存検出は維持した。全ルールを意味解析器へ置き換える変更ではない。

TypeScriptとRustの両方に実装し、共有のplain-text fixtureで判定・findingの一致を検査する。Rustでは同じfixtureをhidden/comment/template/meta/attributeへ配置する検証も追加した。
外部API・LLM・新規依存関係は使っておらず、課金・通信・非決定的な分類処理は増えない。

## 診断と互換性

公開型・API・判定値・設定の変更なし。入力、戻り値、`untrusted` / `tainted` 属性を維持する。利用側で拒否結果の上書きやガード無効化は不要。

TypeScriptの攻撃findingの `reason` に、ルールID、正規化variant番号、UTF-16コード単位の半開区間 `[start, end)` を追加した。Rustでは今回変更した5ルールに同じ診断を付ける。
範囲は一致した動作語と対象語を含む区間で、正規化後の検査セグメントに対するもの。復号されたvariantでは復号結果に対する範囲であり、元HTML/PDFのバイト位置ではない。切り詰めがある場合も元文書への直接オフセットにはならない。
既存のsegmentHash・techniquesと併用する。matched text、秘密の値、文書全文をreasonやログへ出力しない。reasonは人間向け診断であり、安定した機械パース用APIとして扱わない。

## 受け入れ試験

環境: macOS Darwin 25.6.0 / Apple M4、Node.js 24.11.1、Bun 1.3.14、rustc 1.92.0。

| 項目 | 実行・結果 |
| --- | --- |
| A1 | 復元スクリプトをNode/Bunで `--check` 実行。8例の不一致0、exit 0。基準ビルドは不一致4。元添付そのものは未実施。 |
| A2 | 基準ビルドと修正版を同じ354入力で比較。既存300例に判定・カテゴリ・重大度の変更なし。攻撃の読み取り可能への退行0。 |
| A3 | 追加54例は英日、説明・命令・混在・複数文・語順・長文を含み、全例が期待どおり。 |
| A4 | 54例×7形式（plain、HTML可視、hidden、comment、template、meta、attribute）×2プロファイルを検証。別途7種の難読化、PDF抽出相当の折り返し文も成功。 |
| A5 | 空行、語順、離れた対象、複数文の参照、5用途での上限超過、23.2万文字の句読点なし反復文と末尾攻撃、15万文字の空白を含む要求・非要求を確認。既存のセグメント上限・切り詰めテストも成功。 |
| A6 | `npm run verify` 成功。1014テスト成功、7件の任意Chromiumテストは通常実行ではskipし、別途有効化して8/8成功。coverageはstatements 86.95%、branches 81.67%、functions 95.80%、lines 89.66%。lint、型、Rust fixture、license、配布パッケージ、publint、attw成功。Rust 41テスト、Clippy、fmt成功。 |
| A7 | 同じ環境・既定上限で比較。下表参照。 |

追加攻撃27例の主検査カテゴリ: instruction_override 2件、secret_exfiltration 13件、memory_write 3件、policy_override 3件、tool_invocation 5件、external_send 1件。無害27例は技術文書、NLP token、通常の通信・保存・実験の説明を含む。

### E2Eの範囲

`scripts/guard-e2e.mjs` は実際のloopback HTTPサーバーから取得し、公開 `createLlmFetch` のガード・本文抽出・返却までを通す。文書取得162ケースで無害81件を返却、攻撃81件を `GUARD_DENIED / require_approval` にした。
検索プロバイダーは決定的なfixtureで、検索結果の技術説明snippetの検査、検索→取得→本文返却→出典情報を確認し、無害4件の本文返却と攻撃4件の取得失敗を確認した。別途2件で検査上限時の保留・拒否を確認し、計172 HTTPリクエスト。
テスト用fetcherは `fixture.example` のみを固定loopbackへ対応させる。製品のSSRF対策を変更していない。npm packしたtarballを別ディレクトリへインストールした状態でも同じE2Eを実施する。

実Chromiumでは公開クライアントによるJavaScript描画本文の取得、技術説明の返却、隠された複数文のAPIキー送信要求の保留を確認した。既存のDOM上限・computed hidden・描画上限テストを含め8/8成功。

DeepStillアプリの新規KV Mem調査E2E、Report/Knowledge/Episodeの品質評価、ACL/arXivの実PDF取得、ライブ検索プロバイダーのcanaryは実施していない。今回確認したのはllm-fetchの取得経路とPDF抽出相当のテキストであり、DeepStill全体の品質80点超えを保証するものではない。

## 性能

各入力を両版で5回warmup後、実行順序を交互に変えて21回測定した壁時計時間の中央値。既定のbalanced、maxCharacters=250000、maxSegments=128を使用する。I/Oは含まない。

| 入力 | 修正前 | 修正後 | 比率 |
| --- | ---: | ---: | ---: |
| repeated-verbs-232k | 14.61 ms | 16.65 ms | 1.14倍 |
| ordinary-50k | 3.19 ms | 3.09 ms | 0.97倍 |
| technical-50k | 5.82 ms | 7.58 ms | 1.30倍 |
| obfuscated-50k | 3.52 ms | 3.60 ms | 1.02倍 |
| technical-limit-250k | 29.62 ms | 38.31 ms | 1.29倍 |

技術語の共起が多い入力は、候補ごとの要求・対象・参照関係を検査するため約29〜30%増加した。5万文字では約1.8ms、25万文字では約8.7msの追加。
要求位置の走査境界を事前に算出し、要求の接頭部分は単語を順番に読み、対象の正規表現を再利用して、動作語のたびに長い接頭部分を繰り返し走査する処理を避けた。23.2万文字の句読点なし反復文も測定に含めている。
今回の入力では有界な追加コストとして許容できると判断したが、あらゆるHTML/難読化入力の遅延上限を保証する測定ではない。

## 再実行コマンド

```sh
npm run build
node scripts/reproduce-technical-guard.mjs --check
bun scripts/reproduce-technical-guard.mjs --check
npm run verify
npm run verify:guard-corpus
npm run verify:guard-e2e
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 npx vitest run test/playwright/integration.test.ts
npm run format:check
cargo fmt --all -- --check
cargo test -p tauri-plugin-llm-fetch
cargo clippy --workspace --all-targets -- -D warnings
```

前後比較では、改修前に保存した基準コミットのビルドを使用した。

```sh
node scripts/guard-change-report.mjs /tmp/llm-fetch-guard-baseline/dist/index.js
```

別環境では基準コミットを別ディレクトリへチェックアウトし、同じlockfileでビルドした `dist/index.js` の絶対パスを渡す。
実行ログ、復元8例の結果、比較JSON、導入用tarballは `.release-evidence/technical-guard/` に保存する。

## 導入と残る限界

公開前検証用のローカルtarballを生成する。manifestの版は既存準備版の0.1.1のままで、同名のnpm公開版を指すものではない。成果物のSHA-256は同ディレクトリの `package.sha256` に記録する。

```sh
npm install --save-exact /absolute/path/to/llm-fetch/.release-evidence/technical-guard/llm-fetch-0.1.1.tgz
```

正規のバージョン更新・npm公開は通常のリリース手順で行う。

ヒューリスティックなので、未対応の言語・婉曲表現・主語省略・引用の意図を完全には判別できない。参照解決は同一セグメント内の対象語への保守的な結び付けであり、一般的な意味理解ではない。別HTMLセグメントに分かれた暗黙的な指示連鎖まで新たに保証する変更ではない。
技術チュートリアルに実際の秘密開示・ツール実行・記憶変更の命令が含まれる場合は、読み取り用途でも保留され得る。今回変更しないルールにも誤検知・見逃しの余地は残る。`assurance: low` と「findingなしは安全証明ではない」という既存の制約を維持する。
