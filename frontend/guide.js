/* Welcome guide: choose a language → watch the explanatory video → answer 5 simple questions.
   - Who sees it: only a person logging in for the first time. The server knows this from a flag on the
     account (needs_guide — set for new accounts, cleared for good once they finish or skip it), so it
     never comes back on any phone after that. Before login we cannot know who is using the phone, so it
     does not open by itself there.
   - Anyone can watch it any time: "Watch the app guide" on the login screen, "App guide" in the menu.
   - "Skip video" (with a confirmation) skips it: from the login screen it goes back to the login box;
     on a first login it counts as done and is recorded as skipped.
   Everything is driven by ui.guide, so background refreshes can never reset it; the <video> element
   sits in a data-morph-skip box so a redraw never restarts playback. Loaded before app.js. */

const GUIDE_VIDEO_VERSION = 'v1'; // bump (and rename the files) whenever the videos change — they are cached for a week
const GUIDE_LANGS = [
  { code: 'en', native: 'English', sub: 'English' },
  { code: 'hi', native: 'हिंदी', sub: 'Hindi' },
  { code: 'mr', native: 'मराठी', sub: 'Marathi' },
];
const GUIDE_PASS = 4;            // of 5
const GUIDE_WATCH_SHARE = 0.9;   // share of the video that must actually be played
const GUIDE_RESULT_FRESH_MS = 60 * 60 * 1000; // a result finished before login counts for the next login within an hour

