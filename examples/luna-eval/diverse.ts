import type { Scenario } from "./contracts.ts";

// Additive cohort: the original twenty and their criteria remain unchanged.
const live = (
  id: string,
  category: string,
  request: string,
  referenceUrls: string[],
  criteria: string[],
): Scenario => ({
  id,
  category,
  request,
  referenceUrls,
  mode: "live",
  fixture: null,
  expectedEvidence: "sufficient",
  criteria: criteria.map((description, i) => ({ id: `c${i + 1}`, description })),
});
const fixture = (
  id: string,
  category: string,
  request: string,
  expectedEvidence: Scenario["expectedEvidence"],
  criteria: string[],
): Scenario => ({
  ...live(id, category, request, [], criteria),
  mode: "fixture",
  fixture: id,
  expectedEvidence,
});

export const diverseScenarios: Scenario[] = [
  live(
    "museum-opening",
    "daily-service",
    "東京国立博物館の展示エリアについて、基本の開館時間、入館締切、月曜が祝日の場合の休館ルールを公式案内で確認してください。特定の日の臨時変更ではなく、基本ルールを知りたいです。",
    ["https://www.tnm.jp/modules/r_free_page/index.php?id=113-0"],
    [
      "基本の開館時間は9:30〜17:00、入館は閉館30分前までと示す。",
      "月曜が祝日・休日なら開館して翌平日が休館とし、毎週月曜に必ず閉館とは断定しない。",
      "展示エリアと資料館を混同せず、公式の取得本文に基づき、時間延長や臨時変更があることにも配慮する。",
    ],
  ),
  live(
    "railway-hand-luggage",
    "travel-limits",
    "JR東海の公式案内で、一般の手荷物を無料で持ち込める個数、大きさ、重量と、傘などを個数に含めるか確認してください。ペットや特大荷物の予約の話とは分けてください。",
    ["https://global.jr-central.co.jp/en/tickets/type/belongings.html"],
    [
      "一般の手荷物は2個までで、三辺合計250cm以内、長さ2mまで、重量30kg以内という上限を区別する。",
      "傘・つえ・ハンドバッグ等の身の回り品はその個数に数えないと説明する。",
      "ペットの有料扱いや特大荷物の予約条件と一般手荷物の上限を取り違えず、公式本文を根拠にする。",
    ],
  ),
  live(
    "washoku-heritage",
    "culture-classification",
    "和食がユネスコに登録された年と登録の種類を教えてください。特定の料理が世界遺産になったという理解でよいか、農林水産省の説明で確認してください。",
    ["https://www.maff.go.jp/j/keikaku/syokubunka/ich/index.html"],
    [
      "2013年にユネスコ無形文化遺産に登録と答える。",
      "建造物などの世界遺産や特定の料理そのものではなく、日本人の伝統的な食文化・社会的慣習の登録と区別する。",
      "自然の尊重や食に関する知識・技能・習わしを取得した公式本文に基づいて説明する。",
    ],
  ),
  live(
    "hayabusa2-return",
    "science-entity",
    "はやぶさ2が持ち帰った試料はイトカワのものですか。天体名、カプセルが地球に戻った日付と回収された国をJAXAの情報で確認してください。",
    ["https://www.jaxa.jp/projects/sas/hayabusa2/"],
    [
      "はやぶさ2の試料はリュウグウであり、初代はやぶさのイトカワと混同しない。",
      "カプセルの帰還は2020年12月6日、回収はオーストラリアと示す。",
      "カプセルの帰還と探査機本体の継続航行を区別し、取得したJAXA本文を根拠にする。",
    ],
  ),
  fixture(
    "misleading-snippet",
    "snippet-body-mismatch",
    "Miraの2026年版無料プランで使える保存容量を、本文の根拠を添えて教えてください。",
    "sufficient",
    [
      "本文にある2 GBと答え、検索説明の20 GBを採用しない。",
      "2026年版の無料プランであることを保ち、取得した本文を引用する。",
    ],
  ),
  fixture(
    "same-name-product",
    "entity-disambiguation",
    "North社のBeacon Homeの電池持続時間を調べてください。South社の同名製品やBeacon Proの値で代用しないでください。",
    "sufficient",
    [
      "North社Beacon Homeの電池持続時間は18時間と答える。",
      "South社の72時間やNorth社Beacon Proの48時間を対象の値として使わない。",
      "対象の製品本文を実際に取得して引用する。",
    ],
  ),
  fixture(
    "distributed-evidence",
    "multi-document-join",
    "Cedar Teamの月額料金、保存容量、保持日数、税込かどうかを一行の表にまとめ、各値の根拠を示してください。",
    "sufficient",
    [
      "月額1500円、50 GB、90日、税込を同じTeamプランに対応づける。",
      "一つの資料だけで全項目を確認できたとせず、四つの取得本文で必要な値を裏付ける。",
      "依頼された表形式で示し、根拠URLと主張を対応させる。",
    ],
  ),
  fixture(
    "delayed-correction",
    "late-evidence",
    "Kite 5の初報と正式な訂正情報を両方確認し、配送開始日の違いと最終的な日付を教えてください。",
    "sufficient",
    [
      "初報の2026年11月2日と訂正の2026年11月16日を区別する。",
      "正式訂正が初報を更新しており、最終日は11月16日と説明する。",
      "初報だけで終了せず、遅れて届く訂正本文も実際に取得して引用する。",
    ],
  ),
  fixture(
    "slow-leading-pair",
    "slow-candidates",
    "Sora Packの標準モデルの容量を、取得できた製品仕様の本文で確認してください。",
    "sufficient",
    [
      "標準モデルは24リットルと本文に基づいて答える。",
      "取得完了していない先行ページではなく、実際に取得できた仕様ページを引用する。",
    ],
  ),
  fixture(
    "unresolved-conflict",
    "unresolved-conflict",
    "Larch Boxの保証期間を断定できますか。二つの同日付の公式資料が食い違う場合は、その内容と判断できない点を示してください。",
    "insufficient",
    [
      "同じ2026年10月1日付の資料に保証1年と3年の記載があると出典ごとに示す。",
      "どちらが優先か判定材料がなく、一方を確定値として採用しない。",
      "不足・未解決の矛盾を明示し、insufficientEvidenceをtrueにする。",
    ],
  ),
  fixture(
    "tail-specification",
    "long-document-tail",
    "Aster Hubの同時接続数の上限と、その上限がサーバー全体かワークスペース単位かを本文で確認してください。",
    "sufficient",
    [
      "本文末尾の最大320接続と答える。",
      "上限はワークスペース単位であり、サーバー全体の上限とは説明しない。",
      "長い本文の途中で確認を打ち切って不明とせず、実際に取得した該当本文を引用する。",
    ],
  ),
  fixture(
    "zero-and-units",
    "table-zero-units",
    "ElmのBasicとPlusを、タイムアウトの秒数と再試行回数で表にして比較してください。0回の意味にも注意してください。",
    "sufficient",
    [
      "Basicの500 msを0.5秒、Plusの2000 msを2秒として対応を保つ。",
      "Basicの再試行0回は無制限ではなく再試行しないこと、Plusは3回と示す。",
      "表形式と単位を保ち、取得した仕様本文で根拠を示す。",
    ],
  ),
  fixture(
    "short-html-fact",
    "short-html",
    "Nilo Tagに保存できるタグの件数を、仕様本文で確認してください。",
    "sufficient",
    [
      "本文にある保存可能タグ数64件と答える。",
      "実際に取得した仕様本文を根拠にし、未取得の検索説明で答えない。",
    ],
  ),
];
