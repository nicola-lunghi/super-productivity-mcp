import { assertLiteralTitle, findShortSyntaxTokens } from '../src/short-syntax.js';

describe('short syntax in titles', () => {
  it.each([
    ['Fix bug #123', '#123'],
    ['Paint +Home', '+Home'],
    ['Paint @tomorrow 3pm', '@tomorrow'],
    ['Paint !fri', '!fri'],
    ['Paint 1h/3h', '1h/3h'],
  ])('finds the token in %j', (title, token) => {
    expect(findShortSyntaxTokens(title)).toEqual([token]);
  });

  it.each(['Paint the hallway', 'C# and C++', 'Wow! Great', 'room 101', 'GitHub issue 7'])(
    'accepts %j',
    (title) => {
      expect(findShortSyntaxTokens(title)).toEqual([]);
    },
  );

  it('rejects such titles unless titles are stored literally', () => {
    expect(() => assertLiteralTitle('Fix bug #123', false)).toThrow('"#123"');
    expect(() => assertLiteralTitle('Fix bug #123', true)).not.toThrow();
  });
});
