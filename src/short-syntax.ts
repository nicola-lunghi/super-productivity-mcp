import { AppError } from './errors.js';

// Short syntax as parsed out of new titles by Super Productivity 19.0.1
// (src/app/features/tasks/short-syntax.ts). `(`, `)`, `|`, `+`, `#`, `@`, `!`
// end a token there because its character classes contain them literally.
// The checks err on the side of rejecting: a token only changes the task if it
// matches an existing project/tag or parses as a date, which cannot be known
// here, and an unknown tag even opens a confirmation dialog in the app.
const SHORT_SYNTAX_PATTERNS: readonly RegExp[] = [
  // #tag at the start or after a space
  /(?:^|\s)(#[^\s()+|#@!]+)/g,
  // +project at the start or after a space
  /(?:^|\s)(\+[^\s()+|#@!]\S*)/g,
  // @due date anywhere: 19.0.1 has no boundary rule for it
  /(@\s*[^\s()+|#@!]+)/g,
  // !deadline at the start or after a space
  /(?:^|\s)(!\s*[^\s()+|#@!]+)/g,
  // estimate and time spent, copied from SHORT_SYNTAX_TIME_REG_EX
  /(?:\s|^)(t?(?:\d+(?:\.\d+)?[mh]\s*)+(?:\s*\/(?:(?:\s*\d+(?:\.\d+)?[mh])+)?)?)(?=\s|$)/g,
];

/** Returns the short-syntax tokens Super Productivity 19.0.x would parse out of a new title. */
export const findShortSyntaxTokens = (title: string): string[] => {
  const tokens = SHORT_SYNTAX_PATTERNS.flatMap((pattern) =>
    [...title.matchAll(pattern)].map((match) => (match[1] ?? match[0]).trim()),
  );
  return [...new Set(tokens)];
};

/**
 * Rejects a new title that Super Productivity would rewrite through short
 * syntax, unless the build is known to store titles literally.
 */
export const assertLiteralTitle = (title: string, literalTitles: boolean): void => {
  if (literalTitles) return;
  const tokens = findShortSyntaxTokens(title);
  if (tokens.length === 0) return;
  throw new AppError(
    'TITLE_HAS_SHORT_SYNTAX',
    `Super Productivity would parse ${tokens.map((token) => `"${token}"`).join(', ')} out of this title as short syntax (#tag, +project, @date, !deadline, 30m). Rephrase the title (e.g. "issue 123" instead of "#123") or move the text to notes. Builds that store titles literally can set SP_LITERAL_TITLES=true.`,
    { details: { tokens } },
  );
};
