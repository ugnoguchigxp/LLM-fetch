# Responsible use and privacy

`llm-fetch` sends a search query to the configured provider. Reading a result contacts the target site, which can observe the caller's IP address, User-Agent, access time, requested path, and normal transport metadata. Browser mode additionally executes third-party JavaScript in a fresh, non-persistent context.

Before production use:

- review the search provider's and target site's current terms and acceptable-use rules;
- respect robots guidance, rate limits, `Retry-After`, and reasonable per-host request rates;
- determine whether queries, URLs, pages, or extracted text contain personal or regulated data;
- establish a lawful basis, retention policy, and deletion process where required;
- respect copyright, database rights, access controls, and attribution requirements;
- do not use browser mode with authenticated profiles, application cookies, secrets, Node.js bindings, or high-impact tools;
- preserve taint and provenance metadata and require independent authorization before writes, messages, code execution, memory changes, or policy changes.

DuckDuckGo support is experimental, opt-in, and best effort. It uses public web representations rather than a stable official application API. DuckDuckGo's own parameter guidance describes these settings as intended for individual use and directs app or extension use toward its partnership contact. Bot challenges, rate limits, and layout changes are expected failure modes. Confirm the terms for the intended deployment; Brave or a reviewed custom provider is the recommended production route when contractual stability is required.

## 日本語要約

検索語は選択した検索providerへ送信されます。ページ取得時には、利用者のIPアドレス、User-Agent、アクセス時刻、pathなどが取得先siteへ伝わります。browser modeでは第三者JavaScriptも実行します。

本番利用前に、providerとsiteの最新の利用条件、robots、アクセス頻度、`Retry-After`、個人情報、保存期間、削除手順、著作権、出典表示を確認してください。認証済みprofile、Cookie、secret、Node.js binding、高権限toolをbrowser modeへ渡さず、書き込み、外部送信、コード実行、memoryやpolicyの変更には別の承認手順を設けてください。
