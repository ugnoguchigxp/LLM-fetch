# llm-fetch Markdown取得とガード診断の実装計画

作成日: 2026年10月9日。対象: npm版llm-fetchのTypeScript実装。
評価時のHEAD: `63054d7f81da8dea5ccbd3324ece3ce36299d2dc`。

本計画の目的は、Markdown本文取得を追加し、ガードの走査予算配分、返却用切り詰めとの順序、拒否理由の欠落を改修することである。Grokなどの実装担当者は、この文書だけで変更範囲、処理仕様、試験条件、完了条件を把握できる。本文中の新しい型・コード・ファイル名は実装仕様であり、現行版に存在するという意味ではない。

この文書は実装開始時の仕様を記録している。2026年10月9日に実装とレビュー指摘の修正を行い、0.1.2候補の検証を進めている。公開済みであることを示す文書ではない。追加の方針変更として、HTML/XHTMLおよびMarkdown内のHTML要素を返却用Markdownへ変換する。以下の出力仕様もこの方針へ更新した。

## 1 作業規則と範囲

### 1.1 着手時に行うこと

1. カレントディレクトリがllm-fetchリポジトリのルートであることを確認する。
2. `git status --short` と `git diff` を確認し、既存変更を保持する。別の作業ディレクトリに移った場合はそちらの規則を読み直す。
3. 適用されるAGENTS.md、`CONTRIBUTING.md`、`SECURITY.md`、`docs/API.md`、`docs/GUARD_TECHNICAL_FIX.md`を読む。
4. このプロジェクトで未実行なら `initial_instructions` MCPを一度だけ実行し、利用可能な環境ではその指示に従う。本会話では実行済み。Grok側にMCPがない場合は未利用と記録し、ツール実行を捏造しない。
5. HEADが上記と異なる場合、表2の関数と契約を現行ソースで確認してから変更する。古い行番号に依存しない。
6. フェーズ0の基準測定を保存してから実装する。既存ファイルを広範囲に整形しない。

### 1.2 今回実装するもの

- `text/markdown`のHTTP取得、デコード、構造を保持する抽出、ガード、read/searchAndRead/toolsetの一貫した対応。
- 総量が既定上限内でも検査が欠ける文字数予算配分の修正。
- 返却本文を短くしても、検査すべき本文が未検査にならない処理順序。
- ガード拒否・検査不足を説明する安定した理由コードと、本文を含まない上限付き診断。
- 本文不足と動的描画の必要性の理由コード。既存エラーコードとfallback契約の維持。
- HTML/XHTMLとMarkdown内のHTMLの構造化Markdown出力。見出し、入れ子リスト、表、コード、リンクを保持し、HTMLへ戻す例外は作らない。ガード許可後に変換する。
- fixture、回帰テスト、必要なドキュメント、限定live確認。

### 1.3 変更しないもの

- ライセンスはMIT。新しい実行時依存は導入しない。
- 新しい実行時依存は追加しない。既存のCheerioを検査用HTML解析に使う。
- PDF、Office、汎用クローラー、Deep Research、LLM要約、新検索providerは対象外。
- 公開操作は既存の `search`、`read`、`searchAndRead`、`toolset`を使う。
- SSRF、DNS pinning、redirect、ポート制限、圧縮前後のサイズ上限、期限、取消、並列制御の仕組みは置き換えない。
- 既定の128セグメント、250,000文字、および設定可能な最大値は変更しない。上限撤廃、公式ドメインの無条件許可、ガード無効化は行わない。
- DuckDuckGoのchallenge突破、proxy回転、検索0件やガード拒否を契機とする無条件再取得を追加しない。
- Rust/TauriのAPIや取得機構は今回の対象外。共有fixtureの整合性は検証する。
- 他プロジェクトの設定、DB、認証情報をコピーしない。有料契約、公開、npm publish、既存の別Codexチャットへの送信は行わない。

## 2 評価で確定した事実

| ID | 現行の事実 | 主な根拠 |
| --- | --- | --- |
| F1 | `text/markdown`がHTTPとクライアントの許可集合にない | `src/retrieval/http-fetcher.ts`のDEFAULT_ALLOWED_CONTENT_TYPES、`src/client-validation.ts`のREADABLE_CONTENT_TYPES |
| F2 | 既存plain抽出は字下げ・連続空白・空行を正規化する | `src/retrieval/extract-content.ts`のnormalizePlainText、extractPlainTextContent |
| F3 | 拒否時に内部reasons/limitationsが落ちる | `src/client.ts`のprocessFetched内GUARD_DENIED生成、`src/errors.ts` |
| F4 | fairShareによって総量上限未満でも本文の検査が欠ける | `src/security/rules.ts`のscanSegments。100セグメント、合計20,495文字のfixtureでrequire_approval |
| F5 | plain/XML、HTML選択本文で返却用切り詰めの後に検査する | processFetchedとextractHtmlContent/extractPlainTextContent。plainの20,000文字以降の攻撃は未検査でallow、攻撃本文自体は返却されない |
| F6 | 攻撃findingがなくても走査不足でrequire_approvalとなる | `src/security/policy.ts`のdecideContextPolicy |
| F7 | 検索・ページ取得・期限・部分結果の主要契約は既にある | `src/client-search-and-read.ts`、`src/providers/fallback.ts`、`src/errors.ts` |

