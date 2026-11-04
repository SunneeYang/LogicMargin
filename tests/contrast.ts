// Resolve translucent surfaces against every authored gradient stop.
export function readContrastPairs(pairs: string[][]) {
  const context = document.createElement('canvas').getContext('2d')!;
  const rgba = (value: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const blend = (front: number[], back: number[]) => front.slice(0, 3).map((channel, i) =>
    channel * front[3] / 255 + back[i] * (1 - front[3] / 255));
  const luminance = (channels: number[]) => {
    const linear = channels.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const root = getComputedStyle(document.documentElement);
  return pairs.map(([foreground, background, property = 'color']) => {
    const element = document.querySelector<HTMLElement>(foreground)!;
    const parents = [];
    for (let parent = document.querySelector<HTMLElement>(background); parent; parent = parent.parentElement) parents.unshift(parent);
    let backgrounds = [[255, 255, 255]];
    // A portalled glass discussion also sees the canvas beneath it.
    if (element.closest('.comment-composer.is-inline') && document.documentElement.dataset.theme === 'glass') {
      backgrounds = ['--color-glass-cool', '--color-paper', '--color-glass-warm'].map(token => rgba(root.getPropertyValue(token)));
      parents.splice(0, parents.findIndex(parent => parent.classList.contains('comment-composer')));
    }
    for (const parent of parents) {
      const style = getComputedStyle(parent);
      const fills = style.backgroundImage.startsWith('linear-gradient')
        ? ['--color-glass-cool', '--color-paper', '--color-glass-warm'].map(token => rgba(root.getPropertyValue(token)))
        : [rgba(style.backgroundColor)];
      backgrounds = backgrounds.flatMap(back => fills.map(fill => blend(fill, back)));
    }
    const ink = rgba(getComputedStyle(element).getPropertyValue(property));
    const ratios = backgrounds.map(back => {
      const values = [luminance(blend(ink, back)), luminance(back)].sort((a, b) => b - a);
      return (values[0] + .05) / (values[1] + .05);
    });
    return {selector: foreground, value: Math.min(...ratios)};
  });
}
