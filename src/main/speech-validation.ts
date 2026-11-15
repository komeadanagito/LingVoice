/** Content failures are distinct from ASR transport/runtime errors: only these may trigger content recovery. */
export class SpeechContentError extends Error {
  constructor(message: string, readonly expected: string, readonly transcript: string) {
    super(message);
    this.name = 'SpeechContentError';
  }
}

const PURE_ENGLISH_FILLER = /^(?:uh+|um+|er+|ah+|oh+|hmm+|mm+|mhm|eh+|ooh+|ugh|phew)$/;
const PURE_INTERJECTION_CJK = /^[啊呃嗯哦哇唔嘿哈呀哎哟]+$/;

/** Conservative transcript checks: reject language leakage, omissions and repeated additions. */
export function validateSynthesizedTranscript(expected: string, actual: string, language: string): void {
  const reject = (message: string): never => { throw new SpeechContentError(message, expected, actual); };
  if (!actual.trim()) reject('Generated speech verification returned an empty transcript.');

  if (language === 'en') {
    const strippedExpected = expected.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    const strippedActual = actual.trim().replace(/[\s.,!?。！？…、，；："'“”‘’]+/g, '');
    if (PURE_ENGLISH_FILLER.test(strippedExpected) && (PURE_INTERJECTION_CJK.test(strippedActual) && strippedActual.length <= 3 || PURE_ENGLISH_FILLER.test(strippedActual.toLowerCase()) || /^[ao]$/i.test(strippedActual))) {
      return;
    }
  }

  if (language === 'en' && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(actual)) {
    reject('Generated English speech contains unexpected Chinese or other CJK speech.');
  }
  // ASR may write a spoken number as a digit ("GTA6", "4K", "60") rather than a word.
  // Canonicalize only exact lexical equivalents; never map Roman letters to a
  // number here, since "V I" is the pronunciation error we must reject.
  const ones: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const tokens = (text: string): string[] => {
    if (language !== 'en') return text.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? [];
    const raw = text
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/([a-z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([a-z])/g, '$1 $2')
      .match(/[a-z0-9]+/g) ?? [];
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const tok = raw[i];
      if (tok in tens && i + 1 < raw.length && raw[i + 1] in ones && ones[raw[i + 1]] < 10) {
        out.push(String(tens[tok] + ones[raw[i + 1]]));
        i++;
      } else if (tok in tens) {
        out.push(String(tens[tok]));
      } else if (tok in ones) {
        out.push(String(ones[tok]));
      } else {
        out.push(tok);
      }
    }
    return out;
  };
  const wanted = tokens(expected), heard = tokens(actual);
  if (!wanted.length || !heard.length) reject('Generated speech has no verifiable words.');
  // ASR commonly transcribes "4 K" / "2 K" as homophones "for k" / "to k".
  for (let i = 0; i + 1 < heard.length; i++) {
    if (heard[i + 1] === 'k') {
      if (heard[i] === 'for' && wanted.some((t, idx) => t === '4' && wanted[idx + 1] === 'k')) heard[i] = '4';
      if ((heard[i] === 'to' || heard[i] === 'too') && wanted.some((t, idx) => t === '2' && wanted[idx + 1] === 'k')) heard[i] = '2';
    }
  }
  // Ordered matching catches both appended prompt speech and repeated target phrases.
  let row = new Uint16Array(heard.length + 1);
  for (const token of wanted) {
    const next = new Uint16Array(heard.length + 1);
    for (let j = 0; j < heard.length; j++) next[j + 1] = token === heard[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]);
    row = next;
  }
  const matched = row[heard.length];
  if (matched / wanted.length < 0.65 || matched / heard.length < 0.65) {
    reject('Generated speech does not sufficiently match the requested text (missing, unrelated or repeated words).');
  }
}