2026年10月9日の限定live評価では、BunのMarkdown 2 URLはUNSUPPORTED_CONTENT_TYPE、`https://bun.sh/`はGUARD_DENIEDだった。トップページはfinding 0、本文を含むセグメント数188件で、128件を超えた。収集段階の欠落は0だった。文字数予算配分による切り詰めも記録された。これは走査不足の再現であり、攻撃の誤検知と断定しない。

同じ評価ではexample.comの本文取得に成功し、指定のDuckDuckGo検索2件は各3件を返した。ユーザーが別の試行で観測したBOT_CHALLENGEは、この試行では再現しなかった。既存テスト1,014件成功、7件skip、lint・typecheck成功。これらを改修後の結果として流用しない。

### 2.1 参照する既存処理

| ファイル | 読む関数または責務 | 実装時の扱い |
| --- | --- | --- |
| `src/client.ts` | processFetched、readUncached、inspectSearchResults | 検査と返却の順序、診断伝播、fallback条件 |
| `src/retrieval/http-fetcher.ts` | requestOnce、createSafeHttpFetcher | MIME追加とAcceptのみ。通信安全境界は維持 |
| `src/client-validation.ts` | READABLE_CONTENT_TYPES、validateFetchResult | custom fetcherを含むMarkdown許可 |
| `src/client-options.ts` | validateClientOptions | retrieval.allowedContentTypesの検証を維持 |
| `src/retrieval/extract-content.ts` | decodeBody、loadHtml、loadXml、抽出2関数 | デコード再利用、全文選択と返却切り詰めの分離 |
| `src/security/html-segments.ts` | prepareHtmlForExtraction | hidden/comment/template/meta/attributeの検査資料を再利用 |
| `src/security/rules.ts` | scanSegments | 文字予算修正と診断の計数 |
| `src/security/context-guard.ts` | inspectRaw、inspectPrepared、validateGuardResult | Markdown検査、組み込み診断生成、外部guardの境界 |
| `src/security/policy.ts` | decideContextPolicy | 現行のfail-closedを維持、理由コードを追加 |
| `src/security/merge-decisions.ts` | mergeGuardResults | 厳しい判定と診断の有界マージ |
| `src/contracts.ts`、`src/errors.ts`、`src/index.ts` | 公開型とexport | 下記の追加フィールドだけを追加 |
| `src/tools/toolset.ts` | compactSecurity、fetch_content | 簡潔な出力、Markdownの文字列保持 |

## 3 取得と出力の設計方針

既存のsearch、read、searchAndRead、toolsetを使い、本文の取得・検査・返却を一貫した契約で扱う。

| 設計方針 | 今回の実装への反映 |
| --- | --- |
| 検索後に必要なURLだけ読む | READMEの標準例を検索5件から最大2件選択してreadする形にする。検索だけで本文取得しないこともテスト |
| LLMに渡せるMarkdown出力 | 既存textへ構造化Markdownを返す。HTML要素も変換し、出典のcontentTypeは維持する |
| 本文・出典・取得状態を分けて返す | 既存の出典・error・failuresを維持し、ガード理由コードと診断だけを補う。別のsuccessラッパーは作らない |
| 本文選別と出力整形を分離する | 選択された全文をガードし、その後に返却上限を適用する |
| 完遂できない処理をwarning等で表す | 検査不足と返却用切り詰めを区別する。検査不足はllm-fetchの既存方針に従い保留または拒否 |

検査不足はfail-closedとし、warningだけで本文を返さない。検査対象の上限を維持し、処理を完遂できない理由を利用側へ伝える。

## 4 確定する公開契約

### 4.1 新しい診断型

`src/contracts.ts`で以下を定義し、`src/index.ts`から型をexportする。名前と意味を実装途中で自由に増やさない。

```ts
export type GuardReasonCode =
  | "PATTERN_DETECTED"
  | "SEGMENT_COUNT_LIMIT"
  | "CHARACTER_BUDGET_LIMIT"
  | "SEGMENT_TEXT_LIMIT"
  | "SEGMENT_COLLECTION_LIMIT"
  | "INSPECTION_INCOMPLETE"
  | "ADDITIONAL_GUARD_RESTRICTION";

export interface GuardScanDiagnostics {
  stage: "content" | "reference" | "search_result";
  segmentCount: number;
  selectedSegmentCount: number;
  scannedSegmentCount: number;
  availableCharacters: number;
  scannedCharacters: number;
  maxSegments: number;
  maxCharacters: number;
  omittedSegments: number;
}
```

- `segmentCount`: scannerに渡したセグメント数。visibleTextの先頭セグメントを含む。空文字も現行と同様にセグメント数へ含める。
- `selectedSegmentCount`: 件数上限による選択後の数。maxSegmentsを超えない。
- `scannedSegmentCount`: 選択された非空セグメントのうち、1文字以上を検査した数。
- `availableCharacters`: scanner入力の全セグメントのtext.lengthの合計。collection前の原文長やユニーク文字数ではない。検査用HTML投影などの重複も数える。
- `scannedCharacters`: scannerで選択した文字列の長さの合計。正規化後variantの総文字数ではない。
- `omittedSegments`: collection段階で収集できなかった件数。scannerの件数上限による欠落とは分ける。
- 文字数は既存と同じUTF-16コード単位。バイト数と混同しない。
- 数値は非負の有限なsafe integerだけを出力する。文字列、URL、hash、matched textを診断に追加しない。

`GuardResult`および`RetrievedDocument.security`へ次をoptionalで追加する。既存のcustom guardが必須フィールド追加で壊れないようにする。

```ts
reasonCodes?: readonly GuardReasonCode[];
diagnostics?: readonly GuardScanDiagnostics[];
```

