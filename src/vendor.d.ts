declare module 'snowball-stemmers' {
  export function newStemmer(language: string): { stem(word: string): string };
}
declare module 'word-extractor' {
  export default class WordExtractor {
    extract(input: string | Buffer): Promise<{ getBody(): string }>;
  }
}
