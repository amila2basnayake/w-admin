// Spoken-language support for the phone channel. The caller's language is SESSION state inferred from
// what they say, turn by turn: Retell reports no detected language, and no language or nationality is
// stored against a client anywhere (a deliberate decision) — so it is detected here from the transcript,
// used for this one call (which code-spoken strings to use, whether the English unit rewriter applies,
// what the model is told), and forgotten with the session.
//
//   AIADVISOR_VOICE_LANGUAGES=en-AU,vi-VN,it-IT,el-GR,hi-IN,zh-CN,tr-TR,ar-SA
//
// is the set the Retell agents listen for (`voice:setup` sends it as the agent's `language` array) and the
// set the detector may return. Default: en-AU only, which keeps every existing deployment exactly as it was.

/** Retell's agent `language` enum (docs.retellai.com/api-references/create-agent). No Punjabi, no Khmer. */
export const RETELL_LOCALES = [
  'en-US', 'en-IN', 'en-GB', 'en-AU', 'en-NZ', 'de-DE', 'es-ES', 'es-419', 'hi-IN', 'fr-FR', 'fr-CA', 'ja-JP', 'pt-PT', 'pt-BR',
  'zh-CN', 'ru-RU', 'it-IT', 'ko-KR', 'nl-NL', 'nl-BE', 'pl-PL', 'tr-TR', 'vi-VN', 'ro-RO', 'bg-BG', 'ca-ES', 'th-TH', 'da-DK',
  'fi-FI', 'el-GR', 'hu-HU', 'id-ID', 'no-NO', 'sk-SK', 'sv-SE', 'lt-LT', 'lv-LV', 'cs-CZ', 'ms-MY', 'af-ZA', 'ar-SA', 'az-AZ',
  'bs-BA', 'cy-GB', 'fa-IR', 'fil-PH', 'gl-ES', 'he-IL', 'hr-HR', 'hy-AM', 'is-IS', 'kk-KZ', 'kn-IN', 'mk-MK', 'mr-IN', 'ne-NP',
  'sl-SI', 'sr-RS', 'sw-KE', 'ta-IN', 'ur-IN', 'yue-CN', 'uk-UA',
] as const;

/** "en-AU, vi-VN,xx" → ['en-AU','vi-VN'] (unknown locales dropped with a warning; English always present and first). */
export function parseVoiceLanguages(s: string, warn: (m: string) => void = (m) => console.warn(m)): string[] {
  const out: string[] = [];
  for (const raw of s.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const m = RETELL_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
    if (!m) { warn(`[voice] AIADVISOR_VOICE_LANGUAGES: "${t}" is not a Retell locale — ignored`); continue; }
    if (!out.includes(m)) out.push(m);
  }
  const enIdx = out.findIndex((l) => l.startsWith('en-'));
  if (enIdx < 0) out.unshift('en-AU');
  else if (enIdx > 0) out.unshift(...out.splice(enIdx, 1));
  return out;
}

/** The agent's `language` field: a scalar for one locale, an array for a multilingual agent. */
export function retellLanguageField(locales: string[]): string | string[] {
  return locales.length === 1 ? locales[0] : locales;
}

/** 'vi-VN' → 'vi', 'yue-CN' → 'yue'. */
export function baseLang(locale: string): string { return locale.split('-')[0].toLowerCase(); }

const NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
/** 'vi' → 'Vietnamese' (for the model's call-state block and the audit event). */
export function languageName(base: string): string {
  try { return NAMES.of(base) ?? base; } catch { return base; }
}

// ---- detection --------------------------------------------------------------------------------

/** Non-Latin scripts settle the language outright; candidates in preference order, first allowed wins. */
const SCRIPTS: Array<[RegExp, string[]]> = [
  [/[ऀ-ॿ]/, ['hi', 'mr', 'ne']],                       // Devanagari
  [/[Ͱ-Ͽ]/, ['el']],                                   // Greek
  [/[぀-ヿ]/, ['ja']],                                   // Hiragana / Katakana (before Han: Japanese uses both)
  [/[一-鿿㐀-䶿]/, ['zh', 'yue', 'ja']],         // Han
  [/[가-힯]/, ['ko']],                                   // Hangul
  [/[؀-ۿ]/, ['ar', 'fa', 'ur']],                       // Arabic script
  [/[Ѐ-ӿ]/, ['ru', 'uk', 'bg', 'sr', 'mk', 'kk']],     // Cyrillic
  [/[฀-๿]/, ['th']],                                   // Thai
  [/[֐-׿]/, ['he']],                                   // Hebrew
  [/[԰-֏]/, ['hy']],                                   // Armenian
  [/[஀-௿]/, ['ta']],                                   // Tamil
  [/[ಀ-೿]/, ['kn']],                                   // Kannada
];

