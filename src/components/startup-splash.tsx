import { useCallback, useEffect, useRef, useState } from "react";
import { StarsBackground } from "@/components/stars-background";
import StrokeText from "@/components/StrokeText";

function typewriterClick(ctx: AudioContext) {
  const duration = 0.03;
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const env = Math.exp(-i / (ctx.sampleRate * 0.0045));
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 900 + Math.random() * 700;
  const gain = ctx.createGain();
  gain.gain.value = 0.16;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}
const TAGLINE = "خريطة ملاحية تفاعلية مزودة بمعلومات محدثة وقابل للربط بالاجهزة الملاحية";
const TYPE_START = 450;
const TYPE_STEP = 46;

const SHIP_KEY = "own-ship-name";
const TERMS_KEY = "own-ship-terms";

export function StartupSplash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const [typed, setTyped] = useState(0);
  const [askName, setAskName] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [brandOn, setBrandOn] = useState(false);
  const [renameOnly, setRenameOnly] = useState(false);
  const [shipName, setShipName] = useState("");
  const doneRef = useRef(false);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setLeaving(true);
    window.setTimeout(onDone, 640);
  }, [onDone]);

  const begin = useCallback(() => {
    const saved = window.localStorage.getItem(SHIP_KEY)?.trim();
    if (!saved) {
      setAskName(true);
      return;
    }
    if (window.localStorage.getItem(TERMS_KEY) === "1") {
      finish();
      return;
    }
    setShowTerms(true);
  }, [finish]);

  const openRename = useCallback(() => {
    setShipName(window.localStorage.getItem(SHIP_KEY)?.trim() || "");
    setRenameOnly(true);
    setAskName(true);
  }, []);

  const saveName = useCallback(() => {
    const name = shipName.trim();
    if (!name) return;
    window.localStorage.setItem(SHIP_KEY, name);
    if (renameOnly) {
      setAskName(false);
      setRenameOnly(false);
      return;
    }
    setAskName(false);
    setShowTerms(true);
  }, [renameOnly, shipName]);

  const acceptTerms = useCallback(() => {
    window.localStorage.setItem(TERMS_KEY, "1");
    finish();
  }, [finish]);

  const doneTyping = typed >= TAGLINE.length;

  useEffect(() => {
    if (!doneTyping || askName) return;
    startRef.current?.focus();
  }, [askName, doneTyping]);

  useEffect(() => {
    if (!askName) return;
    nameRef.current?.focus();
  }, [askName]);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setTyped(TAGLINE.length);
      return;
    }
    let count = 0;
    let interval = 0;
    const Ctx = window.AudioContext;
    const audio = new Ctx();
    const start = window.setTimeout(() => {
      void audio.resume();
      interval = window.setInterval(() => {
        count += 1;
        setTyped(count);
        if (TAGLINE[count - 1] !== " ") typewriterClick(audio);
        if (count >= TAGLINE.length) window.clearInterval(interval);
      }, TYPE_STEP);
    }, TYPE_START);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(interval);
      void audio.close();
    };
  }, []);

  return (
    <div
      className={`startup-splash${leaving ? " is-leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="splash-title"
    >
      <StarsBackground className="startup-splash__stars" pointerEvents={false} starColor="#1d4e6e" />
      <span className="startup-splash__glow" aria-hidden="true" />
      <span className="startup-splash__caption">
        <img
          className="startup-splash__logo"
          src="/marine-360.png"
          alt="Marine 360"
          style={{ visibility: brandOn ? "visible" : "hidden" }}
        />
        <span className="startup-splash__with" style={{ visibility: brandOn ? "visible" : "hidden" }}>
          بالتعاون مع
        </span>
        <span id="splash-title" className="startup-splash__title" dir="rtl">
          <StrokeText
            text="قسم الحفر البحري"
            strokeColor="#0e7c78"
            fillColor="#16344a"
            strokeWidth={1.3}
            drawDuration={1.4}
            fillDelay={0.15}
            stagger={0.12}
            trigger="mount"
            fillMode="wipe"
            wipeFrom="right"
            fontSize={72}
            fontWeight={700}
            letterSpacing={0}
            shadow
            shadowColor="#087f83"
            onReady={() => setBrandOn(true)}
          />
        </span>
        {showTerms ? null : (
        <span className="startup-splash__typed" dir="rtl">
          {TAGLINE.slice(0, typed)}
          <span className={`startup-splash__caret${doneTyping ? " is-done" : ""}`} aria-hidden="true" />
        </span>
        )}
        {doneTyping && !askName && !showTerms ? (
          <button ref={startRef} type="button" className="startup-splash__start" onClick={begin}>
            ابدأ الملاحة
          </button>
        ) : null}
        {askName ? (
          <form
            className="startup-splash__name"
            onSubmit={(event) => {
              event.preventDefault();
              saveName();
            }}
          >
            <label htmlFor="ship-name">أدخل اسم سفينتك</label>
            <input
              ref={nameRef}
              id="ship-name"
              value={shipName}
              onChange={(event) => setShipName(event.target.value)}
              maxLength={40}
              dir="rtl"
              autoComplete="off"
              required
            />
            <button type="submit" className="startup-splash__start">{renameOnly ? "حفظ الاسم" : "حفظ"}</button>
          </form>
        ) : null}
        {showTerms ? (
          <section className="startup-splash__terms" aria-labelledby="splash-terms-title">
            <h2 id="splash-terms-title">شروط الاستخدام وإخلاء المسؤولية</h2>
            <div className="startup-splash__terms-body">
              <p>هذه الأداة مساعدة ملاحية لقسم الحفر البحري، وليست خريطة رسمية ولا تغني عن ECDIS المعتمد أو منشورات السلطة البحرية.</p>
              <p>الأعماق والأهداف والطقس والمسار معلومات إرشادية، وقد تتأخر أو تختلف عن الواقع. القرار الملاحي يبقى على الربان والضباط.</p>
              <p>لا يتحمل قسم الحفر البحري أي مسؤولية عن ضرر أو حادث أو خسارة تنتج عن استخدام هذه الأداة، أو عن انقطاع الربط، أو عن خطأ في الإحداثيات أو البيانات.</p>
              <p>باستخدامك الخرائط فأنت تقر بأنك راجعت الموقع والعمق والمسار من مصدر رسمي قبل أي مناورة.</p>
            </div>
            <label className="startup-splash__terms-agree">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>أوافق على شروط الاستخدام وإخلاء المسؤولية</span>
            </label>
            {agreed ? (
              <button type="button" className="startup-splash__start" onClick={acceptTerms}>
                نتمنى لك ملاحة آمنة
              </button>
            ) : null}
          </section>
        ) : null}
      </span>
      {doneTyping && !askName && !showTerms ? (
        <button type="button" className="startup-splash__rename" onClick={openRename}>
          تغيير اسم السفينة
        </button>
      ) : null}
      {doneTyping ? null : (
        <span className="startup-splash__loading">
          <span className="startup-splash__loading-label">Loading</span>
          <span className="startup-splash__bar" aria-hidden="true">
            <span className="startup-splash__bar-fill" />
          </span>
        </span>
      )}
    </div>
  );
}
