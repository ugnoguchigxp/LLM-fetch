(() => {
  "use strict";
  const global = globalThis;
  const captured = global.__LLM_FETCH_BOOTSTRAP__;
  if (!captured) return;
  const {
    arrayFrom, arrayIncludes, arrayJoin, arrayPop, arrayPush, arraySlice,
    attributes, attributeAt, attributeCount, attributeName, attributeValue,
    childAt, childCount, childNodes, defineProperty,
    documentElement, elementGetAttribute, elementHasAttribute, encode, freeze,
    getComputedStyle, jsonStringify, localName, mathCeil, nodeType, nodeValue, number, string,
    stringIncludes, stringReplace, stringSlice, stringStartsWith, stringToLowerCase, stringTrim,
    styleProperty, templateContent,
  } = captured;

  const normalize = (value) => stringTrim(stringReplace(string(value || ""), /\s+/gu, " "));
  const ignoredElementNames = freeze([
    "script", "style", "noscript", "iframe", "object", "embed", "svg", "canvas", "video", "audio",
  ]);
  const codePoints = (value) => arrayFrom(value);
  const bounded = (value, maximum, preserveTail = false) => {
    const raw = string(value || "");
    const sampleLimit = maximum * 2 + 2;
    const rawTruncated = raw.length > sampleLimit;
    const prefix = rawTruncated ? stringSlice(raw, 0, sampleLimit) : raw;
    const prefixPoints = codePoints(normalize(prefix));
    const normalizedTruncated = prefixPoints.length > maximum;
    const truncated = rawTruncated || normalizedTruncated;
    let text;
    if (!truncated) {
      text = arrayJoin(prefixPoints, "");
    } else if (!preserveTail) {
      text = arrayJoin(arraySlice(prefixPoints, 0, maximum), "");
    } else {
      const headLength = mathCeil(maximum / 2);
      const tailLength = maximum - headLength;
      const suffix = rawTruncated ? stringSlice(raw, -sampleLimit) : prefix;
      const suffixPoints = rawTruncated ? codePoints(normalize(suffix)) : prefixPoints;
      const head = arraySlice(prefixPoints, 0, headLength);
      const tail = tailLength > 0
        ? arraySlice(suffixPoints, suffixPoints.length - tailLength)
        : [];
      text = arrayJoin(head, "") + arrayJoin(tail, "");
    }
    return {
      text,
      originalLength: rawTruncated ? maximum + 1 : prefixPoints.length,
      truncated,
    };
  };
  const hiddenStyle = (element) => {
    if (
      elementHasAttribute(element, "hidden") ||
      elementHasAttribute(element, "inert") ||
      stringToLowerCase(bounded(elementGetAttribute(element, "aria-hidden") || "", 16).text) === "true" ||
      (localName(element) === "input" &&
        stringToLowerCase(bounded(elementGetAttribute(element, "type") || "", 16).text) === "hidden") ||
      (localName(element) === "dialog" && !elementHasAttribute(element, "open"))
    ) {
      return true;
    }
    if (!getComputedStyle) return false;
    try {
      const style = getComputedStyle(element);
      return (
        styleProperty(style, "display") === "none" ||
        styleProperty(style, "visibility") === "hidden" ||
        styleProperty(style, "visibility") === "collapse" ||
        styleProperty(style, "content-visibility") === "hidden" ||
        number(styleProperty(style, "opacity")) === 0
      );
    } catch (_) {
      return true;
    }
  };

  const install = (options) => {
    const reasons = [];
    const addReason = (value) => {
      if (!arrayIncludes(reasons, value)) {
        arrayPush(reasons, value);
      }
    };
    const segments = [];
    const addSegment = (location, value, allowEmpty = false) => {
      if (segments.length >= options.maxSegments) {
        addReason("segment_limit");
        return -1;
      }
      const result = bounded(value, options.maxSegmentCharacters, true);
      if (!result.text && !result.truncated && !allowEmpty) return -1;
      if (result.truncated) addReason("segment_text_limit");
      const parts = result.truncated ? null : result.text ? [result.text] : [];
      arrayPush(segments, { location, ...result, parts });
      return segments.length - 1;
    };
    const appendSegment = (index, value) => {
      if (index < 0 || !value) return;
      const current = segments[index];
      if (current.truncated) return;
      const addition = bounded(value, options.maxSegmentCharacters, true);
      if (!addition.text && !addition.truncated) return;
      const separator = current.originalLength > 0 && addition.originalLength > 0 ? 1 : 0;
      current.originalLength += separator + addition.originalLength;
      if (addition.text) arrayPush(current.parts, addition.text);
      if (addition.truncated || current.originalLength > options.maxSegmentCharacters) {
        current.text = bounded(
          arrayJoin(current.parts, " "),
          options.maxSegmentCharacters,
          true,
        ).text;
        current.parts = null;
        current.truncated = true;
        addReason("segment_text_limit");
      }
    };
    const visible = [];
    let visibleCharacters = 0;
    let nodeCount = 0;
    let candidateCount = 0;
    let attributesVisited = 0;
    let openGraphTitle = null;
    let firstHeading = null;
    let hasCaptchaOrChallengeFrame = false;
    let hasRecaptchaMarker = false;
    let hasHcaptchaMarker = false;
    let hasForm = false;
    let hasInput = false;
    const capturedDocumentTitle = bounded(document.title || "", 1001, true);
    const root = documentElement();
    const stack = root
      ? [{ node: root, depth: 0, hidden: false, hiddenSegment: -1, heading: false }]
      : [];
    const maxAttributes = options.maxSegments * 32;
    const pushChildren = (parent, depth, hidden, hiddenSegment, heading) => {
      const children = childNodes(parent);
      const count = childCount(children);
      const remaining = options.maxDomNodes - nodeCount - stack.length;
      const selected = count < remaining ? count : remaining > 0 ? remaining : 0;
      if (selected < count) addReason("dom_node_limit");
      for (let index = selected - 1; index >= 0; index -= 1) {
        const child = childAt(children, index);
        if (child) {
          arrayPush(stack, { node: child, depth, hidden, hiddenSegment, heading });
        }
      }
    };

    while (stack.length > 0) {
      const frame = arrayPop(stack);
      const node = frame.node;
      if (nodeCount >= options.maxDomNodes) {
        addReason("dom_node_limit");
        break;
      }
      nodeCount += 1;
      if (frame.depth > options.maxDomDepth) {
        addReason("dom_depth_limit");
        continue;
      }
      if (nodeType(node) === 8) {
        addSegment("comment", nodeValue(node));
        continue;
      }
      if (nodeType(node) === 3) {
        const value = nodeValue(node);
        const probe = bounded(value, 1);
        if (!probe.text && !probe.truncated) continue;
        if (frame.heading && (!firstHeading || codePoints(firstHeading.text).length <= 1000)) {
          const nextHeading = bounded(`${firstHeading?.text || ""} ${value}`, 1001, true);
          if (firstHeading?.truncated) nextHeading.truncated = true;
          firstHeading = nextHeading;
        }
        if (frame.hidden) {
          appendSegment(frame.hiddenSegment, value);
          continue;
        }
        if (candidateCount >= options.maxCandidates) {
          addReason("candidate_limit");
          continue;
        }
        candidateCount += 1;
        const remaining = options.maxCharacters - visibleCharacters;
        if (remaining <= 0) {
          addReason("text_limit");
          continue;
        }
        const part = bounded(value, remaining);
        arrayPush(visible, part.text);
        visibleCharacters += codePoints(part.text).length;
        if (part.truncated) addReason("text_limit");
        continue;
      }
      if (nodeType(node) !== 1) continue;

      const element = node;
      const elementNameResult = bounded(localName(element), 64);
      if (elementNameResult.truncated) {
        addReason("segment_limit");
        continue;
      }
      const elementName = elementNameResult.text;
      const marker = stringToLowerCase(bounded(
        `${bounded(elementGetAttribute(element, "id") || "", 128).text} ` +
        `${bounded(elementGetAttribute(element, "class") || "", 128).text} ` +
        `${bounded(elementGetAttribute(element, "src") || "", 128).text} ` +
        `${bounded(elementGetAttribute(element, "title") || "", 128).text}`,
        512,
      ).text);
      if (elementName === "form") hasForm = true;
      if (elementName === "input") hasInput = true;
      if (
        elementName === "iframe" &&
        (stringIncludes(marker, "captcha") || stringIncludes(marker, "challenge"))
      ) {
        hasCaptchaOrChallengeFrame = true;
      }
      if (stringIncludes(marker, "recaptcha") || stringIncludes(marker, "g-recaptcha")) {
        hasRecaptchaMarker = true;
      }
      if (stringIncludes(marker, "hcaptcha") || stringIncludes(marker, "h-captcha")) {
        hasHcaptchaMarker = true;
      }
      if (arrayIncludes(ignoredElementNames, elementName)) continue;
      const startsHidden = !frame.hidden && hiddenStyle(element);
      const isHidden = frame.hidden || startsHidden;
      let hiddenSegment = frame.hiddenSegment;
      if (startsHidden) hiddenSegment = addSegment("hidden", "", true);

      if (elementName === "meta") {
        const content = elementGetAttribute(element, "content");
        addSegment("meta", content);
        if (
          openGraphTitle === null &&
          stringToLowerCase(bounded(elementGetAttribute(element, "property") || "", 128).text) === "og:title"
        ) {
          const candidate = bounded(content, 1001, true);
          if (candidate.text) openGraphTitle = candidate;
        }
      }
      const attributeList = attributes(element);
      const count = attributeCount(attributeList);
      for (let index = 0; index < count; index += 1) {
        if (attributesVisited >= maxAttributes) {
          addReason("segment_limit");
          break;
        }
        attributesVisited += 1;
        const attribute = attributeAt(attributeList, index);
        if (!attribute) continue;
        const nameResult = bounded(attributeName(attribute), 128);
        if (nameResult.truncated) {
          addReason("segment_limit");
          continue;
        }
        const name = stringToLowerCase(nameResult.text);
        if (
          name === "alt" ||
          name === "title" ||
          name === "aria-label" ||
          stringStartsWith(name, "data-") ||
          (elementName === "input" && name === "value")
        ) {
          addSegment("attribute", attributeValue(attribute));
        }
      }
      if (elementName === "template") {
        const content = templateContent(element);
        const templateSegment = addSegment("template", "", true);
        if (content) {
          pushChildren(content, frame.depth + 1, true, templateSegment, false);
        }
        continue;
      }
      const heading = frame.heading || (!isHidden && !firstHeading?.text && elementName === "h1");
      pushChildren(element, frame.depth + 1, isHidden, hiddenSegment, heading);
    }

    const visibleParts = [];
    for (const part of visible) if (part) arrayPush(visibleParts, part);
    const nonEmptySegments = [];
    for (const segment of segments) {
      const text = segment.parts ? arrayJoin(segment.parts, " ") : segment.text;
      if (text) {
        arrayPush(nonEmptySegments, {
          location: segment.location,
          text,
          originalLength: segment.originalLength,
          truncated: segment.truncated,
        });
      }
    }
    const titleCandidate = openGraphTitle
      ? openGraphTitle
      : capturedDocumentTitle.text
        ? capturedDocumentTitle
        : firstHeading?.text
          ? firstHeading
          : bounded(string(location.hostname || ""), 1001, true);
    const selectedTitle = bounded(titleCandidate.text, 1000);
    if (titleCandidate.truncated || selectedTitle.truncated) {
      addReason("text_limit");
    }
    const payload = {
      title: selectedTitle.text,
      text: arrayJoin(visibleParts, "\n"),
      finalUrl: string(location.href),
      contentType: bounded(document.contentType || "text/html", 64).text,
      language: root ? bounded(elementGetAttribute(root, "lang") || "", 64).text || null : null,
      nodeCount,
      candidateCount,
      truncated: reasons.length > 0,
      truncationReasons: reasons,
      securitySegments: nonEmptySegments,
      hasCaptchaOrChallengeFrame,
      hasRecaptchaMarker,
      hasHcaptchaMarker,
      hasForm,
      hasInput,
    };

    const size = () => encode(jsonStringify(payload)).byteLength;
    if (size() > options.maxPayloadBytes && payload.securitySegments.length > 0) {
      addReason("segment_limit");
      payload.truncated = true;
      const allSegments = payload.securitySegments;
      let low = 0;
      let high = allSegments.length;
      while (low < high) {
        const middle = mathCeil((low + high) / 2);
        payload.securitySegments = arraySlice(allSegments, 0, middle);
        if (size() <= options.maxPayloadBytes) low = middle;
        else high = middle - 1;
      }
      payload.securitySegments = arraySlice(allSegments, 0, low);
    }
    if (size() > options.maxPayloadBytes && payload.text) {
      addReason("text_limit");
      payload.truncated = true;
      const points = codePoints(payload.text);
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = mathCeil((low + high) / 2);
        payload.text = arrayJoin(arraySlice(points, 0, middle), "");
        if (size() <= options.maxPayloadBytes) low = middle;
        else high = middle - 1;
      }
      payload.text = arrayJoin(arraySlice(points, 0, low), "");
    }
    payload.truncated = reasons.length > 0;
    return payload;
  };

  try {
    defineProperty(global, "__LLM_FETCH_EXTRACT__", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: freeze(install),
    });
  } catch (_) {}
})();
