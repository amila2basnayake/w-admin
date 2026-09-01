// Server-side check of a caller's spoken confirmation. The model asks "do you confirm … and accept the
// terms?" and then calls confirm_prepared_order — but the model's CLAIM that the caller said yes is
// not evidence. We look at the caller's actual last utterance (Retell's transcript) and require an
// unambiguous affirmation with no negation, hedge or amendment in it. Anything else is "not
// confirmed", and the agent goes back to the caller.
//
// Cues are per language: the session's detected language (languages.ts) selects a table, and the
// English one always applies as well (an "okay" or a "yes" from a Vietnamese caller counts). A language
// with no table here can never confirm an order by voice — the tool answers "not confirmed" and the
// persona hands the trade to a broker — which is the safe default, not a bug. Non-English tables are
// machine-authored: have a native speaker check them before enabling that locale for trading.

export type AffirmVerdict = 'yes' | 'no' | 'unclear';

interface Cues { yes: string[]; no: string[]; /** No word spacing (CJK): cues match as substrings. */ unspaced?: boolean }

const CUES: Record<string, Cues> = {
  en: {
    yes: [
      'yes', 'yeah', 'yep', 'yup', 'yes please', 'correct', 'confirm', 'confirmed', 'i confirm',
      'go ahead', 'go for it', 'do it', 'place it', 'place the order', 'that\'s right', 'thats right',
      'that is right', 'that\'s correct', 'thats correct', 'that is correct', 'affirmative', 'agreed',
      'i agree', 'i accept', 'accept', 'sure', 'ok', 'okay', 'proceed', 'absolutely', 'definitely',
      'sounds good', 'sounds right', 'all good', 'lock it in', 'yes i confirm', 'yes i accept',
      'yes and i accept', 'i confirm and accept', 'confirm and accept', 'happy with that', 'i\'m happy with that',
    ],
    no: [
      'no', 'nope', 'nah', 'don\'t', 'dont', 'do not', 'not yet', 'cancel', 'stop', 'wait', 'hold on',
      'hang on', 'never mind', 'nevermind', 'forget it', 'incorrect', 'wrong', 'not right', 'not correct',
      'change', 'actually', 'instead', 'but ', 'except', 'unless', 'rather', 'different', 'make it',
      'lower', 'higher', 'more', 'less', 'not sure', 'i don\'t know', 'i dont know', 'maybe', 'later',
      'think about it', 'hmm', 'what', 'why', 'how much', 'can you', 'could you', 'decline',
    ],
  },
  vi: {
    yes: ['vâng', 'dạ', 'dạ vâng', 'đúng', 'đúng rồi', 'đúng vậy', 'xác nhận', 'tôi xác nhận', 'đồng ý', 'tôi đồng ý', 'được', 'được rồi', 'chấp nhận', 'tôi chấp nhận', 'ok', 'okay'],
    no: ['không', 'khoan', 'khoan đã', 'đợi', 'đợi đã', 'chờ', 'chờ đã', 'thay', 'đổi', 'thay đổi', 'sửa', 'sai', 'sai rồi', 'nhưng', 'nhưng mà', 'hủy', 'huỷ', 'dừng', 'thôi', 'chưa', 'có lẽ', 'không chắc', 'để sau', 'thấp hơn', 'cao hơn', 'bao nhiêu', 'tại sao', 'gì'],
  },
  it: {
    yes: ['sì', 'si', 'sì confermo', 'confermo', 'lo confermo', 'esatto', 'va bene', 'd\'accordo', 'accetto', 'giusto', 'corretto', 'procedi', 'procedete', 'certo', 'perfetto', 'ok', 'okay'],
    no: ['no', 'non', 'aspetta', 'aspetti', 'un attimo', 'cambia', 'cambi', 'cambiare', 'modifica', 'ma ', 'però', 'invece', 'sbagliato', 'annulla', 'annullare', 'ferma', 'forse', 'non sono sicuro', 'più tardi', 'più alto', 'più basso', 'quanto', 'perché', 'cosa', 'puoi', 'può', 'anzi'],
  },
  el: {
    yes: ['ναι', 'επιβεβαιώνω', 'σωστά', 'σωστό', 'εντάξει', 'συμφωνώ', 'δέχομαι', 'αποδέχομαι', 'προχωρήστε', 'βεβαίως', 'ok', 'okay'],
    no: ['όχι', 'μη', 'μην', 'περίμενε', 'περιμένετε', 'άλλαξε', 'αλλάξτε', 'αλλαγή', 'αλλά', 'όμως', 'λάθος', 'ακύρωση', 'ακύρωσε', 'σταμάτα', 'ίσως', 'δεν είμαι σίγουρος', 'αργότερα', 'ψηλότερα', 'χαμηλότερα', 'πόσο', 'γιατί', 'τι', 'μπορείς', 'μπορείτε'],
  },
  hi: {
    yes: ['हाँ', 'हां', 'जी', 'जी हाँ', 'जी हां', 'पुष्टि', 'मैं पुष्टि करता हूँ', 'मैं पुष्टि करती हूँ', 'ठीक है', 'सही', 'सही है', 'मंज़ूर', 'मंजूर', 'स्वीकार', 'बिल्कुल', 'ok', 'okay'],
    no: ['नहीं', 'ना', 'मत', 'रुको', 'रुकिए', 'ठहरो', 'बदल', 'बदलो', 'बदलिए', 'लेकिन', 'मगर', 'पर ', 'गलत', 'रद्द', 'शायद', 'पक्का नहीं', 'बाद में', 'ज़्यादा', 'ज्यादा', 'कम', 'कितना', 'क्यों', 'क्या'],
  },
  zh: {
    unspaced: true,
    yes: ['是的', '是', '对', '对的', '确认', '我确认', '好的', '好', '可以', '同意', '我同意', '接受', '没问题', '没错', 'ok', 'okay'],
    no: ['不', '不是', '不对', '不要', '别', '等等', '等一下', '稍等', '改', '换', '修改', '但是', '不过', '可是', '错', '取消', '停', '也许', '不确定', '以后', '再说', '高一点', '低一点', '多少', '为什么', '什么', '吗'],
  },
  tr: {
    yes: ['evet', 'onaylıyorum', 'onayla', 'tamam', 'tamamdır', 'kabul ediyorum', 'kabul', 'doğru', 'doğrudur', 'olur', 'peki', 'elbette', 'ok', 'okay'],
    no: ['hayır', 'yok', 'değil', 'bekle', 'bekleyin', 'dur', 'durun', 'değiştir', 'değiştirin', 'ama', 'fakat', 'ancak', 'yanlış', 'iptal', 'belki', 'emin değilim', 'sonra', 'daha yüksek', 'daha düşük', 'ne kadar', 'neden', 'niye', 'ne'],
  },
  ar: {
    yes: ['نعم', 'أجل', 'اجل', 'أؤكد', 'اؤكد', 'موافق', 'أوافق', 'اوافق', 'صحيح', 'تمام', 'حسنا', 'حسناً', 'أقبل', 'اقبل', 'ok', 'okay'],
    no: ['لا', 'ليس', 'لن', 'انتظر', 'لحظة', 'غير', 'غيّر', 'بدّل', 'لكن', 'ولكن', 'خطأ', 'إلغاء', 'الغاء', 'ألغ', 'توقف', 'ربما', 'لست متأكدا', 'لاحقا', 'أعلى', 'أقل', 'كم', 'لماذا', 'ماذا'],
  },
  es: {
    yes: ['sí', 'si', 'sí confirmo', 'confirmo', 'lo confirmo', 'correcto', 'de acuerdo', 'acepto', 'vale', 'adelante', 'exacto', 'claro', 'perfecto', 'procede', 'ok', 'okay'],
    no: ['no', 'espera', 'espere', 'un momento', 'cambia', 'cambie', 'cambiar', 'modifica', 'pero', 'sino', 'en cambio', 'incorrecto', 'cancela', 'cancelar', 'para', 'quizás', 'quizas', 'tal vez', 'no estoy seguro', 'más tarde', 'más alto', 'más bajo', 'cuánto', 'cuanto', 'por qué', 'qué', 'puedes', 'puede'],
  },
};