組み込みguardはreasonCodesを常に返す。診断は1検査につき1件、マージ後は最大8件。理由コードは全7種類の和集合を型定義の順序で並べ、重複を除く。診断を8件に切ること自体は検査不足ではなく、判定を変えない。診断配列は「先頭最大8検査のサマリー」であり、文書全体の集計値として足し合わせないことをAPIに記載する。

### 4.2 理由コードの生成

| コード | 生成する条件 |
| --- | --- |
| PATTERN_DETECTED | benign_mention以外のfindingが1件以上。警告レベルでも付ける |
| SEGMENT_COUNT_LIMIT | scanner入力数がmaxSegmentsを超えた |
| CHARACTER_BUDGET_LIMIT | 選択対象に、文字数予算が理由の未検査文字が残った |
| SEGMENT_TEXT_LIMIT | collectorから渡されたsegment.truncatedがtrue |
| SEGMENT_COLLECTION_LIMIT | collectorのomittedSegmentsが1以上 |
| INSPECTION_INCOMPLETE | 内部入力のtruncated=trueだが、上記の具体的な上限理由へ分類できない。空カテゴリのまま原因不明にしないための保守的な補助コード |
| ADDITIONAL_GUARD_RESTRICTION | 外部additional guardがrequire_approvalまたはdenyを返した |

人間向けreasons/limitationsを文字列解析してコードを推定しない。scannerとcollectorから構造化された値を渡す。既存reasons/limitationsは残し、既存の共有fixtureに含まれる文言を必要なく変えない。

内部のPreparedGuardInputへ`stage?: GuardScanDiagnostics["stage"]`と`omittedSegments?: number`を追加する。stageの既定はcontent。クライアントの参照URL検査はreference、検索メタデータ検査はsearch_resultを明示する。collectorのomittedSegmentsと各segment.truncatedから具体的な理由を渡し、単なるtruncated booleanだけに情報を縮めない。新しい内部の呼び出しでは必ず具体的な理由を供給し、INSPECTION_INCOMPLETEは分類不能な既存入力の保守的処理に限る。

外部guardの返却オブジェクトにある新規reasonCodes/diagnosticsは、validateGuardResultでは採用しない。従来の検証済みフィールドだけを採用し、外部guardの制限は呼び出し側がADDITIONAL_GUARD_RESTRICTIONとして記録する。外部guardに組み込み検査の件数や網羅性を申告させない。

### 4.3 エラーとモデル出力

`LlmFetchErrorOptions`と`LlmFetchError`にoptionalな`guardReasonCodes`と`guardDiagnostics`を追加する。GUARD_DENIEDで設定する。既存code、guardDecision、warningCategories、retryable=falseは維持する。

- コンストラクタでコピーし、固定コードの検証・重複除去・件数上限・数値検証を行う。呼び出し側の配列変更に追随させない。
- `toJSON()`はguardReasonCodesのみ追加し、guardDiagnosticsとcauseは出さない。詳細を必要とするホストはerror.guardDiagnosticsを明示的に参照する。
- `CompactToolSecurity`にはoptionalなreasonCodesのみ追加する。diagnostics/reasons/limitations/findingsの詳細はモデル出力へ加えない。
- `toolset.execute()`の失敗は引き続きthrow。新しい成功風のエラー結果や、自動的な追加ツール呼び出しを作らない。
- diagnosticsをJSON化しても本文・コメント・HTML属性の値・URL・認証情報が含まれないことを試験する。既存のerror.urlとは別フィールドであり、ログへerrorオブジェクト全体を出す運用を推奨しない。

`CONTENT_INSUFFICIENT`だけに使うoptionalな`reasonCode`もエラーへ追加する。値は`INSUFFICIENT_TEXT`と`DYNAMIC_RENDERING_REQUIRED`の2種類で、`toJSON()`にも含める。その他のエラー分類を作り直さない。

診断の整形で元の取得エラーを別の例外へ置き換えない。公開エラーコンストラクタへ不正な診断値が渡された場合、未知のコードと不正な診断要素を捨て、既存code/guardDecisionを保持する。診断値の除外によって許可へ変えない。固定stageと数値フィールドだけを再構築し、未知プロパティをコピーしない。組み込み経路では不正値が生じないことをテストで保証する。

## 5 走査予算配分の仕様

### 5.1 セグメント選択

件数上限を超えた場合、先頭ceil(maxSegments/2)件と末尾floor(maxSegments/2)件を選ぶ既存方針を維持する。ただし末尾件数0の場合は末尾配列を空にする。`slice(-0)`は全配列を返すため使用しない。maxSegments=1で選択が上限を超えない回帰テストを必須とする。

省略がある限りSEGMENT_COUNT_LIMITを付け、読み取り用途はrequire_approval、後続ツール用途はdenyを維持する。空セグメント削除や同一文字列の重複排除によって今回の件数上限を回避しない。

### 5.2 文字予算

選択された各セグメントの長さをL[i]、全体予算をBとする。

1. sum(L) <= Bなら全セグメントを全文検査する。fairShareを計算しない。
2. sum(L) > Bなら、sum(min(L[i], q)) <= Bを満たす最大整数qを二分探索する。探索範囲は0..Bでよい。
3. 各セグメントへmin(L[i], q)文字を配分する。残余を、L[i]が配分より大きいセグメントへ入力順に1文字ずつ配る。最大qを求めた後なので残余分配は1周以内に完了する。
4. 配分が本文長未満なら、先頭ceil(budget/2)文字と末尾floor(budget/2)文字を検査する既存方針を維持する。budget=0は検査を飛ばす。末尾0文字の場合は空文字列を使う。
5. 欠けた文字があればCHARACTER_BUDGET_LIMITを付ける。全配分合計は必ずmin(B, sum(L))、各配分は0..L[i]。
6. normalizeForScanとルール評価は既存方式を維持する。各セグメントの検査用文字列が配分どおりであることを確認し、入力を二重に走査して上限を迂回しない。

