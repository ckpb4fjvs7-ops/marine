import { DEFAULT_UDP_CONFIG } from "@/lib/network-udp-types";
import type { NetworkUdpController } from "@/lib/use-network-udp";

export function NetworkUdpPanel({ network }: { network: NetworkUdpController }) {
  const { config, status, phase } = network;
  const busy = phase === "starting";
  const locked = network.running || busy;
  const patch = (value: Partial<typeof config>) => network.setConfig((current) => ({ ...current, ...value }));
  const stats = network.running ? status?.stats : undefined;
  const noPackets = network.running && !stats?.packets;
  return (
    <section className="network-udp-panel rounded-xl border border-line bg-surface p-3 text-xs" dir="rtl" aria-label="Network UDP sensor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-accent" dir="ltr">Network UDP — R5 SUPREME</h2>
        <span className="text-sand" role="status">
          {busy ? "فتح منفذ UDP…" : phase === "reconnecting" ? "إعادة الاتصال بالخدمة…" : network.running ? (config.sourceIp ? network.live ? "موقع حي عبر UDP" : "المنفذ مفتوح — بانتظار الموقع" : "اكتشاف المصادر فقط") : "غير متصل"}
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1">IP الجهاز المرسل
          <input aria-label="UDP device IP" value={config.sourceIp} disabled={locked} placeholder="192.168.1.10" onChange={(event) => patch({ sourceIp: event.target.value.trim() })} className="min-w-0 rounded-md border border-line bg-surface-2 px-2 py-1.5" dir="ltr" inputMode="decimal" />
        </label>
        <label className="grid gap-1">UDP Port — منفذ الاستقبال
          <input aria-label="UDP port" type="number" min={1} max={65535} value={config.port} disabled={locked} onChange={(event) => patch({ port: Number(event.target.value) })} className="min-w-0 rounded-md border border-line bg-surface-2 px-2 py-1.5" dir="ltr" />
        </label>
        <label className="grid gap-1">نوع الاستقبال
          <select aria-label="UDP reception mode" value={config.mode} disabled={locked} onChange={(event) => patch({ mode: event.target.value as "multicast" | "unicast" })} className="min-w-0 rounded-md border border-line bg-surface-2 px-2 py-1.5">
            <option value="multicast">R5 / IEC 61162-450 Multicast</option>
            <option value="unicast">UDP عادي — Unicast / Broadcast</option>
          </select>
        </label>
        <label className="grid gap-1">بطاقة الشبكة المتصلة بالجهاز
          <select aria-label="UDP local interface" value={config.interfaceIp} disabled={locked} onChange={(event) => patch({ interfaceIp: event.target.value })} className="min-w-0 rounded-md border border-line bg-surface-2 px-2 py-1.5" dir="ltr">
            <option value="0.0.0.0">تلقائي — 0.0.0.0</option>
            {status?.interfaces.map((item) => <option key={`${item.name}-${item.address}`} value={item.address}>{item.name} — {item.address}</option>)}
            {!status?.interfaces.some((item) => item.address === config.interfaceIp) && config.interfaceIp !== "0.0.0.0" ? <option value={config.interfaceIp}>{config.interfaceIp}</option> : null}
          </select>
        </label>
        {config.mode === "multicast" ? <label className="grid gap-1">عنوان مجموعة Multicast
          <input aria-label="UDP multicast group" value={config.group} disabled={locked} onChange={(event) => patch({ group: event.target.value.trim() })} className="min-w-0 rounded-md border border-line bg-surface-2 px-2 py-1.5" dir="ltr" />
        </label> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {network.running || busy ? <button type="button" onClick={() => void network.disconnect()} className="rounded-lg bg-sand px-3 py-2 font-semibold text-bg">Disconnect UDP</button>
          : <button type="button" onClick={() => void network.connect()} className="rounded-lg bg-accent px-3 py-2 font-semibold text-bg">{config.sourceIp ? "Connect UDP" : "اكتشاف مصدر UDP"}</button>}
        <button type="button" disabled={busy} onClick={() => void network.refresh()} className="rounded-lg border border-line bg-surface-2 px-3 py-2">تحديث بطاقات الشبكة</button>
        <button type="button" disabled={locked} onClick={() => network.setConfig((current) => ({ ...DEFAULT_UDP_CONFIG, sourceIp: current.sourceIp, interfaceIp: current.interfaceIp }))} className="rounded-lg border border-line bg-surface-2 px-3 py-2">إعداد R5 / NAVD</button>
      </div>
      <p className="mt-2 leading-5 text-muted">أدخل IP المصدر لتطبيق بياناته على السفينة. تركه فارغًا يفعّل الاكتشاف فقط؛ اختر المصدر من القائمة بعد وصول الحزم. المنفذ هنا هو منفذ الاستقبال على الكمبيوتر، ويجب أن يطابق منفذ الإرسال في الجهاز.</p>
      {network.error ? <p role="alert" className="mt-2 text-sand">{network.error}</p> : null}
      {stats ? <div className="mt-3 rounded-lg bg-bg p-2">
        <dl className="flex flex-wrap gap-x-5 gap-y-1" aria-label="UDP diagnostics">
          <div>حزم: <b>{stats.packets}</b></div><div>بايت: <b>{stats.bytes}</b></div><div>NMEA: <b>{stats.sentences}</b></div><div>مواقع صالحة: <b>{stats.fixes}</b></div><div>checksum مرفوض: <b>{stats.invalidChecksums}</b></div><div>مصادر مستبعدة: <b>{stats.filtered}</b></div>
        </dl>
        {stats.format ? <p className="mt-1 text-muted" dir="ltr">{stats.format}</p> : null}
        {stats.lastLine ? <pre className="mt-2 max-w-full overflow-x-auto text-[10px] text-accent" dir="ltr" aria-label="Last UDP NMEA sentence">{stats.lastLine}</pre> : null}
        {stats.senders.length ? <div className="mt-2 flex flex-wrap gap-2">{stats.senders.map((sender) => <button key={sender.ip} type="button" disabled={busy} onClick={() => void network.connect({ ...config, sourceIp: sender.ip })} className="rounded-md border border-line px-2 py-1" dir="ltr" title="استخدام هذا المصدر للسفينة">{sender.ip} · {sender.packets} packets</button>)}</div> : null}
      </div> : null}
      {noPackets ? <p className="mt-2 leading-5 text-sand">لم تصل حزم بعد. تحقق من تفعيل خرج Ethernet/NMEA في R5، ومن الكابل والشبكة المشتركة واختيار البطاقة الصحيحة، ثم اسمح لـNode باستقبال UDP في جدار الحماية. فتح المنفذ وحده لا يؤكد وصول بيانات الجهاز.</p> : null}
      {network.running && stats?.packets && !stats.fixes ? <p className="mt-2 text-sand">تصل حزم، لكن لم يصل موقع GNSS صالح بعد. فعّل RMC أو GGA/GLL، وVTG للسرعة والاتجاه، وراجع checksum وIP المصدر.</p> : null}
      <details className="mt-3 text-muted"><summary className="cursor-pointer">إعدادات الخدمة المحلية</summary>
        <label className="mt-2 grid gap-1">عنوان خدمة UDP
          <input aria-label="UDP bridge URL" value={network.bridgeUrl} disabled={locked} onChange={(event) => network.setBridgeUrl(event.target.value)} className="rounded-md border border-line bg-surface-2 px-2 py-1.5" dir="ltr" />
        </label>
        <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={config.requireChecksum} disabled={locked} onChange={(event) => patch({ requireChecksum: event.target.checked })} className="accent-accent" />التحقق من NMEA checksum</label>
        <p className="mt-2 leading-5">تعمل الخدمة على الكمبيوتر المتصل بشبكة الجهاز. في التشغيل المحلي تُفتح تلقائيًا عند الاتصال؛ للتشغيل اليدوي استخدم <bdi>scripts/start-network-udp.ps1</bdi>. دليل الإعداد والتشخيص موجود في <bdi>docs/NETWORK_UDP_AR.md</bdi>.</p>
      </details>
    </section>
  );
}
