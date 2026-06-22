import { StylePreset } from "../config/schema.js";

// The wizard picks a style BY EXAMPLE: the SAME underlying message ("that API call
// swallows errors — wrap it in try/catch") rendered in all four voices, in the
// user's language. We ship it in the 20 most widely spoken/used languages; for any
// other language the wizard shows the English set and a clear note that the samples
// only illustrate STYLE — real replies use the chosen language.
export const SAMPLE_LANGUAGES = [
  "en", "zh", "es", "hi", "ar", "pt", "ru", "ja", "de", "fr",
  "ko", "it", "tr", "vi", "pl", "nl", "id", "uk", "th", "cs",
] as const;
export type SampleLang = (typeof SAMPLE_LANGUAGES)[number];

// Samples exist only for the four built-in presets; "custom" has no sample.
type SamplePreset = Exclude<StylePreset, "custom">;

export const SAMPLES: Record<SampleLang, Record<SamplePreset, string>> = {
  en: {
    "sharp-cofounder": "That call swallows errors — it'll fail silently and you'll debug it at 2am. Wrap it in a try/catch and surface the message. Want me to just do it?",
    "calm-mentor": "One thing worth tightening here: this call doesn't handle errors, so a failure would pass unnoticed. Adding a try/catch that logs the message will make it much easier to trust. Want to walk through it together?",
    "minimalist-engineer": "Unhandled errors here — fails silently. Wrap in try/catch, log the message.",
    "neutral-assistant": "This call doesn't handle errors, so failures will be silent. I recommend wrapping it in a try/catch and logging the error message.",
  },
  zh: {
    "sharp-cofounder": "这个调用把错误吞了——它会悄无声息地失败，然后你凌晨两点还在调它。用 try/catch 包起来，把错误信息抛出来。要我直接改吗？",
    "calm-mentor": "这里有一处值得收紧：这个调用没有处理错误，所以一旦失败会悄悄溜过去。加一个记录信息的 try/catch，会让它可靠得多。我们一起过一遍好吗？",
    "minimalist-engineer": "未处理的错误——会静默失败。用 try/catch 包住，记录错误信息。",
    "neutral-assistant": "这个调用没有处理错误，因此失败会是静默的。建议用 try/catch 包裹它并记录错误信息。",
  },
  es: {
    "sharp-cofounder": "Esa llamada se traga los errores — fallará en silencio y lo estarás depurando a las 2 de la mañana. Envuélvela en un try/catch y muestra el mensaje. ¿Quieres que lo haga ya?",
    "calm-mentor": "Una cosa que conviene afinar: esta llamada no maneja errores, así que un fallo pasaría desapercibido. Añadir un try/catch que registre el mensaje la hará mucho más fiable. ¿Lo vemos juntos?",
    "minimalist-engineer": "Errores sin manejar — falla en silencio. Envuelve en try/catch y registra el mensaje.",
    "neutral-assistant": "Esta llamada no maneja errores, así que los fallos serán silenciosos. Recomiendo envolverla en un try/catch y registrar el mensaje de error.",
  },
  hi: {
    "sharp-cofounder": "यह कॉल एरर को निगल जाता है — यह चुपचाप फेल होगा और तुम रात 2 बजे इसे डिबग करोगे। इसे try/catch में लपेटो और मैसेज दिखाओ। मैं अभी कर दूँ?",
    "calm-mentor": "यहाँ एक चीज़ कसने लायक है: यह कॉल एरर हैंडल नहीं करता, तो कोई फेलियर बिना पता चले निकल जाएगा। मैसेज लॉग करने वाला try/catch जोड़ने से इस पर भरोसा करना कहीं आसान हो जाएगा। साथ में देख लें?",
    "minimalist-engineer": "अनहैंडल्ड एरर — चुपचाप फेल होता है। try/catch में लपेटो, मैसेज लॉग करो।",
    "neutral-assistant": "यह कॉल एरर हैंडल नहीं करता, इसलिए फेलियर खामोश रहेंगे। इसे try/catch में लपेटने और एरर मैसेज लॉग करने की सलाह है।",
  },
  ar: {
    "sharp-cofounder": "هذا الاستدعاء يبتلع الأخطاء — سيفشل بصمت وستصحّحه في الثانية صباحًا. لُفّه بـ try/catch وأظهر الرسالة. أأفعلها الآن مباشرة؟",
    "calm-mentor": "أمرٌ يستحق الإحكام هنا: هذا الاستدعاء لا يعالج الأخطاء، فقد يمرّ الفشل دون أن يُلاحَظ. إضافة try/catch يسجّل الرسالة ستجعله أجدر بالثقة بكثير. أنراجعه معًا؟",
    "minimalist-engineer": "أخطاء غير معالَجة — يفشل بصمت. لُفّه بـ try/catch وسجّل الرسالة.",
    "neutral-assistant": "هذا الاستدعاء لا يعالج الأخطاء، لذا ستكون الإخفاقات صامتة. أوصي بلفّه بـ try/catch وتسجيل رسالة الخطأ.",
  },
  pt: {
    "sharp-cofounder": "Essa chamada engole os erros — vai falhar silenciosamente e você vai depurar isso às 2 da manhã. Envolve num try/catch e mostra a mensagem. Quer que eu já faça isso?",
    "calm-mentor": "Uma coisa que vale a pena ajustar: esta chamada não trata erros, então uma falha passaria despercebida. Adicionar um try/catch que registra a mensagem deixa tudo bem mais confiável. Vamos ver isso juntos?",
    "minimalist-engineer": "Erros não tratados — falha silenciosa. Envolva em try/catch e registre a mensagem.",
    "neutral-assistant": "Esta chamada não trata erros, então as falhas serão silenciosas. Recomendo envolvê-la num try/catch e registrar a mensagem de erro.",
  },
  ru: {
    "sharp-cofounder": "Этот вызов проглатывает ошибки — он упадёт молча, и ты будешь дебажить это в 2 ночи. Оберни в try/catch и выведи сообщение. Сделать прямо сейчас?",
    "calm-mentor": "Одно стоит подтянуть: этот вызов не обрабатывает ошибки, поэтому сбой пройдёт незамеченным. Если добавить try/catch с логированием сообщения, ему будет куда легче доверять. Разберём вместе?",
    "minimalist-engineer": "Необработанные ошибки — падает молча. Оберни в try/catch, залогируй сообщение.",
    "neutral-assistant": "Этот вызов не обрабатывает ошибки, поэтому сбои будут незаметны. Рекомендую обернуть его в try/catch и логировать сообщение об ошибке.",
  },
  ja: {
    "sharp-cofounder": "この呼び出しはエラーを握りつぶしてる——静かに落ちて、午前2時にデバッグするはめになるよ。try/catch で包んでメッセージを出そう。すぐやっちゃう？",
    "calm-mentor": "ここで締めておきたい点が一つ：この呼び出しはエラーを処理していないので、失敗が気づかれずに通り過ぎてしまいます。メッセージをログに残す try/catch を足すと、ずっと信頼できるようになります。一緒に見てみますか？",
    "minimalist-engineer": "未処理のエラー——静かに失敗する。try/catch で包んで、メッセージをログに出す。",
    "neutral-assistant": "この呼び出しはエラーを処理していないため、失敗が静かに起こります。try/catch で包み、エラーメッセージをログに記録することをおすすめします。",
  },
  de: {
    "sharp-cofounder": "Dieser Call schluckt Fehler — er fällt still aus und du debuggst das um 2 Uhr nachts. Pack ihn in ein try/catch und gib die Meldung aus. Soll ich's einfach machen?",
    "calm-mentor": "Eine Sache, die man hier nachziehen sollte: Dieser Call behandelt keine Fehler, ein Ausfall bliebe also unbemerkt. Ein try/catch, das die Meldung loggt, macht ihn viel vertrauenswürdiger. Schauen wir es uns zusammen an?",
    "minimalist-engineer": "Unbehandelte Fehler — fällt still aus. In try/catch packen, Meldung loggen.",
    "neutral-assistant": "Dieser Call behandelt keine Fehler, daher bleiben Ausfälle unbemerkt. Ich empfehle, ihn in ein try/catch zu packen und die Fehlermeldung zu loggen.",
  },
  fr: {
    "sharp-cofounder": "Cet appel avale les erreurs — il échouera en silence et tu déboggeras ça à 2h du matin. Emballe-le dans un try/catch et fais remonter le message. Je le fais tout de suite ?",
    "calm-mentor": "Une chose à resserrer ici : cet appel ne gère pas les erreurs, donc un échec passerait inaperçu. Ajouter un try/catch qui journalise le message le rendra bien plus fiable. On regarde ça ensemble ?",
    "minimalist-engineer": "Erreurs non gérées — échoue en silence. Emballe dans un try/catch, journalise le message.",
    "neutral-assistant": "Cet appel ne gère pas les erreurs, les échecs seront donc silencieux. Je recommande de l'emballer dans un try/catch et de journaliser le message d'erreur.",
  },
  ko: {
    "sharp-cofounder": "이 호출이 에러를 삼켜버려요 — 조용히 실패하고 새벽 2시에 디버깅하게 될 거예요. try/catch로 감싸서 메시지를 드러내죠. 바로 해버릴까요?",
    "calm-mentor": "여기서 다듬을 부분이 하나 있어요: 이 호출은 에러를 처리하지 않아서 실패가 눈치채지 못한 채 지나갑니다. 메시지를 남기는 try/catch를 추가하면 훨씬 믿을 만해져요. 같이 살펴볼까요?",
    "minimalist-engineer": "처리되지 않은 에러 — 조용히 실패함. try/catch로 감싸고 메시지를 로깅.",
    "neutral-assistant": "이 호출은 에러를 처리하지 않아 실패가 조용히 발생합니다. try/catch로 감싸고 에러 메시지를 로깅하길 권장합니다.",
  },
  it: {
    "sharp-cofounder": "Questa chiamata ingoia gli errori — fallirà in silenzio e te lo ritroverai a fare debug alle 2 di notte. Avvolgila in un try/catch e fai emergere il messaggio. Lo faccio subito?",
    "calm-mentor": "Una cosa da sistemare: questa chiamata non gestisce gli errori, quindi un guasto passerebbe inosservato. Aggiungere un try/catch che logga il messaggio la renderà molto più affidabile. La vediamo insieme?",
    "minimalist-engineer": "Errori non gestiti — fallisce in silenzio. Avvolgi in try/catch, logga il messaggio.",
    "neutral-assistant": "Questa chiamata non gestisce gli errori, quindi i guasti saranno silenziosi. Consiglio di avvolgerla in un try/catch e loggare il messaggio di errore.",
  },
  tr: {
    "sharp-cofounder": "Bu çağrı hataları yutuyor — sessizce patlar ve sabahın 2'sinde hata ayıklarsın. Bir try/catch'e sar ve mesajı göster. Hemen yapayım mı?",
    "calm-mentor": "Burada sıkılaştırılması gereken bir şey var: bu çağrı hataları ele almıyor, yani bir arıza fark edilmeden geçer. Mesajı loglayan bir try/catch eklemek ona güvenmeyi çok kolaylaştırır. Birlikte bakalım mı?",
    "minimalist-engineer": "Ele alınmayan hatalar — sessizce patlar. try/catch'e sar, mesajı logla.",
    "neutral-assistant": "Bu çağrı hataları ele almıyor, bu yüzden arızalar sessiz olacak. Bir try/catch'e sarıp hata mesajını loglamanızı öneririm.",
  },
  vi: {
    "sharp-cofounder": "Lệnh gọi đó nuốt luôn lỗi — nó sẽ hỏng âm thầm và bạn sẽ debug lúc 2 giờ sáng. Bọc nó trong try/catch và hiện thông báo ra. Để mình làm luôn nhé?",
    "calm-mentor": "Một điểm nên siết lại: lệnh gọi này không xử lý lỗi, nên sự cố sẽ trôi qua mà không ai biết. Thêm try/catch ghi lại thông báo sẽ giúp nó đáng tin hơn nhiều. Mình cùng xem qua nhé?",
    "minimalist-engineer": "Lỗi chưa xử lý — hỏng âm thầm. Bọc trong try/catch, ghi log thông báo.",
    "neutral-assistant": "Lệnh gọi này không xử lý lỗi nên các sự cố sẽ âm thầm. Tôi khuyên nên bọc nó trong try/catch và ghi log thông báo lỗi.",
  },
  pl: {
    "sharp-cofounder": "Ten call połyka błędy — wywali się po cichu, a Ty będziesz to debugować o 2 w nocy. Owińmy to w try/catch i pokażmy komunikat. Mam to po prostu zrobić?",
    "calm-mentor": "Jedna rzecz warta poprawienia: ten call nie obsługuje błędów, więc awaria przeszłaby niezauważona. Dodanie try/catch z logowaniem komunikatu sprawi, że łatwiej będzie mu zaufać. Przejdziemy przez to razem?",
    "minimalist-engineer": "Nieobsłużone błędy — cicha awaria. Owiń w try/catch, zaloguj komunikat.",
    "neutral-assistant": "Ten call nie obsługuje błędów, więc awarie będą ciche. Zalecam owinięcie go w try/catch i zalogowanie komunikatu błędu.",
  },
  nl: {
    "sharp-cofounder": "Die call slikt fouten in — hij faalt stilletjes en je zit er om 2 uur 's nachts aan te debuggen. Stop 'm in een try/catch en laat de melding zien. Zal ik het gewoon doen?",
    "calm-mentor": "Eén ding om hier aan te scherpen: deze call vangt geen fouten af, dus een storing zou onopgemerkt blijven. Een try/catch die de melding logt maakt het een stuk betrouwbaarder. Zullen we het samen doorlopen?",
    "minimalist-engineer": "Onafgehandelde fouten — faalt stil. Stop in try/catch, log de melding.",
    "neutral-assistant": "Deze call handelt geen fouten af, dus storingen blijven stil. Ik raad aan om er een try/catch omheen te zetten en de foutmelding te loggen.",
  },
  id: {
    "sharp-cofounder": "Panggilan itu menelan error — bakal gagal diam-diam dan kamu nge-debug-nya jam 2 pagi. Bungkus pakai try/catch dan tampilkan pesannya. Mau langsung aku kerjakan?",
    "calm-mentor": "Satu hal yang perlu dirapikan: panggilan ini tidak menangani error, jadi kegagalan bisa lewat tanpa ketahuan. Menambahkan try/catch yang mencatat pesannya akan membuatnya jauh lebih bisa diandalkan. Kita telusuri bareng?",
    "minimalist-engineer": "Error tak tertangani — gagal diam-diam. Bungkus di try/catch, catat pesannya.",
    "neutral-assistant": "Panggilan ini tidak menangani error, jadi kegagalan akan senyap. Saya sarankan membungkusnya dengan try/catch dan mencatat pesan error-nya.",
  },
  uk: {
    "sharp-cofounder": "Цей виклик ковтає помилки — впаде мовчки, і ти дебажитимеш це о 2 ночі. Загорни в try/catch і покажи повідомлення. Зробити просто зараз?",
    "calm-mentor": "Одне варто підтягнути: цей виклик не обробляє помилки, тож збій пройде непоміченим. Якщо додати try/catch із логуванням повідомлення, йому буде значно легше довіряти. Розберемо разом?",
    "minimalist-engineer": "Необроблені помилки — падає мовчки. Загорни в try/catch, залогуй повідомлення.",
    "neutral-assistant": "Цей виклик не обробляє помилки, тож збої будуть тихими. Рекомендую загорнути його в try/catch і логувати повідомлення про помилку.",
  },
  th: {
    "sharp-cofounder": "การเรียกนี้กลืนข้อผิดพลาดไปเลย — มันจะพังเงียบ ๆ แล้วคุณต้องมานั่งดีบักตอนตีสอง ครอบมันด้วย try/catch แล้วแสดงข้อความออกมา ให้ผมจัดการเลยไหม?",
    "calm-mentor": "มีจุดหนึ่งที่ควรรัดกุมขึ้น: การเรียกนี้ไม่ได้จัดการข้อผิดพลาด ความล้มเหลวจึงผ่านไปโดยไม่มีใครรู้ การเพิ่ม try/catch ที่บันทึกข้อความจะทำให้เชื่อถือได้มากขึ้น เราไปดูด้วยกันไหม?",
    "minimalist-engineer": "ข้อผิดพลาดที่ไม่ได้จัดการ — ล้มเหลวเงียบ ๆ ครอบด้วย try/catch แล้วบันทึกข้อความ",
    "neutral-assistant": "การเรียกนี้ไม่ได้จัดการข้อผิดพลาด ความล้มเหลวจึงเงียบ แนะนำให้ครอบด้วย try/catch และบันทึกข้อความข้อผิดพลาด",
  },
  cs: {
    "sharp-cofounder": "Tohle volání polyká chyby — spadne potichu a budeš to ladit ve 2 ráno. Obal to do try/catch a vypiš zprávu. Mám to rovnou udělat?",
    "calm-mentor": "Jedna věc, kterou tu stojí za to doladit: tohle volání neošetřuje chyby, takže selhání by zůstalo bez povšimnutí. Přidání try/catch, které zaloguje zprávu, mu výrazně přidá na důvěryhodnosti. Projdeme to spolu?",
    "minimalist-engineer": "Neošetřené chyby — selže potichu. Obal do try/catch, zaloguj zprávu.",
    "neutral-assistant": "Tohle volání neošetřuje chyby, takže selhání budou tichá. Doporučuji obalit ho do try/catch a zalogovat chybovou zprávu.",
  },
};