/** Latin-script languages: high-frequency words (incl. the water-call vocabulary) and telltale letters. */
const LATIN: Record<string, { words: string[]; letters?: RegExp }> = {
  en: { words: 'the and is are you to of my in it that for what can please water yes hello want have on with how much price sell buy do this me we be not was at from your okay thanks thank allocation megalitres'.split(' ') },
  vi: { words: 'tôi bạn của là và có không cho được này muốn nước bán mua giá xin chào vâng cảm ơn một những với đang để ở gì thế nào anh chị em làm ạ dạ'.split(' '), letters: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i },
  it: { words: 'il la di che è e un una per non sono ho vorrei acqua vendere comprare prezzo sì grazie buongiorno ciao mi del della con quanto come questo posso voglio salve io lei'.split(' '), letters: /[àèéìòù]/i },
  tr: { words: 'ben sen bir bu ve için var yok su satmak almak fiyat evet hayır merhaba teşekkür istiyorum ne kadar nasıl mi mı mu mü ile değil çok benim'.split(' '), letters: /[ışğİ]/ },
  es: { words: 'el la de que y un una por no es quiero agua vender comprar precio sí gracias hola buenos días mi del con cuánto cómo esto puedo yo usted para tengo'.split(' '), letters: /[ñ¿¡]/ },
  de: { words: 'ich der die das und ist ein eine nicht wasser verkaufen kaufen preis ja danke hallo möchte wie viel mit für mein was kann bitte haben sie wir es'.split(' '), letters: /[ßäöü]/i },
  fr: { words: 'je le la de et est un une pas eau vendre acheter prix oui merci bonjour voudrais combien avec pour mon que peux vous nous il elle ce les des'.split(' '), letters: /[çœ]/i },
  pt: { words: 'eu o a de que e um uma não água vender comprar preço sim obrigado obrigada olá quero quanto com para meu minha você posso está isso os as do da'.split(' '), letters: /[ãõç]/i },
  nl: { words: 'ik de het en is een niet water verkopen kopen prijs ja dank hallo wil hoeveel met voor mijn wat kan alstublieft u wij zijn dat'.split(' ') },
  fil: { words: 'ako ikaw ang ng sa at ay hindi tubig magbenta bumili presyo oo salamat kumusta gusto magkano ko mo po ito ba na kayo kami ni mga'.split(' ') },
  id: { words: 'saya anda dan yang ini itu tidak air jual beli harga ya terima kasih halo mau ingin berapa dengan untuk apa bisa kami di ke dari adalah'.split(' ') },
  ms: { words: 'saya anda dan yang ini itu tidak air jual beli harga ya terima kasih halo mahu hendak berapa dengan untuk apa boleh kami di ke dari ialah'.split(' ') },
  pl: { words: 'ja nie jest to i w na z do się woda sprzedać kupić cena tak dziękuję dzień dobry chcę ile mój co mogę pan pani proszę jak'.split(' '), letters: /[łżźśąęćń]/i },
};
const LATIN_SETS: Record<string, Set<string>> = Object.fromEntries(Object.entries(LATIN).map(([k, v]) => [k, new Set(v.words)]));

export interface Detection { lang: string; confident: boolean }

/**
 * Which of the ALLOWED languages an utterance is in. Confident on a non-Latin script hit, or when one
 * Latin-script language scores at least 2 (frequent words + telltale letters) and beats every other;
 * otherwise {lang:'en', confident:false} — a short "yes"/"okay"/"200" changes nothing. Callers keep the
 * current session language on an unconfident result, so a sticky language only flips on real evidence.
 */