const GT = {
  en: {
    steps: ['Language', 'Video', 'Questions', 'Log in'], stepsPost: ['Language', 'Video', 'Questions', 'Start'],
    welcome: 'Welcome to MIHIR Task Manager',
    videoTitle: 'Watch: how the app works for you',
    videoIntro: 'This short video explains everything you need. Watch it to the end — then answer a few simple questions.',
    watched: (a, b) => `Watched ${a} of ${b}`,
    needWatch: 'Watch the video to the end to continue.',
    toQuiz: 'Next: 5 simple questions →',
    videoErr: 'The video could not load. Check your internet connection and tap Try again.',
    retryVideo: 'Try again',
    quizTitle: 'A few simple questions',
    quizIntro: 'Choose one answer for each question.',
    check: 'Check my answers',
    answerAll: 'Please answer every question.',
    score: (s, t) => `You got ${s} of ${t} right.`,
    pass: 'Well done! You understand how the app works.',
    fail: 'Some answers are not right. Read the correct answers below, then try again.',
    correctIs: 'Correct answer:',
    retry: 'Try the questions again',
    rewatch: 'Watch the video again',
    anyway: 'Continue anyway',
    toLogin: 'Go to login →',
    start: 'Start using the app →',
    changeLang: 'Change language',
    close: 'Close',
    saving: 'Saving…',
    saveErr: 'Could not save — check your internet connection and tap again.',
    skipVideo: 'Skip video →', skipQ: 'Skip the guide? You can watch it any time from the menu (App guide).', skipYes: 'Yes, skip', skipNo: 'Keep watching',
  },
  hi: {
    steps: ['भाषा', 'वीडियो', 'सवाल', 'लॉग इन'], stepsPost: ['भाषा', 'वीडियो', 'सवाल', 'शुरू करें'],
    welcome: 'मिहिर टास्क मैनेजर में आपका स्वागत है',
    videoTitle: 'देखिए: ऐप आपके लिए कैसे काम करता है',
    videoIntro: 'इस छोटे वीडियो में वो सब बताया गया है जो आपको जानना है। इसे पूरा देखिए — फिर कुछ आसान सवालों के जवाब दीजिए।',
    watched: (a, b) => `${b} में से ${a} देखा`,
    needWatch: 'आगे बढ़ने के लिए वीडियो पूरा देखिए।',
    toQuiz: 'आगे: 5 आसान सवाल →',
    videoErr: 'वीडियो लोड नहीं हुआ। इंटरनेट चेक कीजिए और "फिर से कोशिश करें" दबाइए।',
    retryVideo: 'फिर से कोशिश करें',
    quizTitle: 'कुछ आसान सवाल',
    quizIntro: 'हर सवाल का एक जवाब चुनिए।',
    check: 'मेरे जवाब जाँचें',
    answerAll: 'कृपया हर सवाल का जवाब दीजिए।',
    score: (s, t) => `${t} में से ${s} जवाब सही।`,
    pass: 'बहुत बढ़िया! आप समझ गए हैं कि ऐप कैसे काम करता है।',
    fail: 'कुछ जवाब सही नहीं हैं। नीचे सही जवाब पढ़िए, फिर से कोशिश कीजिए।',
    correctIs: 'सही जवाब:',
    retry: 'सवाल फिर से करें',
    rewatch: 'वीडियो फिर से देखें',
    anyway: 'फिर भी आगे बढ़ें',
    toLogin: 'लॉग इन पर जाएँ →',
    start: 'ऐप इस्तेमाल करना शुरू करें →',
    changeLang: 'भाषा बदलें',
    close: 'बंद करें',
    saving: 'सेव हो रहा है…',
    saveErr: 'सेव नहीं हुआ — इंटरनेट चेक कीजिए और फिर से दबाइए।',
    skipVideo: 'वीडियो छोड़ें →', skipQ: 'गाइड छोड़ दें? आप इसे कभी भी मेन्यू (App guide) से देख सकते हैं।', skipYes: 'हाँ, छोड़ें', skipNo: 'देखते रहें',
  },
  mr: {
    steps: ['भाषा', 'व्हिडिओ', 'प्रश्न', 'लॉग इन'], stepsPost: ['भाषा', 'व्हिडिओ', 'प्रश्न', 'सुरू करा'],
    welcome: 'मिहिर टास्क मॅनेजरमध्ये तुमचे स्वागत आहे',
    videoTitle: 'पाहा: ॲप तुमच्यासाठी कसे काम करते',
    videoIntro: 'या छोट्या व्हिडिओमध्ये तुम्हाला लागणारी सगळी माहिती आहे. तो पूर्ण पाहा — मग काही सोप्या प्रश्नांची उत्तरे द्या.',
    watched: (a, b) => `${b} पैकी ${a} पाहिले`,
    needWatch: 'पुढे जाण्यासाठी व्हिडिओ पूर्ण पाहा.',
    toQuiz: 'पुढे: 5 सोपे प्रश्न →',
    videoErr: 'व्हिडिओ लोड झाला नाही. इंटरनेट तपासा आणि "पुन्हा प्रयत्न करा" दाबा.',
    retryVideo: 'पुन्हा प्रयत्न करा',
    quizTitle: 'काही सोपे प्रश्न',
    quizIntro: 'प्रत्येक प्रश्नाचे एक उत्तर निवडा.',
    check: 'माझी उत्तरे तपासा',
    answerAll: 'कृपया प्रत्येक प्रश्नाचे उत्तर द्या.',
    score: (s, t) => `${t} पैकी ${s} उत्तरे बरोबर.`,
    pass: 'छान! ॲप कसे काम करते ते तुम्हाला समजले आहे.',
    fail: 'काही उत्तरे बरोबर नाहीत. खाली बरोबर उत्तरे वाचा, मग पुन्हा प्रयत्न करा.',
    correctIs: 'बरोबर उत्तर:',
    retry: 'प्रश्न पुन्हा सोडवा',
    rewatch: 'व्हिडिओ पुन्हा पाहा',
    anyway: 'तरीही पुढे जा',
    toLogin: 'लॉग इन करा →',
    start: 'ॲप वापरायला सुरुवात करा →',
    changeLang: 'भाषा बदला',
    close: 'बंद करा',
    saving: 'सेव्ह होत आहे…',
    saveErr: 'सेव्ह झाले नाही — इंटरनेट तपासा आणि पुन्हा दाबा.',
    skipVideo: 'व्हिडिओ वगळा →', skipQ: 'गाइड वगळायचे? तुम्ही तो कधीही मेन्यूमधून (App guide) पाहू शकता.', skipYes: 'हो, वगळा', skipNo: 'पाहत राहा',
  },
};

