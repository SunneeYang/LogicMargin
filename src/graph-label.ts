export function measureEdgeLabel(text: string, maxWidth = 180) {
  const lines: string[] = []
  let line = '', width = 0, widest = 0
  const finish = () => { lines.push(line); widest = Math.max(widest, width); line = ''; width = 0 }
  for (const character of text) {
    if (character === '\n') { finish(); continue }
    const advance = character.codePointAt(0)! > 255 ? 12 : 7
    if (line && width + advance > maxWidth) finish()
    line += character
    width += advance
  }
  finish()
  return { lines, width: widest + 12, height: lines.length * 16 + 8 }
}
