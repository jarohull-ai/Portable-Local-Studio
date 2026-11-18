"use strict";

// Emoji-directed TTS: the text handed to the voice engine is a script, not just
// prose. A handful of emoji act as direction markers (pauses, tempo, acoustic
// plans, chapters), the rest of the text is spoken. The grammar is deliberately
// small: everything here has to survive a round trip through the audio renderer,
// so markers that would need a real synthesis engine (whispering formants,
// procedural breaths, character casting) are left for later.
//
// Kept separate from serve.cjs so the parser and the Polish verbalizer can be
// tested and read on their own.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

// --- Grammar -----------------------------------------------------------------

const PAUSE_SHORT_MS = 400;
const PAUSE_LONG_MS = 900;

const DIRECTIVE_TOKENS = [
  { token: "\u{1F4D6}", kind: "chapter", pauseMs: PAUSE_LONG_MS }, // 📖 chapter
  { token: "\u{1F6D1}", kind: "pause", pauseMs: PAUSE_LONG_MS }, // 🛑 long pause
  { token: "\u23F8\uFE0F", kind: "pause", pauseMs: PAUSE_SHORT_MS }, // ⏸️ short pause
  { token: "\u23F8", kind: "pause", pauseMs: PAUSE_SHORT_MS },
  { token: "\u{1F62E}\u200D\u{1F4A8}", kind: "pause", pauseMs: 600 }, // 😮‍💨 breath
  { token: "\u{1F399}\uFE0F", kind: "reset" }, // 🎙️ back to narrator voice
  { token: "\u{1F399}", kind: "reset" },
  { token: "\u{1F422}", kind: "slower", speedFactor: 0.85 }, // 🐢
  { token: "\u{1F407}", kind: "faster", speedFactor: 1.15 }, // 🐇
  { token: "\u{1F4FB}", kind: "dsp", dsp: "radio" }, // 📻
  { token: "\u{1F4F1}", kind: "dsp", dsp: "phone" }, // 📱
  { token: "\u{1F3DB}\uFE0F", kind: "dsp", dsp: "cathedral" }, // 🏛️
  { token: "\u{1F3DB}", kind: "dsp", dsp: "cathedral" },
  { token: "\u{1F92B}", kind: "dsp", dsp: "whisper" }, // 🤫
];

const DSP_PRESETS = {
  radio: {
    label: "Radio",
    filter: "highpass=f=250,lowpass=f=3200,acompressor=threshold=-18dB:ratio=4:attack=5:release=80,volume=1.1",
  },
  phone: {
    label: "Phone",
    filter: "highpass=f=300,lowpass=f=3400,acompressor=threshold=-20dB:ratio=6:attack=3:release=60",
  },
  cathedral: {
    label: "Cathedral",
    filter: "aecho=0.8:0.9:60|110:0.35|0.22,lowpass=f=6000",
  },
  whisper: {
    label: "Whisper",
    filter: "highpass=f=180,lowpass=f=5000,volume=0.55",
  },
};

