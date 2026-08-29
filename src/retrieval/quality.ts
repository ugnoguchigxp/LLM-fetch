export interface ContentQuality {
  score: number;
  characterCount: number;
  paragraphCount: number;
  linkDensity: number;
}

export function scoreContentMetrics(input: {
  characterCount: number;
  paragraphCount: number;
  linkTextLength: number;
}): ContentQuality {
  const characterCount = input.characterCount;
  const linkDensity = characterCount === 0
    ? 1
    : Math.min(1, input.linkTextLength / characterCount);
  const score =
    Math.min(characterCount, 20_000) +
    Math.min(input.paragraphCount, 20) * 120 -
    Math.round(linkDensity * Math.min(characterCount, 10_000));
  return {
    score,
    characterCount,
    paragraphCount: input.paragraphCount,
    linkDensity,
  };
}

export function scoreContentCandidate(input: {
  text: string;
  paragraphCount: number;
  linkTextLength: number;
}): ContentQuality {
  return scoreContentMetrics({
    characterCount: input.text.length,
    paragraphCount: input.paragraphCount,
    linkTextLength: input.linkTextLength,
  });
}