// Each question: options in a fixed order, `a` = index of the right one, `why` = shown after checking.
const GUIDE_QUIZ = {
  en: [
    { q: 'Your part of a task is finished. What should you do?', o: ['Phone the task creator and tell them', 'Write a short note and tap "Submit My Part for Approval"', 'Close the task yourself'], a: 1, why: 'Submitting sends your part to the task creator for approval. Only the creator can close a task.' },
    { q: 'A task shows that your level is "On hold". What does it mean?', o: ['The task is cancelled', 'Your level starts after the earlier level is approved — you will get a notification', 'You must finish it today'], a: 1, why: 'Levels go one after another. You are told the moment your level is released.' },
    { q: 'When do reminders and warnings come?', o: ['Every hour', 'At 9 AM, 3 PM and 6 PM', 'Only on Sundays'], a: 1, why: 'While your part is still open, reminders and warnings come three times a day.' },
    { q: 'You think a task is finished, but someone else created it. What do you do?', o: ['Tap "Ask to close" and write the reason', 'Delete the task', 'Do nothing'], a: 0, why: '"Ask to close" sends your reason to the creator, who closes the task or keeps it open.' },
    { q: 'When is your location recorded?', o: ['All the time, even at home', 'Only during a work session that you start yourself', 'Only when Admin presses a button'], a: 1, why: 'Location is recorded only between "Start work session" and "Stop work session".' },
  ],
  hi: [
    { q: 'किसी टास्क में आपका हिस्सा पूरा हो गया। अब आपको क्या करना है?', o: ['टास्क बनाने वाले को फ़ोन करके बता दें', 'छोटा नोट लिखकर "Submit My Part for Approval" दबाएँ', 'टास्क खुद बंद कर दें'], a: 1, why: 'सबमिट करने से आपका हिस्सा अप्रूवल के लिए टास्क बनाने वाले के पास जाता है। टास्क सिर्फ़ बनाने वाला ही बंद कर सकता है।' },
    { q: 'टास्क में दिख रहा है कि आपका लेवल "On hold" है। इसका मतलब क्या है?', o: ['टास्क कैंसल हो गया', 'पिछला लेवल अप्रूव होने के बाद आपका लेवल शुरू होगा — आपको नोटिफ़िकेशन मिलेगा', 'आपको आज ही काम पूरा करना है'], a: 1, why: 'लेवल एक के बाद एक चलते हैं। आपका लेवल रिलीज़ होते ही आपको बताया जाता है।' },
    { q: 'रिमाइंडर और वॉर्निंग कब आती हैं?', o: ['हर घंटे', 'सुबह 9 बजे, दोपहर 3 बजे और शाम 6 बजे', 'सिर्फ़ रविवार को'], a: 1, why: 'जब तक आपका हिस्सा बाकी है, रिमाइंडर और वॉर्निंग दिन में तीन बार आती हैं।' },
    { q: 'आपको लगता है टास्क पूरा हो गया, पर उसे किसी और ने बनाया है। आप क्या करेंगे?', o: ['"Ask to close" दबाकर कारण लिखेंगे', 'टास्क डिलीट कर देंगे', 'कुछ नहीं करेंगे'], a: 0, why: '"Ask to close" से आपका कारण टास्क बनाने वाले तक जाता है, जो टास्क बंद करता है या खुला रखता है।' },
    { q: 'आपकी लोकेशन कब रिकॉर्ड होती है?', o: ['हर समय, घर पर भी', 'सिर्फ़ उस वर्क सेशन के दौरान जो आप खुद शुरू करते हैं', 'सिर्फ़ जब एडमिन बटन दबाए'], a: 1, why: 'लोकेशन सिर्फ़ "Start work session" और "Stop work session" के बीच रिकॉर्ड होती है।' },
  ],
  mr: [
    { q: 'टास्कमधला तुमचा भाग पूर्ण झाला. आता काय करायचे?', o: ['टास्क तयार करणाऱ्याला फोन करून सांगा', 'छोटी नोंद लिहून "Submit My Part for Approval" दाबा', 'टास्क स्वतः बंद करा'], a: 1, why: 'सबमिट केल्यावर तुमचा भाग अप्रूव्हलसाठी टास्क तयार करणाऱ्याकडे जातो. टास्क फक्त तयार करणाराच बंद करू शकतो.' },
    { q: 'टास्कमध्ये तुमचा लेव्हल "On hold" दिसतो. याचा अर्थ काय?', o: ['टास्क कॅन्सल झाला', 'आधीचा लेव्हल अप्रूव्ह झाल्यावर तुमचा लेव्हल सुरू होईल — तुम्हाला नोटिफिकेशन मिळेल', 'तुम्हाला आजच काम पूर्ण करायचे आहे'], a: 1, why: 'लेव्हल एकामागून एक चालतात. तुमचा लेव्हल रिलीज होताच तुम्हाला कळवले जाते.' },
    { q: 'रिमाइंडर आणि वॉर्निंग कधी येतात?', o: ['दर तासाला', 'सकाळी 9, दुपारी 3 आणि संध्याकाळी 6 वाजता', 'फक्त रविवारी'], a: 1, why: 'तुमचा भाग बाकी असेपर्यंत रिमाइंडर आणि वॉर्निंग दिवसातून तीन वेळा येतात.' },
    { q: 'टास्क पूर्ण झाला असे तुम्हाला वाटते, पण तो दुसऱ्याने तयार केला आहे. तुम्ही काय कराल?', o: ['"Ask to close" दाबून कारण लिहाल', 'टास्क डिलीट कराल', 'काहीच करणार नाही'], a: 0, why: '"Ask to close" ने तुमचे कारण टास्क तयार करणाऱ्याकडे जाते, जो टास्क बंद करतो किंवा उघडा ठेवतो.' },
    { q: 'तुमचे लोकेशन कधी रेकॉर्ड होते?', o: ['नेहमी, घरीसुद्धा', 'फक्त तुम्ही स्वतः सुरू केलेल्या वर्क सेशनमध्ये', 'फक्त ॲडमिनने बटण दाबल्यावर'], a: 1, why: 'लोकेशन फक्त "Start work session" आणि "Stop work session" यांच्या दरम्यान रेकॉर्ड होते.' },
  ],
};

