import { parser } from '@lezer/javascript'
import { IterMode } from '@lezer/common'
import type { SyntaxNode } from '@lezer/common'

type Token = { from: number; to: number; key: string; boundary?: boolean }
type Scope = { kind: string; name: string; from: number; to: number; shape: string }
const maxNodes = 50_000
const maxDepth = 256
const syntax = new Error('invalid-syntax')
const budget = new Error('budget')
const whitespace = /^\s*$/u
const linebreak = /[\r\n\u2028\u2029]/u
const restricted = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async', '++', '--'])
const restrictedBefore = new Set(['async', '++', '--'])
const typescriptNodes = /^(?:Type|Interface|Enum|Namespace|Ambient|Abstract|Implements|Accessibility|Readonly|NonNull|AsExpression|Satisfies)/u

function directName(node: SyntaxNode, type: string, source: string) {
  const name = node.getChild(type)
  return name ? source.slice(name.from, name.to) : ''
}

function syntaxParent(node: SyntaxNode) {
  let parent = node.parent
  while (parent?.type.isAnonymous) parent = parent.parent
  return parent
}

function fileDeclaration(node: SyntaxNode) {
  let parent = syntaxParent(node)
  if (parent?.name === 'ExportDeclaration') parent = syntaxParent(parent)
  return parent?.name === 'Script'
}

function parseSource(source: string, language: string) {
  if (source.length > 100_000 || (source.match(/\r\n|[\r\n\u2028\u2029]/gu)?.length ?? 0) >= 2_000) throw budget
  const dialect = language === 'tsx' ? 'ts jsx' : language === 'ts' ? 'ts' : language === 'jsx' ? 'jsx' : ''
  const typescript = language === 'ts' || language === 'tsx'
  const tree = parser.configure({ dialect }).parse(source)
  const cursor = tree.cursor(IterMode.IncludeAnonymous)
  const tokens: Token[] = []
  const scopes: Scope[] = []
  const shape: string[] = []
  let nodes = 0
  function token(from: number, to: number, kind: string) {
    if (from === to) return
    if (tokens.length >= maxNodes) throw budget
    tokens.push({ from, to, key: `${kind}:${source.slice(from, to)}` })
  }
  function walk(depth: number, inFunction: boolean, className: string) {
    if (++nodes > maxNodes || depth > maxDepth) throw budget
    if (cursor.type.isError) throw syntax
    const { name, from, to } = cursor
    // The grammar deliberately accepts some TS productions even without its ts dialect.
    if (!typescript && typescriptNodes.test(name)) throw syntax
    if (!typescript && name === 'PostfixExpression' && directName(cursor.node, 'LogicOp', source) === '!') throw syntax
    const shapeFrom = shape.length
    const template = name === 'TemplateString' || name === 'TemplateType'
    // Anonymous repetition containers change with tree packing, even for pure formatting.
    const anonymous = cursor.type.isAnonymous
    if (!anonymous) shape.push(`(${JSON.stringify(name)}`)
    const isFunction = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration'].includes(name)
    if (name === 'ArrowFunction') {
      const async = cursor.node.getChild('async'), params = cursor.node.getChild('ParamList')
      if (async && params && linebreak.test(source.slice(async.to, params.from))) throw syntax
    }
    let scopeName = '', kind = 'function'
    // Block-local declarations lack binding context in the scope contract.
    if (!inFunction && name === 'FunctionDeclaration' && syntaxParent(cursor.node)?.name === 'Script') {
      scopeName = directName(cursor.node, 'VariableDefinition', source)
    } else if (!inFunction && name === 'ExportDeclaration' && syntaxParent(cursor.node)?.name === 'Script') {
      const declaration = cursor.node.getChild('FunctionDeclaration')
      if (declaration) scopeName = directName(declaration, 'VariableDefinition', source)
    } else if (!inFunction && name === 'MethodDeclaration' && className && syntaxParent(cursor.node)?.name === 'ClassBody' && !cursor.node.getChild('Decorator') && !cursor.node.getChild('[') && cursor.node.getChild('Block')) {
      const method = directName(cursor.node, 'PropertyDefinition', source) || directName(cursor.node, 'PrivatePropertyDefinition', source)
      if (method) {
        scopeName = `${className}.${method}`
        kind = 'method'
      }
    }
    if (name === 'ClassDeclaration' || name === 'ClassExpression') {
      className = name === 'ClassDeclaration' && fileDeclaration(cursor.node) && !cursor.node.getChild('Decorator') ? directName(cursor.node, 'VariableDefinition', source) : ''
    }
    if (cursor.firstChild()) {
      let end = from
      do {
        // Lezer exposes interpolations but omits the template's raw text and delimiters.
        if (template) token(end, cursor.from, 'TemplateText')
        walk(depth + 1, inFunction || isFunction || !!scopeName, className)
        end = cursor.to
      } while (cursor.nextSibling())
      if (template) token(end, to, 'TemplateText')
      cursor.parent()
    } else {
      // Keep even all-whitespace JSXText/template leaves, as these are user data.
      if (anonymous) shape.push(`(anonymous:${cursor.type.id})`)
      if (name !== 'Script') token(from, to, name || `anonymous:${cursor.type.id}`)
    }
    if (!anonymous) shape.push(')')
    if (scopeName) scopes.push({ kind, name: scopeName, from, to, shape: shape.slice(shapeFrom).join('') })
  }
  walk(0, false, '')
  let end = 0
  let previous: Token | undefined
  const bounded: Token[] = []
  for (const current of tokens) {
    if (current.from < end || current.to < current.from || current.to > source.length || !whitespace.test(source.slice(end, current.from))) throw syntax
    const comment = current.key.startsWith('LineComment:') || current.key.startsWith('BlockComment:')
    if (!comment) {
      const text = source.slice(current.from, current.to)
      if (previous && linebreak.test(source.slice(previous.to, current.from))) {
        const before = source.slice(previous.from, previous.to)
        if (previous.key === 'throw:throw' || current.key === 'Arrow:=>' || previous.key === 'yield:yield' && text === '*') throw syntax
        const keyword = previous.key === `${before}:${before}`
        if (restrictedBefore.has(text) || (restricted.has(before) && (keyword || restrictedBefore.has(before)))) {
          bounded.push({ from: current.from, to: current.from, key: 'ASI:linebreak', boundary: true })
        }
      }
      previous = current
    }
    bounded.push(current)
    end = current.to
  }
  if (!whitespace.test(source.slice(end))) throw syntax
  if (bounded.length > maxNodes) throw budget
  scopes.sort((a, b) => a.from - b.from)
  return { tokens: bounded, scopes, shape: shape.join(''), parsedAs: 'file' }
}

export function parseJSON(source: string, language: string) {
  try {
    return JSON.stringify(parseSource(source, language))
  } catch (error) {
    if (error === syntax) return JSON.stringify({ error: 'invalid-syntax' })
    if (error === budget) return JSON.stringify({ error: 'budget' })
    throw error
  }
}