計算量はセグメント数nに対しO(n log B)、配分用メモリO(n)。文字数上限や難読化variant上限を緩和しない。予算不足時に連結したhead/tailは完全な文脈ではないため、findingがなくても許可しない。

20,000文字の本文と5文字の属性99件なら合計20,495文字を全文検査する。これが今回の主要な改善例である。188件/169件のliveページは、配分修正後も件数上限で拒否され得る。それを失敗と扱って上限を増やさない。

## 6 抽出とガードの処理順序

### 6.1 共通の順序

```text
安全なHTTP取得 または既存の明示的ブラウザ取得
  → fetched result検証
  → 文字コードの厳密なデコード
  → 検査資料の準備と返却候補全文の選択
  → URL等の参照情報のガード
  → 本文と付帯セグメントの組み込みガード
  → 既存additional guard
  → 厳しい判定へ統合
  → 拒否ならGUARD_DENIED
  → 許可なら本文不足判定
  → 返却用文字数上限の適用
  → 出典情報を付けて返却・既存cacheへ保存
```

各段階の既存signal/deadline確認を維持する。返却用maxCharactersを小さくしても、ガード対象の文字列・予算・判定が変わらないようにする。返却上限と検査上限は別物である。

### 6.2 既存HTMLとplain/XMLの最小変更

抽出処理内に、返却候補の全文を選ぶ内部関数と返却上限を適用する内部関数を分ける。HTMLの旧plain返却ラッパーは削除し、候補選択のテストとclientのMarkdown返却テストを分ける。plain/XMLの既存抽出は維持する。全文を得るために公開maxCharactersの上限を引き上げたり、同じDOMを二度抽出したりしない。

- HTML: prepareHtmlForExtractionで付帯セグメントを収集した後、従来と同じ選別・除外ルールで選んだ本文全文と、返却するtitleを検査する。nav等も含めた全HTMLを新たに本文扱いする変更は行わない。候補の短さで抽出に失敗する場合は、抽出によるDOM変更より前の可視テキストを保持してガードを完了する。
- plain: normalizePlainTextによる従来の返却形式は維持するが、切り詰め前の全文を検査する。
- XML: 既存XML解析の可視テキスト全文を検査してから切り詰める。XMLのセキュリティ仕様全般の拡張は今回行わない。
- 本文不足はガード完了後に返す。攻撃または検査不足がある場合はCONTENT_INSUFFICIENTよりGUARD_DENIEDを優先する。
- 構造上限によるRESPONSE_TOO_LARGEはそのまま返す。安全に検査資料を作れない解析エラーはGUARD_FAILEDとし、ブラウザ再取得で回避しない。新しいエラーメッセージには元のparser errorや本文を埋め込まない。

この変更は検査対象を「抽出後の本文と付帯資料」に定義するもので、削除済みscript、外部CSS、画像、全リンク先を含む原サイト全体の検査保証ではない。assurance=lowを維持する。

### 6.3 切り詰めの契約

`RetrievedDocument.truncated`は引き続き「返却本文が短くなった」ことだけを表す。characterCountは返却用切り詰め前の文字数。検査完了後に返却だけ切り詰めた安全なfixtureはallowかつtruncated=trueとなってよい。

全文が検査予算を超えた場合は、返却maxCharactersが小さくてもfail-closedとする。切り詰め前に存在する攻撃を、返却されないという理由で無視しない。既存より拒否が増える可能性をCHANGELOGに明記する。

## 7 Markdown対応の詳細

### 7.1 HTTPとデコード

- DEFAULT_ALLOWED_CONTENT_TYPESとREADABLE_CONTENT_TYPESへ`text/markdown`だけを追加する。`text/x-markdown`や拡張子推定は追加しない。
- Acceptは既存の並びとq値を保ち、末尾へ`,text/markdown;q=0.9`を追加する。HTML優先を変えない。
- `content-type: text/markdown; charset=utf-8`のパラメータは既存どおりheadersからdecodeBodyへ渡す。MIMEの大小文字・前後空白の正規化は既存経路に任せる。
- BOM、UTF-8、UTF-16、Shift_JIS等は既存decodeBodyの対応範囲を再利用する。不正バイト・非対応charsetはUNSUPPORTED_CONTENT_ENCODING。黙って置換・UTF-8再解釈しない。
- `.md`でもtext/htmlならHTML経路、拡張子なしでもtext/markdownならMarkdown経路。MIMEを偽装してもガードは省略しない。
- custom fetcherにも同じクライアント検証を適用する。headersとcontentTypeの不一致検査は維持する。

### 7.2 Markdownの本文

新規の `src/retrieval/extract-markdown.ts`に、デコード済み文字列からMarkdown候補を作る内部処理を置く。