function guideStore(key, val) { try { if (val === undefined) return localStorage.getItem(key); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch (e) { return null; } return null; }
function guideEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function guideFmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function guideVideoSrc(lang) { return `/guide/guide-${lang}-${GUIDE_VIDEO_VERSION}.mp4`; }

// mode: 'pre' (before login), 'post' (required after login), 'replay' (opened from the menu)
function openGuide(mode) {
  const lang = guideStore('ks_guide_lang');
  ui.guide = { open: true, mode, step: 'lang', lang: GT[lang] ? lang : null, watched: 0, duration: 0, canQuiz: false, answers: {}, attempts: 0, checked: false, score: 0, err: '', saving: false, videoErr: false };
}
function closeGuide() { ui.guide = null; }
// Before login it shows only when someone opens it from the login screen — we cannot know who is
// using the phone until they log in, so it never opens by itself there.
function guideShouldOpenBeforeLogin() { return !!(ui.guide && ui.guide.open); }
// After login: a new account that has not finished it must do so now.
function guideRequiredNow() { return !!(session && session.needsGuide); }

// "Skip video" with a one-tap confirmation, so a stray tap never skips it.
function guideSkipHTML(g, L, label) {
  if (g.mode === 'replay') return '';
  if (g.confirmSkip) return `<div class="guide-skip-confirm"><div>${guideEsc(L.skipQ)}</div>
      <div class="guide-actions" style="margin-top:10px;"><button type="button" class="btn btn-danger guide-big" data-guide-act="skip-yes" ${g.saving ? 'disabled' : ''}>${guideEsc(g.saving ? L.saving : L.skipYes)}</button>
      <button type="button" class="btn guide-big" data-guide-act="skip-no">${guideEsc(L.skipNo)}</button></div></div>`;
  return `<div class="guide-skip"><button type="button" class="btn guide-skip-btn" data-guide-act="skip-ask">${guideEsc(label || L.skipVideo)}</button></div>`;
}
function guideStepsHTML(g, L) {
  const names = g.mode === 'pre' ? L.steps : L.stepsPost;
  const idx = { lang: 0, video: 1, quiz: 2 }[g.step] || 0;
  return `<div class="guide-steps">${names.map((n, i) => `<div class="guide-step ${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}"><span>${i < idx ? '✓' : i + 1}</span><em>${guideEsc(n)}</em></div>`).join('<div class="guide-step-line"></div>')}</div>`;
}

function renderGuide() {
  const g = ui.guide;
  const L = GT[g.lang || 'en'];
  let body = '';
  if (g.step === 'lang') {
    body = `
      <div class="guide-hello">
        <div class="guide-hello-line">Welcome — choose your language</div>
        <div class="guide-hello-line">स्वागत है — अपनी भाषा चुनिए</div>
        <div class="guide-hello-line">स्वागत आहे — तुमची भाषा निवडा</div>
      </div>
      <div class="guide-langs">
        ${GUIDE_LANGS.map(l => `<button type="button" class="guide-lang ${g.lang === l.code ? 'picked' : ''}" data-guide-lang="${l.code}"><b>${guideEsc(l.native)}</b><span>${guideEsc(l.sub)}</span></button>`).join('')}
      </div>
      ${g.mode === 'pre' ? `<div class="guide-foot"><a href="#" data-guide-act="skip-now">← Back to login · लॉग इन पर वापस · लॉग इनवर परत</a></div>` : ''}
      ${g.mode === 'replay' ? `<div class="guide-foot"><a href="#" data-guide-act="close">${guideEsc(L.close)}</a></div>` : ''}
      ${g.mode === 'post' ? guideSkipHTML(g, GT[g.lang || 'en'], 'Skip the guide · गाइड छोड़ें · गाइड वगळा') : ''}`;
  } else if (g.step === 'video') {
    const pct = g.duration ? Math.min(100, Math.round(g.watched / (g.duration * GUIDE_WATCH_SHARE) * 100)) : 0;
    body = `
      <h2 class="guide-h">${guideEsc(L.videoTitle)}</h2>
      <p class="guide-p">${guideEsc(L.videoIntro)}</p>
      <div class="guide-video-box" id="guide-video-box-${g.lang}" data-morph-skip>
        <video id="guide-video-${g.lang}" src="${guideVideoSrc(g.lang)}" poster="${guideVideoSrc(g.lang).replace(/\.mp4$/, '.jpg')}" controls playsinline preload="metadata" controlslist="nodownload noplaybackrate" disablepictureinpicture></video>
      </div>
      ${g.videoErr ? `<div class="err" style="margin-top:8px;">${guideEsc(L.videoErr)} <button type="button" class="btn btn-sm" data-guide-act="reload-video">${guideEsc(L.retryVideo)}</button></div>` : ''}
      <div class="guide-progress"><div class="guide-progress-bar"><i style="width:${pct}%"></i></div>
        <span class="guide-progress-text" id="guide-progress-text">${g.duration ? guideEsc(L.watched(guideFmt(g.watched), guideFmt(g.duration))) : ''}</span></div>
      <div class="guide-actions">
        <button type="button" class="btn btn-primary guide-big" data-guide-act="to-quiz" ${g.canQuiz ? '' : 'disabled'}>${guideEsc(L.toQuiz)}</button>
        ${g.canQuiz ? '' : `<div class="guide-note">${guideEsc(L.needWatch)}</div>`}
      </div>
      ${guideSkipHTML(g, L)}
      <div class="guide-foot"><a href="#" data-guide-act="change-lang">${guideEsc(L.changeLang)}</a>${g.mode === 'replay' ? ` · <a href="#" data-guide-act="close">${guideEsc(L.close)}</a>` : ''}</div>`;
  } else {
    const Q = GUIDE_QUIZ[g.lang];
    const passed = g.checked && g.score >= GUIDE_PASS;
    body = `
      <h2 class="guide-h">${guideEsc(L.quizTitle)}</h2>
      <p class="guide-p">${guideEsc(L.quizIntro)}</p>
      ${g.checked ? `<div class="guide-result ${passed ? 'ok' : 'bad'}"><b>${guideEsc(L.score(g.score, Q.length))}</b> ${guideEsc(passed ? L.pass : L.fail)}</div>` : ''}
      <ol class="guide-quiz">
        ${Q.map((item, qi) => {
          const chosen = g.answers[qi];
          const right = chosen === item.a;
          return `<li class="guide-q ${g.checked ? (right ? 'right' : 'wrong') : ''}">
            <div class="guide-q-text">${guideEsc(item.q)}</div>
            ${item.o.map((opt, oi) => `<label class="guide-opt ${chosen === oi ? 'chosen' : ''} ${g.checked && oi === item.a ? 'is-answer' : ''}">
              <input type="radio" name="guide-q-${qi}" value="${oi}" data-guide-q="${qi}" ${chosen === oi ? 'checked' : ''} ${g.checked ? 'disabled' : ''}><span>${guideEsc(opt)}</span></label>`).join('')}
            ${g.checked && !right ? `<div class="guide-why"><b>${guideEsc(L.correctIs)}</b> ${guideEsc(item.o[item.a])}. ${guideEsc(item.why)}</div>` : ''}
            ${g.checked && right ? `<div class="guide-why ok">✓ ${guideEsc(item.why)}</div>` : ''}
          </li>`;
        }).join('')}
      </ol>
      ${g.err ? `<div class="err">${guideEsc(g.err)}</div>` : ''}
      <div class="guide-actions">
        ${!g.checked ? `<button type="button" class="btn btn-primary guide-big" data-guide-act="check">${guideEsc(L.check)}</button>` : passed
          ? `<button type="button" class="btn btn-primary guide-big" data-guide-act="finish" ${g.saving ? 'disabled' : ''}>${guideEsc(g.saving ? L.saving : (g.mode === 'pre' ? L.toLogin : (g.mode === 'replay' ? L.close : L.start)))}</button>`
          : `<button type="button" class="btn btn-primary guide-big" data-guide-act="retry">${guideEsc(L.retry)}</button>
             <button type="button" class="btn guide-big" data-guide-act="rewatch">${guideEsc(L.rewatch)}</button>
             ${g.attempts >= 2 ? `<button type="button" class="btn guide-big" data-guide-act="finish" ${g.saving ? 'disabled' : ''}>${guideEsc(g.saving ? L.saving : L.anyway)}</button>` : ''}`}
      </div>`;
  }
  return `
  <div class="guide-bg">
    <div class="guide-card" role="dialog" aria-label="${guideEsc(L.welcome)}">
      <div class="guide-head">
        <div class="brand-mark">${typeof falconMark === 'function' ? falconMark() : ''}</div>
        <div><div class="brand-name">MIHIR</div><div class="brand-sub">${guideEsc(L.welcome)}</div></div>
        ${g.mode === 'post' ? `<a href="#" class="guide-logout" data-act="logout">Log out</a>` : ''}
      </div>
      ${guideStepsHTML(g, L)}
      <div class="guide-body">${body}</div>
    </div>
  </div>`;
}

function guideVideoEl() { return ui.guide && ui.guide.lang ? document.getElementById(`guide-video-${ui.guide.lang}`) : null; }
function guideUpdateProgress() {
  const g = ui.guide; if (!g) return;
  const L = GT[g.lang || 'en'];
  const t = document.getElementById('guide-progress-text');
  if (t && g.duration) t.textContent = L.watched(guideFmt(g.watched), guideFmt(g.duration));
  const bar = document.querySelector('.guide-progress-bar i');
  if (bar && g.duration) bar.style.width = Math.min(100, Math.round(g.watched / (g.duration * GUIDE_WATCH_SHARE) * 100)) + '%';
}

function bindGuide() {
  const g = ui.guide; if (!g) return;
  document.querySelectorAll('[data-guide-lang]').forEach(b => b.onclick = () => {
    const lang = b.dataset.guideLang;
    if (g.lang !== lang) { g.watched = 0; g.duration = 0; g.canQuiz = false; g.answers = {}; g.checked = false; g.attempts = 0; }
    g.lang = lang; g.step = 'video'; g.videoErr = false; guideStore('ks_guide_lang', lang);
    render(); window.scrollTo(0, 0);
  });
  const act = (name, fn) => document.querySelectorAll(`[data-guide-act="${name}"]`).forEach(el => el.onclick = (e) => { e.preventDefault(); fn(el); });
  act('skip-now', () => { closeGuide(); render(); });
  act('skip-ask', () => { g.confirmSkip = true; render(); });
  act('skip-no', () => { g.confirmSkip = false; render(); });
  act('skip-yes', () => guideSkip());
  act('close', () => { const v = guideVideoEl(); if (v) v.pause(); closeGuide(); render(); });
  act('change-lang', () => { const v = guideVideoEl(); if (v) v.pause(); g.step = 'lang'; render(); });
  act('reload-video', () => { g.videoErr = false; const v = guideVideoEl(); if (v) { v.load(); } render(); });
  act('to-quiz', () => { if (!g.canQuiz) return; const v = guideVideoEl(); if (v) v.pause(); g.step = 'quiz'; g.checked = false; g.err = ''; render(); window.scrollTo(0, 0); });
  act('rewatch', () => { g.step = 'video'; g.checked = false; g.answers = {}; g.err = ''; render(); window.scrollTo(0, 0); const v = guideVideoEl(); if (v) { v.currentTime = 0; } });
  act('retry', () => { g.checked = false; g.answers = {}; g.err = ''; render(); window.scrollTo(0, 0); });
  act('check', () => {
    const Q = GUIDE_QUIZ[g.lang];
    if (Q.some((_, i) => g.answers[i] === undefined)) { g.err = GT[g.lang].answerAll; render(); return; }
    g.err = ''; g.checked = true; g.attempts += 1;
    g.score = Q.filter((item, i) => g.answers[i] === item.a).length;
    render(); window.scrollTo(0, 0);
  });
  act('finish', () => guideFinish());
  document.querySelectorAll('.guide-card [data-act="logout"]').forEach(el => el.onclick = (e) => { e.preventDefault(); closeGuide(); logout(); });
  document.querySelectorAll('[data-guide-q]').forEach(r => r.onchange = () => { g.answers[Number(r.dataset.guideQ)] = Number(r.value); g.err = ''; render(); });

  // Video: count only time actually played (seeking ahead does not count), never restart on redraw.
  const v = guideVideoEl();
  if (v && !v.dataset.bound) {
    v.dataset.bound = '1';
    let last = 0;
    v.addEventListener('loadedmetadata', () => { if (ui.guide && isFinite(v.duration)) { ui.guide.duration = v.duration; guideUpdateProgress(); } });
    v.addEventListener('seeking', () => { last = v.currentTime; });
    v.addEventListener('timeupdate', () => {
      const gg = ui.guide; if (!gg || gg.step !== 'video') return;
      const d = v.currentTime - last; last = v.currentTime;
      if (d > 0 && d < 1.5 && !v.seeking) gg.watched = Math.min(gg.duration || Infinity, gg.watched + d);
      if (!gg.duration && isFinite(v.duration)) gg.duration = v.duration;
      guideUpdateProgress();
      if (!gg.canQuiz && gg.duration && gg.watched >= gg.duration * GUIDE_WATCH_SHARE) { gg.canQuiz = true; render(); }
    });
    v.addEventListener('ended', () => { const gg = ui.guide; if (gg && gg.duration && gg.watched >= gg.duration * GUIDE_WATCH_SHARE && !gg.canQuiz) { gg.canQuiz = true; render(); } });
    v.addEventListener('error', () => { if (ui.guide) { ui.guide.videoErr = true; render(); } });
    if (v.readyState >= 1 && isFinite(v.duration)) { g.duration = v.duration; guideUpdateProgress(); }
  }
}

async function guideSkip() {
  const g = ui.guide; if (!g || g.saving) return;
  const v = guideVideoEl(); if (v) v.pause();
  if (g.mode !== 'post') { closeGuide(); render(); window.scrollTo(0, 0); const u = document.getElementById('lg-user'); if (u) u.focus(); return; }
  g.saving = true; g.err = ''; render();
  try {
    await api('/api/auth/guide-complete', { method: 'POST', body: JSON.stringify({ skipped: true, lang: g.lang || null }) });
    guideCompletedAt = Date.now();
    session = { ...session, needsGuide: false }; safeStorage.setItem('ls_session', JSON.stringify(session));
    closeGuide(); render(); window.scrollTo(0, 0);
  } catch (e) { g.saving = false; g.err = GT[g.lang || 'en'].saveErr; render(); }
}
async function guideFinish() {
  const g = ui.guide; if (!g || g.saving) return;
  const result = { lang: g.lang, score: g.score, total: GUIDE_QUIZ[g.lang].length, attempts: g.attempts };
  if (g.mode === 'pre') {
    guideStore('ks_guide_result', JSON.stringify({ ...result, at: Date.now() }));
    closeGuide(); render(); window.scrollTo(0, 0);
    const u = document.getElementById('lg-user'); if (u) u.focus();
    return;
  }
  if (g.mode === 'replay') { closeGuide(); render(); return; }
  g.saving = true; g.err = ''; render();
  try {
    await api('/api/auth/guide-complete', { method: 'POST', body: JSON.stringify(result) });
    guideStore('ks_guide_result', null); guideCompletedAt = Date.now();
    session = { ...session, needsGuide: false }; safeStorage.setItem('ls_session', JSON.stringify(session));
    closeGuide(); render(); window.scrollTo(0, 0);
  } catch (e) { g.saving = false; g.err = GT[g.lang].saveErr; render(); }
}

// Right after login: a guide finished on this phone just before logging in counts for this account.
// The result is used up by the very next login, whoever it is — on a shared phone it can never be
// credited to someone who logs in later.
let guideCompletedAt = 0;
async function guideAfterLogin(needsGuide) {
  let r = null; try { r = JSON.parse(guideStore('ks_guide_result') || 'null'); } catch (e) { r = null; }
  guideStore('ks_guide_result', null);
  if (!needsGuide) return;
  if (r && r.lang && Date.now() - r.at < GUIDE_RESULT_FRESH_MS) {
    try {
      await api('/api/auth/guide-complete', { method: 'POST', body: JSON.stringify({ lang: r.lang, score: r.score, total: r.total, attempts: r.attempts }) });
      guideCompletedAt = Date.now();
      session = { ...session, needsGuide: false }; safeStorage.setItem('ls_session', JSON.stringify(session));
      return;
    } catch (e) { /* fall through — they will see the guide */ }
  }
  openGuide('post');
}