// Common language names -> ISO code, so a user typing "Polski" or "Deutsch" still
// gets localized samples.
const NAME_TO_CODE: Record<string, SampleLang> = {
  english: "en", chinese: "zh", mandarin: "zh", 中文: "zh",
  spanish: "es", español: "es", espanol: "es",
  hindi: "hi", हिंदी: "hi", arabic: "ar", عربي: "ar", العربية: "ar",
  portuguese: "pt", português: "pt", portugues: "pt",
  russian: "ru", русский: "ru", japanese: "ja", 日本語: "ja",
  german: "de", deutsch: "de", french: "fr", français: "fr", francais: "fr",
  korean: "ko", 한국어: "ko", italian: "it", italiano: "it",
  turkish: "tr", türkçe: "tr", turkce: "tr", vietnamese: "vi", "tiếng việt": "vi",
  polish: "pl", polski: "pl", dutch: "nl", nederlands: "nl",
  indonesian: "id", "bahasa indonesia": "id", ukrainian: "uk", українська: "uk",
  thai: "th", ไทย: "th", czech: "cs", čeština: "cs", cestina: "cs",
};

// Resolve a free-form language (code or name) to a supported sample language, or
// null when we don't ship samples for it.
export function resolveSampleLang(language: string): SampleLang | null {
  const norm = language.trim().toLowerCase();
  if (!norm) return null;
  if ((SAMPLE_LANGUAGES as readonly string[]).includes(norm)) return norm as SampleLang;
  if (NAME_TO_CODE[norm]) return NAME_TO_CODE[norm];
  const two = norm.slice(0, 2);
  if ((SAMPLE_LANGUAGES as readonly string[]).includes(two)) return two as SampleLang;
  return null;
}
