export function selectSegmentIndexes(count: number, maxSegments: number): number[] {
  if (count <= maxSegments) {
    return Array.from({ length: count }, (_value, index) => index);
  }
  const headCount = Math.ceil(maxSegments / 2);
  const tailCount = Math.floor(maxSegments / 2);
  const indexes: number[] = [];
  for (let index = 0; index < headCount; index += 1) indexes.push(index);
  if (tailCount > 0) {
    for (let index = count - tailCount; index < count; index += 1) indexes.push(index);
  }
  return indexes;
}

export function allocateCharacterBudgets(lengths: readonly number[], budget: number): number[] {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= budget) return [...lengths];

  let low = 0;
  let high = budget;
  let quota = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let used = 0;
    let fits = true;
    for (const length of lengths) {
      used += Math.min(length, middle);
      if (used > budget) {
        fits = false;
        break;
      }
    }
    if (fits) {
      quota = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const allocations = lengths.map((length) => Math.min(length, quota));
  let remainder = budget - allocations.reduce((sum, length) => sum + length, 0);
  for (let index = 0; index < lengths.length && remainder > 0; index += 1) {
    const length = lengths[index] ?? 0;
    const allocation = allocations[index] ?? 0;
    if (allocation < length) {
      allocations[index] = allocation + 1;
      remainder -= 1;
    }
  }
  return allocations;
}

export function textForBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  const headLength = Math.ceil(budget / 2);
  const tailLength = Math.floor(budget / 2);
  const tail = tailLength > 0 ? text.slice(text.length - tailLength) : "";
  return `${text.slice(0, headLength)}${tail}`;
}