const DIRECTIVE_PATTERN = new RegExp(
  DIRECTIVE_TOKENS.map((entry) => entry.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gu",
);

// Emoji that are not part of the grammar are dropped instead of spoken aloud.
const STRAY_EMOJI = /\p{Extended_Pictographic}[\uFE0F\u20E3]?[\u{1F3FB}-\u{1F3FF}]?(?:\u200D\p{Extended_Pictographic}[\uFE0F]?)*/gu;

function hasDirectives(text) {
  DIRECTIVE_PATTERN.lastIndex = 0;
  return DIRECTIVE_PATTERN.test(String(text || ""));
}

function stripDirectives(text) {
  return String(text || "").replace(DIRECTIVE_PATTERN, " ").replace(STRAY_EMOJI, " ");
}

function directiveTokenFor(token) {
  return DIRECTIVE_TOKENS.find((entry) => entry.token === token) || null;
}

function uniqueTokens(list) {
  const seen = new Set();
  return list.filter((entry) => {
    const key = `${entry.kind}:${entry.pauseMs || ""}:${entry.dsp || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Human-readable palette, so the UI does not have to duplicate the grammar.
function describeDirectives() {
  return uniqueTokens(DIRECTIVE_TOKENS).map((entry) => ({
    token: entry.token,
    kind: entry.kind,
    pauseMs: entry.pauseMs || 0,
    dsp: entry.dsp || "",
    label:
      entry.kind === "chapter" ? "Chapter start"
      : entry.kind === "pause" ? `${entry.pauseMs} ms pause`
      : entry.kind === "slower" ? "Slower"
      : entry.kind === "faster" ? "Faster"
      : entry.kind === "reset" ? "Narrator (reset)"
      : DSP_PRESETS[entry.dsp]?.label || entry.dsp,
  }));
}

// --- Parser ------------------------------------------------------------------

function parseDirectedText(raw, options = {}) {
  const source = String(raw || "");
  const polish = options.polish !== false;
  const segments = [];
  const chapters = [];
  const usedDirectives = [];
  let speed = 1;
  let dsp = null;
  let leadingPauseMs = 0;
  let buffer = "";
  let lastIndex = 0;

  const cleanup = (value) => cleanupChunk(value, { polish });

  const flush = () => {
    const text = cleanup(buffer);
    buffer = "";
    if (!text) return;
    const segment = { text, speed, dsp, pauseMs: 0 };
    segments.push(segment);
    const openChapter = chapters.find((chapter) => chapter.index === segments.length - 1);
    if (openChapter && !openChapter.title) openChapter.title = text.slice(0, 60);
  };

  const addPause = (ms) => {
    usedDirectives.push({ kind: "pause", pauseMs: ms });
    if (!segments.length) leadingPauseMs += ms;
    else segments[segments.length - 1].pauseMs += ms;
  };

  DIRECTIVE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(DIRECTIVE_PATTERN)) {
    const chunk = source.slice(lastIndex, match.index);
    if (chunk) buffer += chunk;
    lastIndex = match.index + match[0].length;
    const directive = directiveTokenFor(match[0]);
    if (!directive) continue;
    usedDirectives.push({ kind: directive.kind, pauseMs: directive.pauseMs || 0, dsp: directive.dsp || "" });
    if (directive.kind === "pause") {
      flush();
      addPause(directive.pauseMs);
      continue;
    }
    if (directive.kind === "chapter") {
      flush();
      chapters.push({ index: segments.length, title: "" });
      if (!segments.length) leadingPauseMs += directive.pauseMs;
      else segments[segments.length - 1].pauseMs += directive.pauseMs;
      continue;
    }
    if (directive.kind === "slower") {
      flush();
      speed = Math.max(0.5, round2(speed * directive.speedFactor));
      continue;
    }
    if (directive.kind === "faster") {
      flush();
      speed = Math.min(2, round2(speed * directive.speedFactor));
      continue;
    }
    if (directive.kind === "reset") {
      flush();
      speed = 1;
      dsp = null;
      continue;
    }
    if (directive.kind === "dsp") {
      flush();
      dsp = directive.dsp;
    }
  }
  buffer += source.slice(lastIndex);
  flush();

  // A chapter marker with no text before the next one still needs a stable index.
  for (const chapter of chapters) {
    if (!chapter.title) chapter.title = `Chapter ${chapters.indexOf(chapter) + 1}`;
  }

  const cleanedText = cleanup(source);
  return { segments, chapters, leadingPauseMs, text: cleanedText, directives: usedDirectives };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function cleanupChunk(value, options = {}) {
  let text = String(value || "")
    .replace(DIRECTIVE_PATTERN, " ")
    .replace(STRAY_EMOJI, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (options.polish) text = verbalizePolish(text);
  return text.replace(/\s+/g, " ").trim();
}

// Text without any direction, still normalised: used by the plain (non-directed)
// path so a number is read as a number there too.
function preparePlainText(value, options = {}) {
  const stripped = stripDirectives(value);
  return cleanupChunk(stripped, { polish: options.polish !== false });
}

// --- Polish verbalizer -------------------------------------------------------
// Only the cases a lector actually meets: numbers, decimals, thousands, dates,
// hours, amounts, percentages and a short list of abbreviations. Cardinal forms
// are nominative (that is what a lektor reads for "152"); dates and years use the
// genitive forms because that is how they are spoken ("dwudziestego czwartego").

const ONES = ["zero", "jeden", "dwa", "trzy", "cztery", "pięć", "sześć", "siedem", "osiem", "dziewięć"];
const TEENS = ["dziesięć", "jedenaście", "dwanaście", "trzynaście", "czternaście", "piętnaście", "szesnaście", "siedemnaście", "osiemnaście", "dziewiętnaście"];
const TENS = ["", "", "dwadzieścia", "trzydzieści", "czterdzieści", "pięćdziesiąt", "sześćdziesiąt", "siedemdziesiąt", "osiemdziesiąt", "dziewięćdziesiąt"];
const HUNDREDS = ["", "sto", "dwieście", "trzysta", "czterysta", "pięćset", "sześćset", "siedemset", "osiemset", "dziewięćset"];
const SCHALE = [
  { one: "", few: "", many: "" },
  { one: "tysiąc", few: "tysiące", many: "tysięcy" },
  { one: "milion", few: "miliony", many: "milionów" },
  { one: "miliard", few: "miliardy", many: "miliardów" },
];

const GENITIVE_DAY = [
  "", "pierwszego", "drugiego", "trzeciego", "czwartego", "piątego", "szóstego", "siódmego", "ósmego", "dziewiątego",
  "dziesiątego", "jedenastego", "dwunastego", "trzynastego", "czternastego", "piętnastego", "szesnastego", "siedemnastego",
  "osiemnastego", "dziewiętnastego", "dwudziestego", "dwudziestego pierwszego", "dwudziestego drugiego",
  "dwudziestego trzeciego", "dwudziestego czwartego", "dwudziestego piątego", "dwudziestego szóstego",
  "dwudziestego siódmego", "dwudziestego ósmego", "dwudziestego dziewiątego", "trzydziestego",
  "trzydziestego pierwszego",
];

const MONTHS_GENITIVE = [
  "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
  "lipca", "sierpnia", "września", "października", "listopada", "grudnia",
];

const GENITIVE_ONES = ["", "pierwszego", "drugiego", "trzeciego", "czwartego", "piątego", "szóstego", "siódmego", "ósmego", "dziewiątego"];
const GENITIVE_TEENS = ["dziesiątego", "jedenastego", "dwunastego", "trzynastego", "czternastego", "piętnastego", "szesnastego", "siedemnastego", "osiemnastego", "dziewiętnastego"];
const GENITIVE_TENS = ["", "", "dwudziestego", "trzydziestego", "czterdziestego", "pięćdziesiątego", "sześćdziesiątego", "siedemdziesiątego", "osiemdziesiątego", "dziewięćdziesiątego"];
const GENITIVE_HUNDREDS = ["", "setnego", "dwusetnego", "trzysetnego", "czterysetnego", "pięćsetnego", "sześćsetnego", "siedemsetnego", "osiemsetnego", "dziewięćsetnego"];

const ABBREVIATIONS = [
  [/\bm\.in\./gi, "między innymi"],
  [/\bnp\./gi, "na przykład"],
  [/\bitd\./gi, "i tak dalej"],
  [/\bitp\./gi, "i tym podobne"],
  [/\btzn\./gi, "to znaczy"],
  [/\btj\./gi, "to jest"],
  [/\bprof\./gi, "profesor"],
  [/\bdr hab\./gi, "doktor habilitowany"],
  [/\bdr\./gi, "doktor"],
  [/\bmgr\./gi, "magister"],
  [/\bgodz\./gi, "godzina"],
  [/\bul\./gi, "ulica"],
  [/\bnr\.?/gi, "numer"],
  [/\bpkt\.?/gi, "punkt"],
  [/\btys\./gi, "tysięcy"],
  [/\bmln\.?/gi, "milionów"],
  [/\bmld\.?/gi, "miliardów"],
  [/\bkm\b/gi, "kilometrów"],
  [/\bkg\b/gi, "kilogramów"],
  [/\bcm\b/gi, "centymetrów"],
  [/\bmm\b/gi, "milimetrów"],
  [/\br\.\s*(?=\d)/g, "roku "],
  [/\br\.(?=\s|$)/g, "roku"],

  [/\bart\./gi, "artykuł"],
  [/\bstr\./gi, "strona"],
  [/\bwzw\./gi, "w związku z"],
  [/\bwg\b/gi, "według"],
];

function cardinalGroup(value) {
  const words = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 20) {
    words.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) words.push(ONES[rest % 10]);
  } else if (rest >= 10) {
    words.push(TEENS[rest - 10]);
  } else if (rest > 0) {
    words.push(ONES[rest]);
  }
  return words.filter(Boolean).join(" ");
}

function scaleWord(count, scale) {
  const plural = SCHALE[scale];
  if (!plural || !plural.one) return "";
  const last = count % 10;
  const lastTwo = count % 100;
  if (count === 1) return plural.one;
  if (lastTwo >= 12 && lastTwo <= 14) return plural.many;
  if (last >= 2 && last <= 4) return plural.few;
  return plural.many;
}

function cardinal(value) {
  let number = Math.trunc(Math.abs(Number(value) || 0));
  if (number === 0) return ONES[0];
  const groups = [];
  while (number > 0) {
    groups.push(number % 1000);
    number = Math.floor(number / 1000);
  }
  const words = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    if (index === 0) {
      words.push(cardinalGroup(group));
      continue;
    }
    if (group === 1 && index === 1) {
      words.push("tysiąc");
      continue;
    }
    const groupText = index === 1 && group === 1 ? "" : cardinalGroup(group);
    words.push(`${groupText} ${scaleWord(group, index)}`.trim());
  }
  return words.filter(Boolean).join(" ");
}

// Years are read in the genitive ("dwa tysiące dwudziestego czwartego"), which only
// changes the last group; the thousands part stays cardinal.
// "1 sztuka", "22 sztuki": the last word has to agree with a feminine noun.
function cardinalFeminine(value) {
  const text = cardinal(value);
  const number = Math.abs(Number(value) || 0);
  const last = number % 10;
  const lastTwo = number % 100;
  if (lastTwo === 1) return text.replace(/jeden$/, "jedna");
  if (last === 2 && !(lastTwo >= 12 && lastTwo <= 14)) return text.replace(/dwa$/, "dwie");
  return text;
}

function genitiveNumber(value) {
  const number = Math.trunc(Math.abs(Number(value) || 0));
  if (number === 0) return ONES[0];
  const groups = [];
  let rest = number;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const parts = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    if (index === 0) {
      parts.push(genitiveGroup(group));
      continue;
    }
    if (index === 1 && group === 1) {
      parts.push("tysiąc");
      continue;
    }
    parts.push(`${cardinalGroup(group)} ${scaleWord(group, index)}`.trim());
  }
  return parts.filter(Boolean).join(" ");
}

function genitiveGroup(value) {
  const words = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) words.push(GENITIVE_HUNDREDS[hundreds]);
  if (rest >= 20) {
    words.push(GENITIVE_TENS[Math.floor(rest / 10)]);
    if (rest % 10) words.push(GENITIVE_ONES[rest % 10]);
  } else if (rest >= 10) {
    words.push(GENITIVE_TEENS[rest - 10]);
  } else if (rest > 0) {
    words.push(GENITIVE_ONES[rest]);
  }
  return words.filter(Boolean).join(" ");
}

function hourWord(hour) {
  const feminine = {
    1: "pierwsza", 2: "druga", 3: "trzecia", 4: "czwarta", 5: "piąta", 6: "szósta",
    7: "siódma", 8: "ósma", 9: "dziewiąta", 10: "dziesiąta", 11: "jedenasta",
    12: "dwunasta", 13: "trzynasta", 14: "czternasta", 15: "piętnasta",
    16: "szesnasta", 17: "siedemnasta", 18: "osiemnasta", 19: "dziewiętnasta",
    20: "dwudziesta", 21: "dwudziesta pierwsza", 22: "dwudziesta druga",
    23: "dwudziesta trzecia", 24: "dwudziesta czwarta",
  };
  return feminine[hour] || cardinal(hour);
}

// "o 15:47" reads in the locative ("o piętnastej czterdzieści siedem"), a bare
// time reads with the nominative hour ("piętnasta czterdzieści siedem").
const HOUR_LOCATIVE = {
  1: "pierwszej", 2: "drugiej", 3: "trzeciej", 4: "czwartej", 5: "piątej", 6: "szóstej",
  7: "siódmej", 8: "ósmej", 9: "dziewiątej", 10: "dziesiątej", 11: "jedenastej",
  12: "dwunastej", 13: "trzynastej", 14: "czternastej", 15: "piętnastej",
  16: "szesnastej", 17: "siedemnastej", 18: "osiemnastej", 19: "dziewiętnastej",
  20: "dwudziestej", 21: "dwudziestej pierwszej", 22: "dwudziestej drugiej",
  23: "dwudziestej trzeciej", 24: "dwudziestej czwartej",
};

function decimalWords(raw) {
  const cleaned = String(raw).replace(/\s|\u00A0|\u202F/g, "");
  const [wholePart, fractionPart] = cleaned.split(",");
  const whole = cardinal(Number(wholePart));
  if (!fractionPart) return whole;
  const fraction = Number(fractionPart.replace(/0+$/, "") || "0");
  const fractionText = fractionPart.length === 1 ? cardinal(fraction) : cardinal(fraction);
  return `${whole} przecinek ${fractionText}`;
}

function verbalizePolish(input) {
  let text = String(input || "");
  if (!text.trim()) return "";

  // Dates: 24.02.2024 / 24-02-2024 → genitive day + month + genitive year.
  text = text.replace(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/g, (match, day, month, year) => {
    const dayNumber = Number(day);
    const monthNumber = Number(month);
    if (dayNumber < 1 || dayNumber > 31 || monthNumber < 1 || monthNumber > 12) return match;
    const dayText = GENITIVE_DAY[dayNumber] || cardinal(dayNumber);
    const monthText = MONTHS_GENITIVE[monthNumber - 1];
    return `${dayText} ${monthText} ${genitiveNumber(Number(year))} roku`;
  });

  // Hours: 15:47 → piętnasta czterdzieści siedem; po "o" → o piętnastej czterdzieści siedem.
  text = text.replace(/(\b(?:o|około|przed|po|do|od)\s+)?\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (match, prefix, hour, minute) => {
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const hourText = prefix ? HOUR_LOCATIVE[hourNumber] || hourWord(hourNumber) : hourWord(hourNumber);
    const minutes = minuteNumber === 0 ? "" : ` ${cardinal(minuteNumber)}`;
    return `${prefix || ""}${hourText}${minutes}`;
  });

  // Counted nouns: the number decides the form, so "3 szt." is not "trzy sztuk".
  text = text.replace(/(\d{1,3}(?:[ \u00A0\u202F]\d{3})*|\d+)\s*(szt|os)\./gi, (match, value, unit) => {
    const count = Number(String(value).replace(/\s|\u00A0|\u202F/g, ""));
    const noun = unit.toLowerCase() === "os"
      ? pluralForm(count, "osoba", "osoby", "osób")
      : pluralForm(count, "sztuka", "sztuki", "sztuk");
    return `${cardinalFeminine(count)} ${noun}`;
  });

  // Amounts: 1234,56 zł → ... złotych ... groszy.
  text = text.replace(/(\d{1,3}(?:[ \u00A0\u202F]\d{3})*|\d+)(?:,(\d{1,2}))?\s*(zł|PLN)(?![\wąćęłńóśźż])/gi, (match, whole, fraction, currency) => {
    const amount = Number(String(whole).replace(/\s|\u00A0|\u202F/g, ""));
    const zlotyText = `${cardinal(amount)} ${pluralForm(amount, "złoty", "złote", "złotych")}`;
    if (!fraction) return zlotyText;
    const grosze = Number(fraction.padEnd(2, "0"));
    return `${zlotyText} ${cardinal(grosze)} ${pluralForm(grosze, "grosz", "grosze", "groszy")}`;
  });

  // Percentages.
  text = text.replace(/(\d+(?:,\d+)?)\s*%/g, (match, value) => `${decimalWords(value)} procent`);

  // Abbreviations before numbers, so "ok. 15" does not turn into "około" mid-token.
  for (const [pattern, replacement] of ABBREVIATIONS) {
    text = text.replace(pattern, replacement);
  }

  // Decimals and thousands-separated numbers.
  text = text.replace(/\b\d{1,3}(?:[ \u00A0\u202F\u2009]\d{3})+(?:,\d+)?\b/g, (match) => decimalWords(match));
  text = text.replace(/\b\d+,\d+\b/g, (match) => decimalWords(match));
  text = text.replace(/\b\d+\b/g, (match) => cardinal(Number(match)));

  // Ranges and a few symbols that a voice engine would otherwise mispronounce.
  text = text.replace(/\s*&\s*/g, " i ");
  text = text.replace(/\s+([,.!?;:])/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}

function pluralForm(count, one, few, many) {
  const last = count % 10;
  const lastTwo = count % 100;
  if (count === 1) return one;
  if (lastTwo >= 12 && lastTwo <= 14) return many;
  if (last >= 2 && last <= 4) return few;
  return many;
}

// --- WAV helpers -------------------------------------------------------------

function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) break;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      dataOffset = start;
      dataSize = size;
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !dataSize) return null;
  return { ...fmt, dataOffset, dataSize };
}

// Segment audio for the directed path is always mono 16-bit PCM; anything else is
// handed to ffmpeg before it gets here.
function pcm16FromWav(buffer) {
  const info = parseWav(buffer);
  if (!info) return null;
  if (info.channels !== 1 || info.bitsPerSample !== 16) return null;
  return { pcm: buffer.subarray(info.dataOffset, info.dataOffset + info.dataSize), sampleRate: info.sampleRate };
}

function wavFromPcm(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function silencePcm(sampleRate, durationMs) {
  const samples = Math.max(0, Math.round((sampleRate * Math.max(0, durationMs)) / 1000));
  return Buffer.alloc(samples * 2);
}

// Joins the rendered segments with the pauses the script asked for.
function joinSegments(parts, options = {}) {
  const sampleRate = Number(options.sampleRate) || 22050;
  const leadingPauseMs = Number(options.leadingPauseMs) || 0;
  const chunks = [];
  if (leadingPauseMs) chunks.push(silencePcm(sampleRate, leadingPauseMs));
  for (const part of parts) {
    chunks.push(part.pcm);
    if (part.pauseMs) chunks.push(silencePcm(sampleRate, part.pauseMs));
  }
  return wavFromPcm(Buffer.concat(chunks), sampleRate);
}

// --- DSP ---------------------------------------------------------------------

function applyDspPreset({ inputPath, outputPath, preset, sampleRate, ffmpegPath = "ffmpeg" }) {
  const entry = DSP_PRESETS[preset];
  if (!entry) return Promise.reject(new Error(`Unknown DSP preset: ${preset}`));
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-af", entry.filter,
      "-ar", String(sampleRate || 22050),
      "-ac", "1",
      "-c:a", "pcm_s16le",
      outputPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "pipe", windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 || !fs.existsSync(outputPath)) {
        reject(new Error((stderr || `ffmpeg exited with code ${code}`).trim().slice(-800)));
        return;
      }
      resolve(outputPath);
    });
  });
}

function resolveFfmpeg() {
  for (const candidate of ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
    if (candidate === "ffmpeg") {
      const paths = String(process.env.PATH || "").split(path.delimiter);
      if (paths.some((dir) => dir && fs.existsSync(path.join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")))) return candidate;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

// --- Segment cache -----------------------------------------------------------

function segmentCacheKey({ voice, speed, dsp, text, sampleRate }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ voice, speed: round2(speed), dsp: dsp || "", text, sampleRate }))
    .digest("hex");
}

module.exports = {
  DSP_PRESETS,
  applyDspPreset,
  describeDirectives,
  hasDirectives,
  joinSegments,
  parseDirectedText,
  parseWav,
  pcm16FromWav,
  preparePlainText,
  resolveFfmpeg,
  segmentCacheKey,
  stripDirectives,
  verbalizePolish,
  wavFromPcm,
};
