import { createContext, useContext, useMemo, type ReactNode } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-bash'
import { DEFAULT_LINE_BREAK_MODE, type LineBreakMode } from '@shared/model'

/** Mode de coupure des commandes affichées en entier, fourni par les réglages. */
export const LineBreakContext = createContext<LineBreakMode>(DEFAULT_LINE_BREAK_MODE)

/** Décalage des lignes qui prolongent la précédente (&&, ||, \). */
const CONTINUATION_INDENT = '  '

type Kind = 'cmd' | 'danger' | 'opt' | 'str' | 'var' | 'op' | 'num' | 'comment'

/** Commandes à risque (droits, suppression, écriture disque, arrêt), signalées par la couleur « sensible ». */
const SENSITIVE = new Set([
  'sudo', 'su', 'doas', 'rm', 'rmdir', 'shred', 'dd', 'mkfs', 'wipefs', 'fdisk', 'parted', 'truncate',
  'chmod', 'chown', 'chgrp', 'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'poweroff',
])

/** Mots après lesquels le mot suivant est de nouveau une commande. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'exec', 'watch', 'timeout'])

/** Options de sudo et doas suivies d'une valeur, qui n'est pas la commande (`sudo -u www-data php`). */
const PREFIX_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-U', '-C', '-D', '-h', '-p', '-r', '-t'])

/** Opérateurs et ponctuation après lesquels commence une nouvelle commande. */
const SEPARATORS = new Set(['|', '||', '&&', '&', '|&', ';', '(', '$(', '`'])

const KIND_OF_TYPE: Record<string, Kind> = {
  parameter: 'opt',
  string: 'str',
  variable: 'var',
  environment: 'var',
  'assign-left': 'var',
  operator: 'op',
  punctuation: 'op',
  'file-descriptor': 'op',
  keyword: 'op',
  number: 'num',
  boolean: 'num',
  comment: 'comment',
  shebang: 'comment',
}

interface Piece {
  text: string
  kind: Kind | null
  children?: Piece[]
  /** Saut de ligne suivi d'un espace vertical, entre deux instructions séparées par ;. */
  gap?: boolean
}

function commandKind(word: string): Kind {
  const name = word.slice(word.lastIndexOf('/') + 1)
  return SENSITIVE.has(name) || name.startsWith('mkfs.') ? 'danger' : 'cmd'
}

function textOf(content: string | Prism.Token | Prism.TokenStream): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(textOf).join('')
  return textOf(content.content)
}

function nested(content: string | Prism.Token | Prism.TokenStream): Piece[] {
  if (typeof content === 'string') return [{ text: content, kind: null }]
  if (Array.isArray(content)) return content.flatMap(nested)
  return [{ text: '', kind: KIND_OF_TYPE[content.type] ?? null, children: nested(content.content) }]
}

/**
 * Découpe une commande en morceaux colorables. Prism repère options, chaînes,
 * variables et opérateurs ; le nom de commande est reconnu par sa position
 * (début de ligne, après un séparateur ou un préfixe comme sudo).
 */
export function tokenizeCommand(command: string): Piece[] {
  const pieces: Piece[] = []
  let expectCommand = true
  let skipValue = false
  let previous = ''

  for (const token of Prism.tokenize(command, Prism.languages.bash)) {
    const escaped = previous === '\\'
    previous = typeof token === 'string' ? token : textOf(token.content).trim()
    if (typeof token === 'string') {
      for (const part of token.split(/(\s+)/)) {
        if (!part) continue
        if (expectCommand && /\S/.test(part) && !skipValue) {
          pieces.push({ text: part, kind: commandKind(part) })
          expectCommand = PREFIXES.has(part)
        } else {
          if (/\S/.test(part)) skipValue = false
          pieces.push({ text: part, kind: null })
        }
      }
      continue
    }

    const text = textOf(token.content).trim()
    if (token.type === 'function' || token.type === 'builtin') {
      if (expectCommand && !skipValue) {
        pieces.push({ text, kind: commandKind(text) })
        expectCommand = PREFIXES.has(text)
      } else {
        skipValue = false
        pieces.push(...nested(token.content))
      }
      continue
    }

    pieces.push({ text: '', kind: KIND_OF_TYPE[token.type] ?? null, children: nested(token.content) })
    if (SEPARATORS.has(text) && !escaped) {
      expectCommand = true
      skipValue = false
    } else if (token.type === 'parameter') {
      skipValue = expectCommand && PREFIX_OPTIONS_WITH_VALUE.has(text)
    } else if (skipValue) {
      skipValue = false
    } else if (token.type !== 'keyword' && token.type !== 'assign-left') {
      expectCommand = false
    }
  }
  return pieces
}

