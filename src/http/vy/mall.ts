// Vylagrets ENDA HTML-verktyg (Etapp 2a). Ingen templatemotor, inga ramverk,
// inga externa resurser: template literals + en inline-CSS, precis som
// ytor_server.py. Vyn ska kännas som redovisningens/ytornas.
//
// TVÅ regler som hela vylagret vilar på:
//   1. KRAV-6: ALL dynamisk text går genom esc() här. Arkivdata innehåller
//      markdown, citattecken och länkar och får aldrig bli injicerad HTML.
//   2. KRAV-5: proveniens() är enda sättet att skriva ut en aktör. Märkningen
//      kommer ur events/comments-kolumnerna (aktor_typ + aktor_namn) — aldrig
//      ur fri text — och ingen rad lämnas omärkt.

const ERSATTNING: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** KRAV-6: enda escape-funktionen. `null`/`undefined` blir tom sträng. */
export function esc(varde: unknown): string {
  if (varde === null || varde === undefined) return '';
  return String(varde).replace(/[&<>"']/g, (tecken) => ERSATTNING[tecken]!);
}

const CSS = `
:root{color-scheme:light dark;--bg:#faf9f6;--kort:#fff;--text:#1c1f24;--svag:#5b6470;
--linje:#e4e2dc;--accent:#1f6f8b}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--kort:#1c1f24;--text:#e8e6e1;
--svag:#9aa3ad;--linje:#2a2e35;--accent:#6fb7cf}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:16px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
padding:0 0 3rem;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--linje);
padding:.9rem 1rem;display:flex;gap:.9rem;align-items:baseline;flex-wrap:wrap;z-index:9}
header a{color:var(--accent);text-decoration:none;font-weight:600}
header .tid{color:var(--svag);font-size:.8rem;margin-left:auto}
main{padding:1rem;max-width:44rem;margin:0 auto}
h1{font-size:1.5rem;line-height:1.25;margin:.4rem 0 .6rem}
h2{font-size:1.15rem;margin:1.6rem 0 .5rem;padding-top:.6rem;border-top:1px solid var(--linje)}
h3{font-size:1rem;margin:1.1rem 0 .3rem;color:var(--svag)}
a{color:var(--accent)}
.kort{display:block;background:var(--kort);border:1px solid var(--linje);
border-radius:14px;padding:.9rem 1rem;margin:.55rem 0;text-decoration:none;color:inherit}
.kort b{display:block;font-size:1.05rem}
.kort .meta{color:var(--svag);font-size:.82rem;display:block;margin-top:.2rem}
.rad{background:var(--kort);border:1px solid var(--linje);border-radius:14px;
padding:.7rem .9rem;margin:.5rem 0;list-style:none}
.rad .huvud{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap;font-size:.82rem;
color:var(--svag)}
.rad .text{white-space:pre-wrap;overflow-wrap:anywhere;margin:.45rem 0 0}
ul.lista{padding:0;margin:.4rem 0}
.summering{color:var(--svag);font-size:.88rem;margin:0 0 1rem}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.prov{display:inline-block;border-radius:999px;padding:.05rem .5rem;font-size:.75rem;
font-weight:600;border:1px solid var(--linje);white-space:nowrap}
.prov-agent{background:#f4e3c3;color:#5a3d05;border-color:#e0c489}
.prov-manniska{background:#dfeadf;color:#204526;border-color:#bcd6bd}
.prov-system{background:#e2e4e8;color:#33393f;border-color:#c8ccd2}
.prov-okand{background:#f0d7d7;color:#5a1f1f;border-color:#e0b4b4}
@media(prefers-color-scheme:dark){
.prov-agent{background:#4a3708;color:#f6dfae;border-color:#6b5010}
.prov-manniska{background:#1e3823;color:#cfe6d2;border-color:#2c5133}
.prov-system{background:#2a2e35;color:#d3d8de;border-color:#3a4048}
.prov-okand{background:#4a1f1f;color:#f0cccc;border-color:#6b2c2c}}
.tagg{display:inline-block;border:1px solid var(--linje);background:var(--kort);
border-radius:999px;padding:.05rem .5rem;font-size:.75rem;margin:0 .25rem .25rem 0}
.fasetter{margin:.2rem 0 1rem}
.fasetter .grupp{margin:.5rem 0}
.fasetter .namn{color:var(--svag);font-size:.78rem;text-transform:uppercase;
letter-spacing:.04em}
a.fasett{display:inline-block;border:1px solid var(--linje);background:var(--kort);
border-radius:999px;padding:.1rem .6rem;font-size:.8rem;margin:.2rem .25rem 0 0;
text-decoration:none}
a.fasett.aktiv{background:var(--accent);color:#fff;border-color:var(--accent)}
form.sok{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0 1rem}
input[type=search]{flex:1 1 14rem;background:var(--kort);color:var(--text);
border:1px solid var(--linje);border-radius:10px;padding:.55rem .7rem;font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;
padding:.55rem 1.2rem;font:inherit;font-weight:600}
.notis{color:var(--svag);font-size:.82rem;margin:.4rem 0}
.fot{color:var(--svag);font-size:.78rem;margin-top:2.5rem;text-align:center}
`;

/**
 * Sidramen. Navigationen är samma tre ytor överallt; klockslaget i hörnet är
 * ytor_servers detalj (den visar att sidan är färsk, inte cachad).
 */
export function sida(titel: string, kropp: string): string {
  return (
    '<!doctype html><html lang=sv><head><meta charset=utf-8>' +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    '<meta name=apple-mobile-web-app-capable content=yes>' +
    `<title>${esc(titel)} — Ärenden</title><style>${CSS}</style></head><body>` +
    '<header><a href="/vy">Ärenden</a><a href="/vy/digest">Vad hände</a>' +
    `<a href="/vy/sok">Sök</a><span class=tid>${esc(klockslag(new Date()))}</span></header>` +
    `<main>${kropp}` +
    '<div class=fot>Läsyta. Ingenting här ändrar något.<br>' +
    'Ärendeplattformen är källan — inga länkar till Linear.</div></main></body></html>'
  );
}

// ---- Proveniens (KRAV-5, AI Act art. 50) ----------------------------------

const MARKNING: Record<string, { text: string; klass: string; titel: string }> = {
  agent: {
    text: '🤖 agent',
    klass: 'prov-agent',
    titel: 'AI-genererat innehåll — skrivet av en agent (AI Act art. 50)',
  },
  manniska: { text: '👤 människa', klass: 'prov-manniska', titel: 'Skrivet av en människa' },
  system: { text: '⚙️ system', klass: 'prov-system', titel: 'Skrivet av en systemprocess' },
};

/**
 * Enda vägen att skriva ut en aktör. Både typen och namnet kommer ur databasens
 * kolumner; agentrader bär ALLTID "agent"-märkningen (AI Act art. 50) och en
 * okänd typ märks som okänd i stället för att smyga förbi omärkt.
 */
export function proveniens(aktorTyp: string, aktorNamn: string): string {
  const m = MARKNING[aktorTyp] ?? {
    text: `❓ ${aktorTyp}`,
    klass: 'prov-okand',
    titel: 'Okänd aktörstyp',
  };
  return (
    `<span class="prov ${m.klass}" title="${esc(m.titel)}">` +
    `${esc(m.text)} · ${esc(aktorNamn)}</span>`
  );
}

// ---- Formatering -----------------------------------------------------------

function tva(n: number): string {
  return String(n).padStart(2, '0');
}

/** Lokal tid, format som arkivet: 2026-08-13. Ingen locale-beroende utdata. */
export function datum(d: Date): string {
  return `${d.getFullYear()}-${tva(d.getMonth() + 1)}-${tva(d.getDate())}`;
}

export function klockslag(d: Date): string {
  return `${tva(d.getHours())}:${tva(d.getMinutes())}`;
}

export function datumtid(d: Date): string {
  return `${datum(d)} ${klockslag(d)}`;
}

// Linears skala: 1 = brådskande … 4 = låg.
const PRIO: Record<number, string> = { 1: 'Brådskande', 2: 'Hög', 3: 'Normal', 4: 'Låg' };

export function prioNamn(priority: number | null): string {
  return priority === null ? 'ingen prio' : (PRIO[priority] ?? `prio ${priority}`);
}

const VERB: Record<string, string> = {
  skapade_arende: 'skapade ärendet',
  importerade_arende: 'importerade ärendet',
  andrade_status: 'ändrade status',
  kommenterade: 'kommenterade',
  claimade_arende: 'plockade ärendet ur kön',
  tom_ko: 'fann kön tom',
};

export function verbText(verb: string): string {
  return VERB[verb] ?? verb.replace(/_/g, ' ');
}
