import type { DisplaySettings } from "@/lib/display-settings";

type Props = {
  settings: DisplaySettings;
  onChange: (patch: Partial<DisplaySettings>) => void;
  onReset: () => void;
};

function Slider({ id, label, value, min, max, step = 1, readout, onChange }: {
  id: string; label: string; value: number; min: number; max: number; step?: number;
  readout: string; onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="font-semibold text-sand" dir="ltr">{readout}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={readout} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-accent" dir="ltr" />
    </div>
  );
}

export function DisplaySettingsPanel({ settings, onChange, onReset }: Props) {
  return (
    <div className="settings-panel" dir="rtl">
      <fieldset className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-3 text-xs">
        <legend className="px-1 font-semibold text-accent">السفينة</legend>
        <Slider id="settings-ship-size" label="حجم السفينة على الخريطة والنموذج" min={0.25} max={4} step={0.05} value={settings.shipSize} readout={`${settings.shipSize.toFixed(2)}×`} onChange={(shipSize) => onChange({ shipSize })} />
        <p className="text-[11px] leading-5 text-muted">كبّر رمز السفينة أو صغّره حسب وضوح العرض.</p>
      </fieldset>

      <fieldset className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-3 text-xs">
        <legend className="px-1 font-semibold text-accent"><bdi>Past track</bdi> — المسار السابق</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.trackVisible} onChange={(event) => onChange({ trackVisible: event.target.checked })} className="size-4 accent-accent" />
          إظهار Past track
        </label>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="settings-track-color">لون Past track</label>
          <div className="flex items-center gap-2" dir="ltr">
            <input id="settings-track-color" type="color" value={settings.trackColor} onChange={(event) => onChange({ trackColor: event.target.value })} className="h-8 w-12 cursor-pointer rounded border border-line bg-surface-2 p-0.5" />
            <span className="font-mono text-[11px] text-muted">{settings.trackColor}</span>
          </div>
        </div>
        <Slider id="settings-track-width" label="سُمك خط Past track" min={1} max={8} value={settings.trackWidth} readout={`${settings.trackWidth} px`} onChange={(trackWidth) => onChange({ trackWidth })} />
        <Slider id="settings-track-opacity" label="وضوح خط Past track" min={20} max={100} value={Math.round(settings.trackOpacity * 100)} readout={`${Math.round(settings.trackOpacity * 100)}%`} onChange={(value) => onChange({ trackOpacity: value / 100 })} />
        <label className="flex flex-wrap items-center justify-between gap-2">
          طول السجل المعروض
          <select aria-label="طول السجل المعروض" value={settings.trackPoints} onChange={(event) => onChange({ trackPoints: Number(event.target.value) })} className="rounded-md border border-line bg-surface-2 px-2 py-1">
            {[500, 2000, 4000, 8000].map((count) => <option key={count} value={count}>آخر {count} نقطة</option>)}
          </select>
        </label>
        <svg viewBox="0 0 220 22" className="h-6 w-full rounded bg-bg" role="img" aria-label="معاينة خط Past track">
          <path d="M8 16 L62 6 L114 15 L170 6 L212 12" fill="none" stroke={settings.trackColor} strokeWidth={settings.trackWidth} strokeOpacity={settings.trackOpacity} strokeLinecap="round" />
        </svg>
      </fieldset>

      <fieldset className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-3 text-xs">
        <legend className="px-1 font-semibold text-accent">الخريطة والملاحة</legend>
        <Slider id="settings-depth-opacity" label="وضوح طبقات الأعماق على الخريطة" min={20} max={100} value={Math.round(settings.depthOpacity * 100)} readout={`${Math.round(settings.depthOpacity * 100)}%`} onChange={(value) => onChange({ depthOpacity: value / 100 })} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.speedVectorVisible} onChange={(event) => onChange({ speedVectorVisible: event.target.checked })} className="size-4 accent-accent" />
          إظهار Speed vector — 10 دقائق
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.courseVisible} onChange={(event) => onChange({ courseVisible: event.target.checked })} className="size-4 accent-accent" />
          إظهار خط الاتجاه
        </label>
        <label className="flex flex-wrap items-center justify-between gap-2">
          طول خط الاتجاه بالدقائق
          <select aria-label="طول خط الاتجاه بالدقائق" value={settings.courseMinutes} onChange={(event) => onChange({ courseMinutes: Number(event.target.value) })} className="rounded-md border border-line bg-surface-2 px-2 py-1">
            {[1, 3, 6, 12].map((minutes) => <option key={minutes} value={minutes}>{minutes} دقائق</option>)}
          </select>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:col-span-full">
        <p className="text-muted">تُحفظ اختياراتك تلقائيًا على هذا الجهاز.</p>
        <button type="button" onClick={onReset} className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-medium hover:bg-surface">استعادة الإعدادات الافتراضية</button>
      </div>
    </div>
  );
}