- HTMLがないMarkdownはCRLFと単独CRのLF正規化以外は変形しない。HTMLがある場合はコード・エスケープ・自動リンクを保護し、HTML要素をMarkdownへ変換する。コード内の文字列は要素とみなさない。
- 見出し、ordered/unordered list、入れ子の字下げ、fenced/indented code、リンク先、表、末尾2スペースによる改行、front matterを保持する。
- titleは今回hostnameを使う。Markdown見出しのパーサーやfront matter解釈は追加しない。
- 本文不足の基準はplainと同じ20文字。ただし判定だけnormalized.trim().lengthを使い、返却文字列はtrimしない。短くてもガードは先に行う。
- characterCountはMarkdown変換後・切り詰め前のtext.length。excerptは返却本文の先頭最大240コード単位。
- 返却上限では先頭maxCharactersまでを取り、サロゲートペアを分断する位置なら1コード単位戻す。最大値を超えない。元から閉じているインラインコード内で切り詰める場合は、上限内で終端を保つ。コードフェンスやリンクを合成して補完しない。途中で終わる可能性はtruncated=trueで示す。
- `text`を使い続け、別のmarkdownフィールド、formatsオプション、新APIは追加しない。直接APIではcontentTypeで判別できる。toolsetは既存のtext文字列をそのまま扱う。

### 7.3 Markdownに混在するHTMLの検査

Markdownの出力保存用文字列と検査用資料を分ける。検査用DOMと、許可後の返却用変換DOMを分ける。HTMLへ再シリアライズして返さない。

1. LF正規化後のMarkdown全文をvisibleセグメントとして必ず検査する。コードブロック、引用、front matterにも免除を設けない。
2. 本文に`<`が1文字でもあれば、既存loadHtmlとprepareHtmlForExtractionを使って別の検査用DOMを作る。これはHTML混在を安全に無視できるという判定ではなく、追加検査を起動する保守的な条件である。
3. DOMから可視テキストを追加のvisibleセグメントとして収集し、hidden/comment/template/meta/attributeも既存collectorで収集する。これにより、タグで分断された命令や隠れた命令も検査対象にする。元Markdownセグメントは削除しない。
4. 全セグメントを同一のcontent検査へ一括で渡す。原文とHTML投影へ別々に250,000文字を割り当てない。二重表現の文字も予算に数える。
5. collectorの切り詰め・欠落を診断へ渡す。HTML構造上限超過はRESPONSE_TOO_LARGE、安全に検査できない解析失敗はGUARD_FAILED。Markdownをplain扱いして再試行しない。
6. `inspectRaw(text/markdown)`とクライアントが同じ資料準備処理を使う。新規の内部ヘルパー `src/security/markdown-segments.ts`へまとめ、クライアント側と単体guard側で別実装しない。

無害なHTMLを含むMarkdownは、検査を完了して許可された後、HTML要素をMarkdownへ変換して返す。見出し階層・リストの入れ子・コード・リンクを保持する。単純な表は行列、結合・複雑なセルは行・列・結合範囲の記録形式にし、セルの内容を複製しない。変換は最大2,000,000文字、表は最大1,024列に制限する。これはHTMLサニタイズ済みという契約ではない。untrusted/taintedを維持し、toolsetのJSON文字列として渡す。UIでMarkdownを描画する場合のレンダラー設定とURLの扱いは利用側の責務であることをSECURITY/APIへ記載する。ログやエラーにこの本文を含めない。

コード例の`<T>`や`<div>`も追加検査を起動し得る。正常な技術文書fixtureを用意し、タグ表記だけで拒否しないことを確認する。ただし実際の命令文や走査不足には免除を与えない。

## 8 エラーとfallbackの決定表

| 段階・状況 | 返却契約 | 再試行・別経路 |
| --- | --- | --- |
| 検索challenge/rate limit/timeout | 既存BOT_CHALLENGE/RATE_LIMITED/TIMEOUT、retryable/cooldown維持 | 設定済みfallbackSearchだけが既存retryable条件で次providerへ進む |
| 検索0件 | 正常な空配列。searchAndReadは空のhits/documents/failures | fallbackしない。本文HTTPリクエスト0件 |
| 検索成功、ページ取得失敗 | searchAndReadのfailuresに既存kindとerror | 他の成功文書を保持 |
| HTTPエラー、MIME非対応、文字コード非対応 | 既存エラーコード、HTTP status等を維持 | ブラウザでガードを迂回しない |
| 攻撃または走査不足 | GUARD_DENIEDとguardDecision、reasonCodes | 自動再試行しない。読み取り用途は保留、後続ツール用途は既存deny |
| 検査資料の解析失敗 | GUARD_FAILEDまたは既存RESPONSE_TOO_LARGE | fail-closed。別経路なし |
| 許可済みだが本文不足 | CONTENT_INSUFFICIENT / INSUFFICIENT_TEXT | HTML/XHTMLでrender=autoかつ既存browser利用可能な場合だけ既存fallback |
| 許可済みで動的ページと判定 | CONTENT_INSUFFICIENT / DYNAMIC_RENDERING_REQUIRED | 同上。新しい動的判定器は作らない |
| 検索後の全体期限 | timedOut=trueと完了文書、overall_timeout/not_started | 部分結果を保持 |
| 呼び出し側取消 | 既存AbortSignalのreasonでreject | 部分成功に変換しない |

`readUncached`のauto fallbackは、HTML/XHTML、上表のCONTENT_INSUFFICIENT理由、ガード完了の3条件を満たす場合だけに限定する。Markdown/plain/XMLの不足やGUARD_FAILED/GUARD_DENIEDでは呼ばない。render=alwaysの既存明示的動作は変更しないが、ガード拒否を受けて自動的にalwaysへ切り替えない。

利用側には、検査不足時は独立した承認・レビューへ回すか別の資料を選ぶこと、設定上限を増やしても安全と認定されたことにはならないことを説明する。require_approvalはライブラリ内で自動解除できる状態ではない。