function pieceText(piece: Piece): string {
  return piece.children ? piece.children.map(pieceText).join('') : piece.text
}

function isBlank(piece: Piece): boolean {
  return piece.kind === null && !piece.children && !/\S/.test(piece.text)
}

/**
 * Insère les sauts de ligne du mode "auto" : avant chaque && et ||, décalés ;
 * après chaque ; (sauf \;), qui repart au bord après un espace vertical ; après un \ suivi d'un retour à
 * la ligne, décalé. Seuls les opérateurs de premier niveau comptent : ceux d'une
 * chaîne ou d'une substitution de commande sont imbriqués et restent en place.
 */
function breakLines(pieces: Piece[]): Piece[] {
  const out: Piece[] = []
  const dropTrailingBlanks = () => {
    while (out.length > 0 && isBlank(out[out.length - 1])) out.pop()
  }
  const skipBlanks = (from: number) => {
    let next = from
    while (next < pieces.length && isBlank(pieces[next])) next += 1
    return next
  }

  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]
    const text = piece.kind === 'op' ? pieceText(piece) : ''
    const previous = out.length > 0 ? pieceText(out[out.length - 1]) : ''

    if (text === '&&' || text === '||') {
      dropTrailingBlanks()
      out.push({ text: `\n${CONTINUATION_INDENT}`, kind: null }, piece)
      continue
    }
    const continuation = text === '\\' && i + 1 < pieces.length && isBlank(pieces[i + 1]) && pieces[i + 1].text.includes('\n')
    if ((text === ';' && previous !== '\\') || continuation) {
      out.push(piece)
      const next = skipBlanks(i + 1)
      if (next < pieces.length) {
        out.push(text === ';' ? { text: '', kind: null, gap: true } : { text: `\n${CONTINUATION_INDENT}`, kind: null })
      }
      i = next - 1
      continue
    }
    out.push(piece)
  }
  dropTrailingBlanks()
  return out
}

function render(pieces: Piece[], prefix: string): ReactNode[] {
  return pieces.map((piece, index) => {
    const key = `${prefix}${index}`
    if (piece.gap) return <span key={key} className="hl-gap" />
    const content = piece.children ? render(piece.children, `${key}.`) : piece.text
    return piece.kind ? (
      <span key={key} className={`tk-${piece.kind}`}>
        {content}
      </span>
    ) : (
      <span key={key}>{content}</span>
    )
  })
}

/**
 * Commande colorée selon la palette active (attribut data-palette d'un ancêtre).
 * `full` signale une commande affichée en entier : le mode de coupure des réglages,
 * ou `lineBreaks` s'il est fourni, s'y applique. Le conteneur doit conserver les
 * sauts de ligne (white-space: pre-wrap).
 */
export function CommandText({ command, full = false, lineBreaks }: { command: string; full?: boolean; lineBreaks?: LineBreakMode }) {
  const configured = useContext(LineBreakContext)
  const breaking = full && (lineBreaks ?? configured) === 'auto'
  const nodes = useMemo(() => {
    const pieces = tokenizeCommand(command)
    return render(breaking ? breakLines(pieces) : pieces, '')
  }, [command, breaking])
  return <span className="hl">{nodes}</span>
}