export function affirmationSupported(lang: string): boolean { return lang in CUES; }

function normalise(s: string): string {
  return ' ' + s.toLowerCase().replace(/[’‘]/g, '\'').replace(/[^\p{L}\p{M}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

function hasCue(t: string, cue: string, unspaced: boolean): boolean {
  if (unspaced) return t.includes(cue);
  const c = cue.endsWith(' ') ? ' ' + cue : ' ' + cue + ' ';
  return t.includes(c);
}

/**
 * Classify one utterance in the caller's language (`lang` = the session's detected base code; English
 * cues always apply too). Rules (in order):
 *  1. any negation / hedge / amendment cue → 'no'  (a "yes, but change the price" is NOT a yes)
 *  2. an affirmation cue, and the utterance is short (a long reply is usually more than a yes) → 'yes'
 *  3. otherwise 'unclear'
 */
export function classifyAffirmation(utterance: string | null | undefined, lang = 'en'): AffirmVerdict {
  const raw = String(utterance ?? '').trim();
  if (!raw) return 'unclear';
  const t = normalise(raw);
  const tables = lang !== 'en' && CUES[lang] ? [CUES[lang], CUES.en] : [CUES.en];
  for (const c of tables) for (const cue of c.no) if (hasCue(t, cue, !!c.unspaced)) return 'no';
  // A question is never a confirmation.
  if (/[?？؟]\s*$/.test(raw)) return 'unclear';
  const words = t.trim().split(' ').filter(Boolean);
  const unspaced = tables.some((c) => c.unspaced);
  if ((unspaced ? raw.length : words.length) > (unspaced ? 30 : 14)) return 'unclear';
  for (const c of tables) for (const cue of c.yes) if (hasCue(t, cue, !!c.unspaced)) return 'yes';
  return 'unclear';
}