## 9 実装フェーズと完了条件

フェーズ順に実施する。各フェーズの完了条件を満たしてから次へ進む。作業を並列エージェントや別チャットへ委譲することは本計画では要求しない。

| フェーズ | 変更対象 | 作業 | 完了条件 |
| --- | --- | --- | --- |
| 0 基準の固定 | テストと実行記録 | HEAD/既存差分を記録。既存lint/typecheck/test、同一環境のbenchを実行。F1/F4/F5の再現fixtureを書く | 現行の不具合を再現し、期待する新挙動との差が明示される |
| 1 診断契約 | contracts/errors/index、security各層、toolset | 第4節の型、コード生成、有界マージ、エラー伝播 | 型互換、秘密情報非露出、既存判定不変のテストが成功 |
| 2 予算配分 | rules、必要なら新規内部budget helper | 第5節の配分とmaxSegments=1の境界修正 | 上限内の全文走査、真の不足のfail-closed、予算不変条件が成功 |
| 3 検査と切り詰め | extract-content、client | 第6節の処理順序。全文選択関数と返却整形を分離 | maxCharactersによる判定変化を解消し、短い攻撃文もガードが先行 |
| 4 Markdown | http-fetcher、validation、新規抽出と検査helper、context-guard/client | 第7節を一貫して実装 | HTTP→toolsetの構造保持、HTML混在、encoding、攻撃、上限試験成功 |
| 5 失敗の扱い | errors/client、関連テスト | 第8節の理由コードとfallback制限 | 検索0件/失敗、ページ失敗、guard、期限、取消を区別 |
| 6 文書と最終検証 | README2言語、API、SECURITY、CHANGELOG、検証記録 | 使用例、変更契約、制約を更新。第11節を実行 | 必須ゲート成功、live別記、残課題明示 |

`src/client.ts`とextract-content.tsへ処理を詰め込みすぎない。CIで対象ソースは800行未満が必要なため、増える処理は上記の目的別内部ファイルへ分ける。全体アーキテクチャのリファクタリングはしない。

## 10 必須fixtureとテスト配置

すべて合成fixtureを使う。外部サイトの本文を保存・埋め込みしない。正常fixtureはテストランナーの使い方、型引数、HTTP APIの説明など、本文不足を回避できる長さにする。攻撃fixtureは既存corpusの指示パターンを利用し、実際の秘密情報を含めない。

### 10.1 Markdown

主配置: 新規`test/retrieval/extract-markdown.test.ts`、新規`test/security/markdown-guard.test.ts`、既存http-fetcher/client-retrieval/toolsetの各テスト。

| ID | 入力・操作 | 必須の期待値 |
| --- | --- | --- |
| M01 | 見出し、入れ子リスト、コード、表、リンク、末尾2スペース、空行を含むtext/markdown | LF正規化以外は一致。字下げ、URL、空白を保持 |
| M02 | UTF-8 BOM、UTF-16 BOM、既存対応の宣言charset | 厳密にデコード。原文由来の構造を保持 |
| M03 | 不正UTF-8、未対応charset | UNSUPPORTED_CONTENT_ENCODING。成功本文なし |
| M04 | `.md`でtext/html、拡張子なしでtext/markdown | MIMEに応じた抽出。拡張子による安全扱いなし |
| M05 | Content-Type大小文字/パラメータ、custom fetcherのヘッダ不一致 | 正常正規化と既存不一致拒否を維持 |
| M06 | Markdownをreadとfetch_contentで取得 | final URL、fetchedAt、truncated、trust=untrusted、tainted=trueを維持。本文整形の二重適用なし |
| M07 | 単独攻撃、引用、fenced code内の攻撃 | GUARD_DENIED、PATTERN_DETECTED。引用/コード免除なし |
| M08 | hidden/comment/template/meta/title属性中の攻撃、タグで分断した命令 | HTML投影でも検出。拒否。raw Markdown経路へのfallbackなし |
| M09 | 無害なHTMLと`<T>`を含むコード | 予算内なら許可。HTML要素を変換し、コード内のタグはコード文字列として保持。安全なUI描画を保証しない |
| M10 | 深いHTML構造、収集上限、64,000文字超の付帯セグメント | 既存構造上限またはGUARD_DENIED。対応する上限理由を識別 |
| M11 | Markdown全文が検査上限超過、maxCharacters=200 | 返却を短くしてもGUARD_DENIED |
| M12 | 無害な長文を検査後に切り詰め、境界に絵文字 | truncated=true、上限以下、サロゲート分断なし。コードフェンスを合成しない |
| M13 | 20文字未満のMarkdown | ガードを先に完了してCONTENT_INSUFFICIENT / INSUFFICIENT_TEXT。browser呼び出し0 |
| M14 | inspectRawとreadで同じMarkdownを検査 | contentの判定/理由一致。read側のreference検査は別として比較 |

### 10.2 ガードと診断

主配置: 新規`test/security/scan-budget.test.ts`、既存context-guard/client-retrieval/errors/toolsetの各テスト。必要なら長い既存テストを目的別に分割し、無関係な期待値は変更しない。

