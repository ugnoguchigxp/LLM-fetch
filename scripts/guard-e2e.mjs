import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  technicalAttackCorpus,
  technicalBenignCorpus,
} from "../test/fixtures/technical-guard-corpus.js";

// Real loopback HTTP fixtures behind the documented fetcher injection point.
// The mapping is test-only; production outbound address checks are unchanged.
export async function runGuardE2e({ createLlmFetch }) {
  const cases = [...technicalBenignCorpus, ...technicalAttackCorpus];
  let requests = 0;
  const server = http.createServer((request, response) => {
    const [, format, index] = request.url.split("/");
    const fixture = cases[Number(index)];
    if (!fixture || !["plain", "html", "hidden"].includes(format)) {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    const text = `Technical reference material for the reader. This document contains factual information about computational experiments and their results. ${fixture.body}`;
    response.setHeader("content-type", format === "plain" ? "text/plain" : "text/html");
    response.end(
      format === "plain"
        ? text
        : `<html><head><title>Technical reference</title></head><body><main><p>${format === "hidden" ? "Public factual material about computational experiments. This visible paragraph provides enough text for the extraction process." : text}</p>${format === "hidden" ? `<div hidden>${fixture.body}</div>` : ""}</main></body></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const fetcher = async (url, input = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "http://fixture.example");
    const response = await fetch(`http://127.0.0.1:${port}${parsed.pathname}`, {
      signal: input.signal,
    });
    const contentType = response.headers.get("content-type");
    return {
      requestedUrl: url,
      finalUrl: url,
      status: response.status,
      contentType,
      headers: { "content-type": contentType },
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  const minimal = [
    0,
    1,
    2,
    3,
    ...Array.from({ length: 4 }, (_, i) => technicalBenignCorpus.length + i),
  ];
  const client = createLlmFetch({
    fetcher,
    cache: { enabled: false },
    search: {
      name: "fixture",
      async search() {
        return minimal.map((index, rank) => ({
          provider: "fixture",
          title: "Technical reference",
          url: `http://fixture.example/html/${index}`,
          snippet:
            index < technicalBenignCorpus.length ? cases[index].body : "Public research material.",
          rank: rank + 1,
        }));
      },
    },
  });
  let allowed = 0;
  let withheld = 0;
  try {
    for (const format of ["plain", "html", "hidden"]) {
      for (const [index, fixture] of cases.entries()) {
        const read = () =>
          client.read({
            url: `http://fixture.example/${format}/${index}`,
            requestedUse: "extract_facts",
          });
        if (fixture.minimumDecision) {
          await assert.rejects(
            read,
            { code: "GUARD_DENIED", guardDecision: "require_approval" },
            `${format}/${fixture.name}`,
          );
          withheld += 1;
        } else {
          const document = await read();
          assert.equal(document.security.trust, "untrusted");
          assert.equal(document.security.tainted, true);
          assert.equal(document.security.decision, "allow", `${format}/${fixture.name}`);
          if (format !== "hidden")
            assert.ok(
              document.text.includes(fixture.body.replace(/\s+/g, " ")) ||
                document.text.includes(fixture.body),
            );
          allowed += 1;
        }
      }
    }
    const result = await client.searchAndRead({
      query: "technical memory",
      limit: 8,
      requestedUse: "extract_facts",
    });
    assert.equal(result.documents.length, 4);
    assert.equal(result.failures.length, 4);
    assert.ok(
      result.documents.every(
        (document) =>
          document.source?.provider === "fixture" && document.source.query === "technical memory",
      ),
    );
    assert.ok(result.failures.every((failure) => failure.error.code === "GUARD_DENIED"));
    const bounded = createLlmFetch({ fetcher, contextGuard: { maxCharacters: 8 } });
    try {
      await assert.rejects(
        () =>
          bounded.read({ url: "http://fixture.example/plain/0", requestedUse: "extract_facts" }),
        { code: "GUARD_DENIED", guardDecision: "require_approval" },
      );
      await assert.rejects(
        () => bounded.read({ url: "http://fixture.example/plain/0", requestedUse: "search_more" }),
        { code: "GUARD_DENIED", guardDecision: "deny" },
      );
    } finally {
      await bounded.close();
    }
    return {
      allowed,
      withheld,
      searchDocuments: result.documents.length,
      searchFailures: result.failures.length,
      requests,
    };
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = await import(
    process.argv[2] ? pathToFileURL(process.argv[2]).href : "../dist/index.js"
  );
  console.log(JSON.stringify(await runGuardE2e(api), null, 2));
}
