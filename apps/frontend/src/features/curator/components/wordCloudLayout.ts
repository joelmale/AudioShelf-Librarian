interface WordCloudMeasurements {
  containerWidth: number;
  containerHeight: number;
  contentWidth: number;
  contentHeight: number;
  padding?: number;
}

export function calculateWordCloudScale({
  containerWidth,
  containerHeight,
  contentWidth,
  contentHeight,
  padding = 0,
}: WordCloudMeasurements): number {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    contentWidth <= 0 ||
    contentHeight <= 0
  ) {
    return 1;
  }

  const usableWidth = Math.max(1, containerWidth - padding * 2);
  const usableHeight = Math.max(1, containerHeight - padding * 2);

  return Math.min(
    1,
    usableWidth / contentWidth,
    usableHeight / contentHeight,
  );
}