| ID | 入力・操作 | 必須の期待値 |
| --- | --- | --- |
| G01 | visible 20,000文字、attribute 5文字を99件 | 100件・20,495文字を全文走査。無害ならallow、予算理由なし |
| G02 | 128件ちょうどと129件 | 前者は文字予算内なら全件、後者はSEGMENT_COUNT_LIMITで保留 |
| G03 | maxSegments=1で複数の非空セグメント | selectedSegmentCount=1。slice(-0)で全件選択しない |
| G04 | maxCharactersより非空セグメント数が多い | 配分0を許容、総走査数<=予算、CHARACTER_BUDGET_LIMITで拒否側 |
| G05 | 無害本文が予算ぴったりと1文字超 | 前者全文、後者fail-closed。5種類のrequestedUseを確認 |
| G06 | 多数の長短セグメント、空文字、固定seedの長さ配列 | 配分の合計/上下限、上限内の全文走査、決定性を検証 |
| G07 | 付帯セグメント64,000文字超、collection 4,097件超 | SEGMENT_TEXT_LIMITとSEGMENT_COLLECTION_LIMITを別々に確認。scanner理由と混同しない |
| G08 | 同じ文書に攻撃と走査不足の両方 | 両理由を保持。warningCategoriesが空でも上限理由で判別可能 |
| G09 | error.toJSON、compactSecurity、診断配列のmerge、未知コード/不正数値 | 詳細はモデルへ出ない。診断最大8、コード重複なし、固定順序。不正診断を除外しても元エラーと拒否判定を保持 |
| G10 | fixtureに架空secret markerを各場所へ埋める | error message/reasonCodes/diagnostics/toJSONにmarker・本文断片がない |
| G11 | 外部guardが無効値または偽のdiagnosticsを返す | 既存必須値が無効ならGUARD_FAILED。新規診断は採用せず組み込み値を保持 |
| G12 | 外部guardがallow、組み込みguardが不足 | 厳しい判定を維持。逆の場合はADDITIONAL_GUARD_RESTRICTION |
| G13 | 文字列配列や診断入力を生成後に書き換える | error/resultの保存した診断を意図せず変更できない |

### 10.3 切り詰めと実行制御

主配置: 既存client/client-retrieval/provider/toolset/internal/playwrightテスト。重複する既存試験はそのまま利用し、新しい期待条件だけを追加する。

| ID | 入力・操作 | 必須の期待値 |
| --- | --- | --- |
| C01 | plain/XML/HTML選択本文の返却上限より後ろに攻撃 | 本文全体が予算内でもGUARD_DENIED。maxCharacters=200/5,000/20,000で同じ安全判定 |
| C02 | 全文を検査できる無害長文 | 返却上限のみ切り詰め、allowかつtruncated=true |
| C03 | 攻撃のある短いHTML shell、または検査資料の解析失敗 | CONTENT_INSUFFICIENTよりguard側を優先。browser呼び出し0 |
| C04 | 無害な動的HTML shellとbrowser fixture | 既存auto fallbackが1回。未設定/利用不可なら理由付きCONTENT_INSUFFICIENT |
| C05 | Markdown/HTML/HTTP失敗/guard拒否を混ぜた検索結果 | 成功文書とページ別failuresが共存。検索失敗に置き換えない |
| C06 | providerが空配列、challenge、rate limit、timeout | 空結果は正常。challenge等は既存code/cooldown。空結果時にfallback/readしない |
| C07 | 検索5件から2件だけread | 取得回数2件。search単体の本文取得0件 |
| C08 | 全体期限、ページ期限、待機中取消、実行中取消 | 既存failure kind/部分結果/AbortSignal契約を維持 |
| C09 | SSRF、private redirect、DNS pinning、wire/decoded上限 | 既存回帰テスト成功。Markdown追加によるバイパスなし |
| C10 | 同一host/複数hostの並列、cache、in-flight共有 | 既存制御が成功。guard拒否本文をcacheへ保存しない |
| C11 | エラーからtoJSONとsearchAndRead.failures経由で取り出す | guardと通常取得失敗が機械判別可能。詳細診断の意図しないモデル流出なし |

### 10.4 HTTP経路を通る試験

custom fetcherだけで完了としない。`test/retrieval/http-fetcher.test.ts`と`scripts/guard-e2e.mjs`の既存fixture transport方式に倣い、HTTPのContent-Type判定、デコード、クライアント、toolsetまで通るMarkdown正常/攻撃/切り詰めケースを追加する。loopbackを許すために製品のSSRF判定を変更しない。テスト専用transportは固定fixture hostに限定する。

## 11 実行する検証

### 11.1 実装中の対象テスト

各フェーズで変更対象のテストを指定して実行する。第10節の全IDをテスト名またはコメントに対応付け、最終報告で未実装ケースがないことを確認する。

```sh
npx vitest run test/security/scan-budget.test.ts test/security/markdown-guard.test.ts
npx vitest run test/retrieval/extract-markdown.test.ts test/retrieval/http-fetcher.test.ts
npx vitest run test/client-retrieval.test.ts test/client.test.ts test/errors.test.ts test/tools/toolset.test.ts
```

上記の新規ファイルは計画時点では存在しない。作成後に実行する。テストファイルを別名にした場合は報告に対応表を残す。

### 11.2 最終必須ゲート

```sh
npm run format:check
npm run verify
npm run bench:ci
npm run verify:guard-corpus
npm run verify:guard-e2e
bun --bun tsc --noEmit
bun --bun vitest run
```

`npm run verify`はlint、型、通常テスト、coverage、Rust共有fixture、license、配布package、publint、型公開検証を含む。現行スクリプトを正として実行する。`scripts/verify-package.mjs`はpackしたpackageに対してrunGuardE2eを呼ぶため、`scripts/guard-e2e.mjs`へ追加したMarkdownケースがpackaged経路でも実行されたことを確認する。別の重複E2E harnessは作らない。ソース直呼び出しだけで公開版の検証としない。