export function detectLanguage(text: string, allowed: readonly string[]): Detection {
  const t = String(text ?? '');
  if (!t.trim()) return { lang: 'en', confident: false };
  for (const [re, cands] of SCRIPTS) {
    if (!re.test(t)) continue;
    const pick = cands.find((c) => allowed.includes(c));
    return pick ? { lang: pick, confident: true } : { lang: 'en', confident: false };
  }
  const tokens = t.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1);
  const scores: Array<[string, number]> = [];
  for (const lang of allowed) {
    const spec = LATIN[lang];
    if (!spec) continue;
    let s = 0;
    for (const w of tokens) if (LATIN_SETS[lang].has(w)) s++;
    // Telltale letters count once each (capped): à/è/ì/ò/ù are shared by Italian, Vietnamese, French and
    // Portuguese, so they tip a close call but cannot outvote the words.
    if (spec.letters) { const m = t.match(new RegExp(spec.letters.source, spec.letters.flags + 'g')); if (m) s += Math.min(3, m.length); }
    scores.push([lang, s]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const [best, runner] = [scores[0], scores[1]];
  if (best && best[1] >= 2 && (!runner || best[1] > runner[1])) return { lang: best[0], confident: true };
  return { lang: 'en', confident: false };
}

// ---- code-spoken strings ----------------------------------------------------------------------

/** What the code (not the model) says on a call: fillers while a tool runs, the error apology, the
 *  tool-round limit, the transport-error line. English is the fallback for any language without an entry.
 *  Non-English entries are machine-authored — have a native speaker check them before enabling that locale. */
export interface SpokenStrings { fillers: string[]; apology: string; limit: string; wrong: string; /** Hang-up line for a line nobody ever spoke on. */ deadLine: string;
  /** The recording disclosure in this language, spoken by code the first time the caller is heard in it (the
   *  opening said it in English). Fixed text: a legal sign-off item, like flows.ts DISCLOSURE. Empty = none. */
  disclosure: string }

const STRINGS: Record<string, SpokenStrings> = {
  en: {
    fillers: ['One moment.', 'Let me check that.', 'Just a second.', 'Bear with me a moment.'],
    apology: "Sorry, I'm having trouble with that right now. Could you say that again, or I can have a broker call you back?",
    limit: "I've hit the limit of what I can check in one go. Let me hand this to a broker if you'd like.",
    wrong: 'Sorry, something went wrong on my end. Could you say that again?',
    deadLine: "I can't hear anything from your end, so I'll let you go. Call Waterfind back any time. Goodbye.",
    disclosure: "",
  },
  vi: {
    fillers: ['Xin chờ một chút.', 'Để tôi kiểm tra.', 'Một giây thôi.'],
    apology: 'Xin lỗi, hiện tại tôi đang gặp trục trặc. Bạn có thể nói lại, hoặc tôi có thể nhờ một nhân viên môi giới gọi lại cho bạn?',
    limit: 'Tôi đã đến giới hạn những gì có thể kiểm tra trong một lần. Nếu bạn muốn, tôi sẽ chuyển việc này cho một nhân viên môi giới.',
    wrong: 'Xin lỗi, đã có lỗi xảy ra ở phía tôi. Bạn có thể nói lại được không?',
    deadLine: 'Tôi không nghe thấy gì từ phía anh chị, nên tôi xin phép kết thúc cuộc gọi. Anh chị có thể gọi lại Waterfind bất cứ lúc nào. Tạm biệt.',
    disclosure: "Tôi là trợ lý tự động của Waterfind, và cuộc gọi này có thể được ghi âm để đảm bảo chất lượng và đào tạo.",
  },
  it: {
    fillers: ['Un momento.', 'Controllo subito.', 'Un attimo.'],
    apology: 'Mi dispiace, in questo momento ho un problema. Può ripetere, oppure posso farla richiamare da un broker?',
    limit: 'Ho raggiunto il limite di quello che posso verificare in una volta. Se vuole, passo la questione a un broker.',
    wrong: 'Mi dispiace, qualcosa è andato storto da parte mia. Può ripetere?',
    deadLine: 'Non sento nulla dalla sua parte, quindi la lascio andare. Può richiamare Waterfind quando vuole. Arrivederci.',
    disclosure: "Sono l'assistente automatico di Waterfind e questa chiamata potrebbe essere registrata per fini di qualità e formazione.",
  },
  el: {
    fillers: ['Μια στιγμή.', 'Να το ελέγξω.', 'Ένα λεπτό.'],
    apology: 'Συγγνώμη, έχω πρόβλημα αυτή τη στιγμή. Μπορείτε να το επαναλάβετε, ή να ζητήσω από έναν μεσίτη να σας καλέσει;',
    limit: 'Έφτασα στο όριο του τι μπορώ να ελέγξω με τη μία. Αν θέλετε, το προωθώ σε έναν μεσίτη.',
    wrong: 'Συγγνώμη, κάτι πήγε στραβά από την πλευρά μου. Μπορείτε να το πείτε ξανά;',
    deadLine: 'Δεν ακούω τίποτα από την πλευρά σας, οπότε θα κλείσω. Μπορείτε να ξανακαλέσετε τη Waterfind όποτε θέλετε. Αντίο.',
    disclosure: "Είμαι ο αυτόματος βοηθός της Waterfind και αυτή η κλήση μπορεί να καταγράφεται για λόγους ποιότητας και εκπαίδευσης.",
  },
  hi: {
    fillers: ['एक क्षण।', 'मैं देखता हूँ।', 'बस एक सेकंड।'],
    apology: 'माफ़ कीजिए, अभी मुझे कुछ दिक्कत आ रही है। क्या आप दोबारा कह सकते हैं, या मैं किसी ब्रोकर से आपको कॉल करवा दूँ?',
    limit: 'एक बार में मैं जितना जाँच सकता हूँ, उसकी सीमा आ गई है। अगर आप चाहें तो मैं इसे ब्रोकर को सौंप देता हूँ।',
    wrong: 'माफ़ कीजिए, मेरी तरफ़ से कुछ गड़बड़ हो गई। क्या आप दोबारा कह सकते हैं?',
    deadLine: 'मुझे आपकी तरफ़ से कुछ सुनाई नहीं दे रहा, इसलिए मैं कॉल समाप्त करता हूँ। आप Waterfind को कभी भी दोबारा कॉल कर सकते हैं। नमस्ते।',
    disclosure: "मैं Waterfind का स्वचालित सहायक हूँ, और गुणवत्ता और प्रशिक्षण के लिए यह कॉल रिकॉर्ड की जा सकती है।",
  },
  zh: {
    fillers: ['请稍等。', '我查一下。', '稍等一下。'],
    apology: '抱歉，我现在遇到了一点问题。您可以再说一遍，或者我请一位经纪人给您回电？',
    limit: '我一次能查的内容已经到上限了。如果您愿意，我把这件事交给经纪人处理。',
    wrong: '抱歉，我这边出了点问题。您能再说一遍吗？',
    deadLine: '我这边听不到您的声音，所以先挂断了。您随时可以再打给 Waterfind。再见。',
    disclosure: "我是 Waterfind 的自动助理，为了质量和培训目的，本次通话可能会被录音。",
  },
  tr: {
    fillers: ['Bir saniye.', 'Hemen bakıyorum.', 'Bir dakika.'],
    apology: 'Üzgünüm, şu anda bir sorun yaşıyorum. Tekrar söyleyebilir misiniz, ya da bir broker sizi arasın?',
    limit: 'Tek seferde kontrol edebileceklerimin sınırına geldim. İsterseniz bunu bir brokera aktarayım.',
    wrong: 'Üzgünüm, benim tarafımda bir şeyler ters gitti. Tekrar söyleyebilir misiniz?',
    deadLine: "Sizden hiçbir şey duyamıyorum, bu yüzden görüşmeyi sonlandırıyorum. Waterfind'ı istediğiniz zaman tekrar arayabilirsiniz. Hoşça kalın.",
    disclosure: "Ben Waterfind'ın otomatik asistanıyım; bu görüşme kalite ve eğitim amacıyla kaydedilebilir.",
  },
  ar: {
    fillers: ['لحظة من فضلك.', 'دعني أتحقق.', 'ثانية واحدة.'],
    apology: 'عذراً، أواجه مشكلة الآن. هل يمكنك إعادة ما قلته، أو أطلب من وسيط الاتصال بك؟',
    limit: 'وصلت إلى حد ما يمكنني التحقق منه دفعة واحدة. إذا أردت، أحوّل الأمر إلى وسيط.',
    wrong: 'عذراً، حدث خطأ من جهتي. هل يمكنك إعادة ما قلته؟',
    deadLine: 'لا أسمع شيئاً من جهتك، لذا سأنهي المكالمة. يمكنك معاودة الاتصال بـ Waterfind في أي وقت. مع السلامة.',
    disclosure: "أنا المساعد الآلي لشركة Waterfind، وقد يتم تسجيل هذه المكالمة لأغراض الجودة والتدريب.",
  },
  es: {
    fillers: ['Un momento.', 'Déjeme comprobarlo.', 'Un segundo.'],
    apology: 'Perdone, ahora mismo tengo un problema. ¿Puede repetirlo, o hago que un corredor le llame?',
    limit: 'He llegado al límite de lo que puedo comprobar de una vez. Si quiere, se lo paso a un corredor.',
    wrong: 'Perdone, algo ha fallado por mi parte. ¿Puede repetirlo?',
    deadLine: 'No oigo nada de su parte, así que le dejo. Puede volver a llamar a Waterfind cuando quiera. Adiós.',
    disclosure: "Soy el asistente automático de Waterfind y esta llamada puede grabarse con fines de calidad y formación.",
  },
};

export function stringsFor(lang: string | null | undefined): SpokenStrings { return STRINGS[lang ?? 'en'] ?? STRINGS.en; }
export function hasSpokenStrings(lang: string): boolean { return lang in STRINGS; }