Rust共有fixtureは差分なしを期待する。差分が出たら、既存攻撃判定やreasonが変わっていないか調べる。ゲートを通すためだけに自動生成ファイルを更新しない。今回の予算処理はTypeScriptの複数セグメント用で、Rustへの一律移植はしない。Rustソース変更が必要になった場合は本計画の範囲から外れるため、理由を明示して範囲を再確認する。

ブラウザruntimeが利用可能な環境では次も実行する。環境未準備ならskip理由を明示し、既存CIのChromiumゲートで成功を確認するまでブラウザ検証済みとは記載しない。

```sh
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 npx vitest run test/playwright/integration.test.ts
```

既存CIのNode/Bun/Windows packed consumer/Cargoゲートは無効化しない。依存を変えない場合でもlicense検証を通す。

### 11.3 性能と負荷

既存bench:ciの閾値を変更せず通す。新規の100セグメント偏在、件数上限、25万文字前後、HTML混在Markdownを同一環境・同一fixtureで変更前後に測る。cold/warm、実行回数、中央値またはp95、runtime、HEADを記録する。上限内で走査量が増える修正なので、CPU時間増加と検査網羅性の変化を併記する。

新規ケースは既存benchmark harnessに追加し、通常の機能テストへ環境依存のミリ秒assertを入れない。新規ケースの性能値はまず報告対象とし、測定前に都合のよい合格閾値を作らない。既存閾値超過、無限ループ、非有界なメモリ増加は完了不可。実測していない速度・精度改善は主張しない。

### 11.4 限定live確認

通常テストと分け、cache無効・readの既定ガード・render=neverで次を各1回確認する。変更前後で共通のpublic URLのみを使う。

- `https://bun.sh/docs/test.md`
- `https://bun.sh/docs/test/dom.md`
- `https://bun.sh/`
- `https://example.com`

検索は`site:bun.sh docs test runner`をDuckDuckGoで1回だけ実行する。BOT_CHALLENGE/RATE_LIMITED時に連打しない。Braveはこの作業に明示的に提供されたキーがある場合だけ使用する。既存.envや他プロジェクトから鍵を探さない。

記録する項目は、実行日時、runtime、固定の対象URLまたは検索名、contentType、成功/エラーコード、HTTP statusが得られればその値、guardDecision、guardReasonCodes、固定数値診断、truncated、経過時間。本文、snippet、title、response headers一式、error.causeを出力しない。

公開サイトが変わるため、liveでの取得成功は必須合格条件にしない。MarkdownのUNSUPPORTED_CONTENT_TYPEが解消され、その後の成功または拒否理由が説明できることを確認する。BunのHTMLが件数上限で引き続き拒否されることは、本計画では許容される結果である。

## 12 利用例とドキュメント更新

README.md/README.ja.mdには次の流れを実行可能な例として追加する。

1. 設定済みproviderで5件検索する。
2. 利用側で関連するものを選び、例では最大2件をreadする。単なるsliceは「選択の簡略例」と明示する。
3. ページ別の失敗を捕捉し、GUARD_DENIEDのguardReasonCodesとHTTP等の通常失敗を分ける。
4. ホスト向け詳細診断を、そのままモデルへ送らない。

モデルが選択する例ではtoolsetのweb_searchを使う。低レベルSearchHitをsystem promptへ連結する例を作らない。検索結果と本文は最後までuntrusted/taintedである。

docs/API.mdへMIME、文字コード、理由コード、診断の単位・上限、CONTENT_INSUFFICIENTの理由、返却切り詰めと検査不足の違いを追記する。SECURITY.mdへMarkdownのHTML混在・描画責務・検査対象の限界を記載する。CHANGELOG.mdは未公開変更として、Markdown追加、上限内の予算配分修正、診断追加、切り詰め後の未検査解消による判定変更を記す。既存の過去報告を今回の成功報告へ書き換えない。

## 13 完了判定と引き継ぎ形式

以下をすべて満たして完了とする。

- [ ] M/G/Cの全ケースがテストまたは既存テストへ対応付けられている。
- [ ] MarkdownのHTTP取得からモデル出力までの正常系がfixtureで成功する。
- [ ] 攻撃・HTML混在・真の走査不足はfail-closed、無害かつ上限内は意図せず切り捨てない。
- [ ] ガード理由が固定コードで分かり、詳細診断は有界で本文を漏らさない。
- [ ] 返却maxCharactersで未検査部分を作らず、guard拒否から別取得経路へ流れない。
- [ ] 既存の通信安全境界、期限、取消、並列制御、部分結果が回帰していない。
- [ ] 必須ゲートを実行し、成功/skip/環境制約を区別している。
- [ ] 新規実行時依存なし、MIT維持。
- [ ] 公開APIの追加項目と判定変更を文書化している。
- [ ] live結果とfixture結果を分け、速度・成功率の未測定主張がない。
- [ ] git diffで本作業の変更だけを説明でき、既存のユーザー変更を保持している。

最終報告は「変更点」「拒否原因と修正した原因」「fixture結果」「必要ゲート」「live結果」「残る制約」の順にまとめる。残る制約には、128件超での拒否、ヒューリスティックの限界、MarkdownのUI描画とURLの扱い、PDF/Officeが未対応であること、複雑な表の記録形式とMarkdown切り詰めの制約を含める。実装に着手せず調査だけで終わった場合は、完了ではなく未実装と報告する。
