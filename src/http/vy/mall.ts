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

// ---- Tokenblocket (Designlyft KRAV-1) --------------------------------------
//
// ENDA stilkällan i hela vylagret, och enda stället där en färg-, längd- eller
// tidsliteral får stå. Tre lager, i den ordning de får refereras:
//
//   1. PRIMITIVA (--p-*)  råvärden. Refereras BARA av lager 2.
//   2. SEMANTISKA         roll i gränssnittet (--yta, --text-svag, --linje …).
//                         Det är detta lager mörkt läge pekar om — och bara det,
//                         därför står det inte en enda literal i @media-blocket.
//   3. KOMPONENT          namngivna mått för kort, chip, fält, knapp, rubrik.
//
// Reglerna under blocket refererar ALDRIG lager 1:s FARGER. Byts pappret ut byts en rad.
const CSS = `
:root{
color-scheme:light dark;

/* 1 — PRIMITIVA: varm pappersneutral (ljust läge) */
--p-papper:#faf9f6;--p-vit:#fff;--p-sand:#f3f1ea;
--p-sten-500:#8a8477;--p-sten-700:#5c574c;--p-sten-900:#1b1a17;
/* 1 — PRIMITIVA: kall kolneutral (mörkt läge) */
--p-kol-900:#14161a;--p-kol-800:#1c1f24;--p-kol-700:#23262c;
--p-kol-500:#767d88;--p-kol-300:#a8b1bb;--p-kol-100:#e8e6e1;
/* 1 — PRIMITIVA: accent */
--p-cyan-900:#12384a;--p-cyan-700:#0f5f79;--p-cyan-300:#7cc3db;--p-cyan-100:#cfe7ef;
/* 1 — PRIMITIVA: proveniensens fyra hues (AI Act art. 50-märkningen) */
--p-amber-900:#4a3708;--p-amber-800:#5a3d05;--p-amber-600:#9a7a2a;
--p-amber-500:#b08c2e;--p-amber-200:#f6dfae;--p-amber-100:#f7e9c9;
--p-gron-900:#1e3823;--p-gron-800:#1d4526;--p-gron-500:#4f7d57;
--p-gron-200:#cfe6d2;--p-gron-100:#ddeadd;
--p-skiffer-800:#2a2e35;--p-skiffer-700:#33393f;--p-skiffer-200:#d3d8de;
--p-skiffer-100:#e4e6ea;
--p-rost-900:#4a1f1f;--p-rost-800:#6a1f1f;--p-rost-400:#a85c5c;
--p-rost-500:#b05252;--p-rost-200:#f0cccc;--p-rost-100:#f6d9d9;
--p-slojaljus:#1b1a1714;--p-slojamork:#00000052;
/* 1 — PRIMITIVA: modulär typskala, kvot 1.2 kring 1rem. FYRA storlekar, inte fler. */
--p-typ-1:.833rem;--p-typ-2:1rem;--p-typ-3:1.2rem;--p-typ-4:1.44rem;
--p-vikt-1:400;--p-vikt-2:600;--p-vikt-3:680;
--p-rad-tat:1.25;--p-rad-1:1.4;--p-rad-2:1.65;
--p-spar-tat:-.012em;--p-spar-vid:.06em;
--p-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
--p-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
/* 1 — PRIMITIVA: rymdskala, 4px-bas */
--p-rym-1:.25rem;--p-rym-2:.5rem;--p-rym-3:.75rem;--p-rym-4:1rem;
--p-rym-5:1.5rem;--p-rym-6:2rem;--p-rym-7:3rem;
/* 1 — PRIMITIVA: radie, linjetjocklek, mått */
--p-radie-1:10px;--p-radie-2:14px;--p-radie-rund:999px;
--p-linje-1:1px;--p-linje-2:2px;--p-understryk:.15em;
--p-matt:34rem;--p-sida:44rem;--p-traff:2.75rem;--p-falt:14rem;--p-dold:1px;
--p-utanfor:-110%;
/* 1 — PRIMITIVA: rörelse. Aldrig över 200ms, alltid ease-out. */
--p-tid-1:120ms;--p-tid-2:170ms;--p-kurva:cubic-bezier(.23,1,.32,1);
--p-tryck-stor:.995;--p-tryck:.97;
--p-lager-header:9;--p-lager-hopp:30;

/* 2 — SEMANTISKA: ytor och text */
--yta:var(--p-papper);--yta-upphojd:var(--p-vit);--yta-sankt:var(--p-sand);
--text:var(--p-sten-900);--text-svag:var(--p-sten-700);
--linje:var(--p-sten-500);
--accent:var(--p-cyan-700);--accent-text:var(--p-vit);
--fokus:var(--p-cyan-700);--markering:var(--p-cyan-100);
--skugga-lyft:0 var(--p-linje-1) var(--p-rym-3) var(--p-slojaljus);
/* 2 — SEMANTISKA: proveniens */
--prov-agent-yta:var(--p-amber-100);--prov-agent-text:var(--p-amber-800);
--prov-agent-linje:var(--p-amber-500);
--prov-manniska-yta:var(--p-gron-100);--prov-manniska-text:var(--p-gron-800);
--prov-manniska-linje:var(--p-gron-500);
--prov-system-yta:var(--p-skiffer-100);--prov-system-text:var(--p-skiffer-700);
--prov-system-linje:var(--p-kol-500);
--prov-okand-yta:var(--p-rost-100);--prov-okand-text:var(--p-rost-800);
--prov-okand-linje:var(--p-rost-500);

/* 3 — KOMPONENT */
--rubrik-1:var(--p-typ-4);--rubrik-2:var(--p-typ-3);--rubrik-3:var(--p-typ-2);
--brodtext:var(--p-typ-2);--meta:var(--p-typ-1);
--kort-yta:var(--yta-upphojd);--kort-linje:var(--linje);--kort-radie:var(--p-radie-2);
--kort-luft:var(--p-rym-4);--kort-mellanrum:var(--p-rym-2);
--chip-hojd:var(--p-traff);--chip-luft:var(--p-rym-3);--chip-radie:var(--p-radie-rund);
--falt-hojd:var(--p-traff);--falt-radie:var(--p-radie-1);
--knapp-yta:var(--accent);--knapp-text:var(--accent-text);
--fokus-tjocklek:var(--p-linje-2);--fokus-avstand:var(--p-linje-2)
}
@media(prefers-color-scheme:dark){:root{
--yta:var(--p-kol-900);--yta-upphojd:var(--p-kol-800);--yta-sankt:var(--p-kol-700);
--text:var(--p-kol-100);--text-svag:var(--p-kol-300);
--linje:var(--p-kol-500);
--accent:var(--p-cyan-300);--accent-text:var(--p-kol-900);
--fokus:var(--p-cyan-300);--markering:var(--p-cyan-900);
--skugga-lyft:0 var(--p-linje-1) var(--p-rym-3) var(--p-slojamork);
--prov-agent-yta:var(--p-amber-900);--prov-agent-text:var(--p-amber-200);
--prov-agent-linje:var(--p-amber-600);
--prov-manniska-yta:var(--p-gron-900);--prov-manniska-text:var(--p-gron-200);
--prov-manniska-linje:var(--p-gron-500);
--prov-system-yta:var(--p-skiffer-800);--prov-system-text:var(--p-skiffer-200);
--prov-system-linje:var(--p-kol-500);
--prov-okand-yta:var(--p-rost-900);--prov-okand-text:var(--p-rost-200);
--prov-okand-linje:var(--p-rost-400)
}}

/* ---- Grund ---- */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:0 0 var(--p-rym-7);background:var(--yta);color:var(--text);
font-family:var(--p-sans);font-size:var(--brodtext);line-height:var(--p-rad-2);
font-weight:var(--p-vikt-1);accent-color:var(--accent);caret-color:var(--accent);
scrollbar-color:var(--linje) transparent}
::selection{background:var(--markering);color:var(--text)}
:focus-visible{outline:var(--fokus-tjocklek) solid var(--fokus);
outline-offset:var(--fokus-avstand)}
/* WCAG 2.4.11: fokus får inte hamna under den klistrade headern. */
:target,a,button,input,summary{scroll-margin-top:3.5rem}
.dold{position:absolute;width:var(--p-dold);height:var(--p-dold);overflow:hidden;
clip-path:inset(50%);white-space:nowrap}

/* ---- Hoppa till innehållet (WCAG 2.4.1) ---- */
.hoppa{position:fixed;top:0;left:0;z-index:var(--p-lager-hopp);
transform:translateY(var(--p-utanfor));
display:inline-flex;align-items:center;min-height:var(--p-traff);
padding:0 var(--p-rym-4);background:var(--accent);color:var(--accent-text);
font-weight:var(--p-vikt-2);text-decoration:none;
border-radius:0 0 var(--p-radie-1) 0}
.hoppa:focus{transform:none}

/* ---- Ram ---- */
header{position:sticky;top:0;z-index:var(--p-lager-header);background:var(--yta);
border-bottom:var(--p-linje-1) solid var(--linje);box-shadow:var(--skugga-lyft);
padding:var(--p-rym-1) var(--p-rym-4);display:flex;gap:var(--p-rym-4);
align-items:center;justify-content:space-between}
header nav{display:flex;gap:var(--p-rym-4);flex-wrap:wrap}
header nav a{display:inline-flex;align-items:center;min-height:var(--p-traff);
color:var(--accent);text-decoration:none;font-weight:var(--p-vikt-2)}
header nav a[aria-current]{color:var(--text);
box-shadow:inset 0 calc(var(--p-linje-2) * -1) 0 var(--accent)}
.tid{color:var(--text-svag);font-size:var(--meta);font-variant-numeric:tabular-nums}
main{max-width:var(--p-sida);margin:0 auto;padding:var(--p-rym-5) var(--p-rym-4) 0}
.fot{max-width:var(--p-sida);margin:var(--p-rym-7) auto 0;
padding:var(--p-rym-5) var(--p-rym-4) 0;border-top:var(--p-linje-1) solid var(--linje);
color:var(--text-svag);font-size:var(--meta);text-align:center;line-height:var(--p-rad-1)}

/* ---- Typografi: h1 > h2 > h3 > meta i storlek, vikt OCH färg ---- */
h1,h2,h3{text-wrap:balance;color:var(--text)}
h1{font-size:var(--rubrik-1);font-weight:var(--p-vikt-3);line-height:var(--p-rad-tat);
letter-spacing:var(--p-spar-tat);margin:0 0 var(--p-rym-2)}
h2{font-size:var(--rubrik-2);font-weight:var(--p-vikt-2);line-height:var(--p-rad-tat);
letter-spacing:var(--p-spar-tat);margin:var(--p-rym-6) 0 var(--p-rym-3);
padding-top:var(--p-rym-4);border-top:var(--p-linje-1) solid var(--linje)}
h3{font-size:var(--rubrik-3);font-weight:var(--p-vikt-3);line-height:var(--p-rad-1);
margin:var(--p-rym-5) 0 var(--p-rym-2)}
p{margin:0 0 var(--p-rym-4);max-width:var(--p-matt);text-wrap:pretty}
a{color:var(--accent);text-underline-offset:var(--p-understryk);
text-decoration-thickness:from-font}

/* ---- Kort och rader ---- */
.kort{display:block;min-height:var(--p-traff);background:var(--kort-yta);
border:var(--p-linje-1) solid var(--kort-linje);border-radius:var(--kort-radie);
padding:var(--kort-luft);margin:var(--kort-mellanrum) 0;
text-decoration:none;color:inherit}
.kort b{display:block;font-size:var(--brodtext);font-weight:var(--p-vikt-2);
line-height:var(--p-rad-1);color:var(--text)}
.kort .meta{display:block;margin-top:var(--p-rym-2);color:var(--text-svag);
font-size:var(--meta);line-height:var(--p-rad-1);font-variant-numeric:tabular-nums}
.rad{background:var(--kort-yta);border:var(--p-linje-1) solid var(--kort-linje);
border-radius:var(--kort-radie);padding:var(--p-rym-3) var(--kort-luft);
margin:var(--kort-mellanrum) 0}
.rad .huvud{display:flex;gap:var(--p-rym-2);align-items:center;flex-wrap:wrap;
font-size:var(--meta);line-height:var(--p-rad-1);color:var(--text-svag);
font-variant-numeric:tabular-nums}
.rad .text{margin:var(--p-rym-2) 0 0;color:var(--text)}
ul.lista{list-style:none;padding:0;margin:0 0 var(--p-rym-4)}
.text{white-space:pre-wrap;overflow-wrap:anywhere;max-width:var(--p-matt);
text-wrap:pretty}
.summering{color:var(--text-svag);font-size:var(--meta);letter-spacing:normal;
font-weight:var(--p-vikt-1);font-variant-numeric:tabular-nums}
p.summering,p.notis{max-width:var(--p-matt)}
p.summering{margin:0 0 var(--p-rym-5)}
.notis{color:var(--text-svag);font-size:var(--meta);margin:0 0 var(--p-rym-4)}

/* ---- Proveniensmärket (KRAV-5): ikonen är dekor, texten bär betydelsen ---- */
.prov{display:inline-flex;align-items:center;gap:var(--p-rym-1);
border:var(--p-linje-1) solid;border-radius:var(--chip-radie);
padding:0 var(--p-rym-2);font-size:var(--meta);font-weight:var(--p-vikt-2);
line-height:var(--p-rad-2);white-space:nowrap}
.prov-agent{background:var(--prov-agent-yta);color:var(--prov-agent-text);
border-color:var(--prov-agent-linje)}
.prov-manniska{background:var(--prov-manniska-yta);color:var(--prov-manniska-text);
border-color:var(--prov-manniska-linje)}
.prov-system{background:var(--prov-system-yta);color:var(--prov-system-text);
border-color:var(--prov-system-linje)}
.prov-okand{background:var(--prov-okand-yta);color:var(--prov-okand-text);
border-color:var(--prov-okand-linje)}

/* ---- Etiketter och fasetter ---- */
.tagg{display:inline-block;border:var(--p-linje-1) solid var(--linje);
background:var(--kort-yta);border-radius:var(--chip-radie);
padding:0 var(--p-rym-2);font-size:var(--meta);color:var(--text-svag);
margin:0 var(--p-rym-1) var(--p-rym-1) 0}
.fasetter{margin:0 0 var(--p-rym-5)}
.fasetter .grupp{margin:0 0 var(--p-rym-4)}
.fasetter .grupp:last-child{margin-bottom:0}
.fasetter .namn{display:inline-block;margin-right:var(--p-rym-2);color:var(--text-svag);
font-size:var(--meta);font-weight:var(--p-vikt-2);text-transform:uppercase;
letter-spacing:var(--p-spar-vid)}
.chips{display:flex;flex-wrap:wrap;gap:var(--p-rym-2);margin-top:var(--p-rym-2)}
a.fasett{display:inline-flex;align-items:center;min-height:var(--chip-hojd);
padding:0 var(--chip-luft);border:var(--p-linje-1) solid var(--linje);
background:var(--kort-yta);border-radius:var(--chip-radie);
font-size:var(--brodtext);color:var(--text);text-decoration:none}
a.fasett.aktiv{background:var(--accent);color:var(--accent-text);
border-color:var(--accent);font-weight:var(--p-vikt-2)}

/* ---- Sökfältet ---- */
form.sok{display:flex;gap:var(--p-rym-2);flex-wrap:wrap;margin:0 0 var(--p-rym-5)}
input[type=search]{flex:1 1 var(--p-falt);min-height:var(--falt-hojd);appearance:none;
background:var(--kort-yta);color:var(--text);
border:var(--p-linje-1) solid var(--linje);border-radius:var(--falt-radie);
padding:0 var(--p-rym-3);font-family:inherit;font-size:var(--brodtext)}
input[type=search]::placeholder{color:var(--text-svag);opacity:1}
button{min-height:var(--falt-hojd);background:var(--knapp-yta);color:var(--knapp-text);
border:var(--p-linje-1) solid var(--knapp-yta);border-radius:var(--falt-radie);
padding:0 var(--p-rym-5);font-family:inherit;font-size:var(--brodtext);
font-weight:var(--p-vikt-2);cursor:pointer}

/* ---- Renderat innehåll: dokumentsidan (.dok) och ärendetexten (.text) ---- */
.dok{overflow-wrap:anywhere}
/* Dokumentets första rubrik står redan under sidans h1 — ingen linje ovanför den. */
.dok>h2:first-child{margin-top:0;padding-top:0;border-top:0}
/* Ärendetexten ligger i ett kort: första och sista blocket bär ingen egen luft. */
.text>:first-child{margin-top:0}
.text>:last-child,.text blockquote>:last-child,.text li>:last-child{margin-bottom:0}
.dok p,.dok li,.text li{max-width:var(--p-matt)}
.dok ul,.dok ol,.text ul,.text ol{padding-left:var(--p-rym-5);margin:0 0 var(--p-rym-4)}
.dok li,.text li{margin:0 0 var(--p-rym-1)}
/* KRAV-8: innehållets rubriknivåer delar EN typstorlek. Typskalan har fyra, och
   en femte är förbjuden — så nivåerna skiljs åt med vikt, färg och versalisering
   i stället. Ingen av dem får heller bli lika stor som sidans egen h2: läsaren
   ska aldrig tro att en rubrik ur en kommentar är en rubrik i vyn.
   h3 behöver ingen egen regel — den globala h3 säger redan rätt sak.
   Versalerna sätts med text-transform, aldrig i strängen: skärmläsaren ska läsa
   ordet, inte bokstäverna. */
.dok h4,.text h4{font-size:var(--rubrik-3);font-weight:var(--p-vikt-2);
color:var(--text-svag);margin:var(--p-rym-5) 0 var(--p-rym-2)}
.text h5{font-size:var(--meta);font-weight:var(--p-vikt-2);color:var(--text-svag);
line-height:var(--p-rad-1);text-transform:uppercase;letter-spacing:var(--p-spar-vid);
margin:var(--p-rym-4) 0 var(--p-rym-1)}
.dok hr,.text hr{border:0;border-top:var(--p-linje-1) solid var(--linje)}
.dok hr{margin:var(--p-rym-6) 0}
.text hr{margin:var(--p-rym-5) 0}
/* Citatet är INNEHÅLL, inte metatext: full textfärg, aldrig --text-svag. Det är
   linjen som bär betydelsen — färg ensam räcker inte (WCAG 1.4.1), och linjen
   ligger på 3.7:1 mot pappret och 4.0:1 mot kolet (WCAG 1.4.11). */
.text blockquote{margin:0 0 var(--p-rym-4);padding-left:var(--p-rym-3);
border-left:var(--p-linje-2) solid var(--linje);color:var(--text)}
pre{background:var(--yta-sankt);border:var(--p-linje-1) solid var(--linje);
border-radius:var(--falt-radie);padding:var(--p-rym-3) var(--p-rym-4);
overflow-x:auto;font-family:var(--p-mono);font-size:var(--meta);
line-height:var(--p-rad-1)}
code{font-family:var(--p-mono);font-size:var(--meta);background:var(--yta-sankt);
border-radius:var(--p-radie-1);padding:0 var(--p-rym-1)}

/* ---- Tillstånd. Hover bara med riktig pekare, rörelse bara om den tillåts. ---- */
@media(hover:hover){
.kort:hover{border-color:var(--accent)}
.kort:hover b{color:var(--accent)}
a.fasett:hover{border-color:var(--accent);color:var(--accent)}
a.fasett.aktiv:hover{color:var(--accent-text)}
}
@media(prefers-reduced-motion:no-preference){
a,button,.kort,.kort b,.hoppa{transition:color var(--p-tid-1) var(--p-kurva),
transform var(--p-tid-2) var(--p-kurva),opacity var(--p-tid-1) var(--p-kurva)}
.kort:active{transform:scale(var(--p-tryck-stor))}
button:active,a.fasett:active{transform:scale(var(--p-tryck))}
}
`;

/** Navigationen är samma tre ytor överallt — ordningen ändras aldrig (WCAG 3.2.3). */
export type Yta = 'vy' | 'digest' | 'sok';

const YTOR: { vag: string; text: string; yta: Yta }[] = [
  { vag: '/vy', text: 'Ärenden', yta: 'vy' },
  { vag: '/vy/digest', text: 'Vad hände', yta: 'digest' },
  { vag: '/vy/sok', text: 'Sök', yta: 'sok' },
];

/**
 * Sidramen. Navigationen är samma tre ytor överallt; klockslaget i hörnet är
 * ytor_servers detalj (den visar att sidan är färsk, inte cachad).
 *
 * `aktiv` märker den yta man står på med aria-current (KRAV-5). Sidor utanför
 * de tre ytorna — ärendet, dokumentet, 404 — lämnar den osatt.
 */
export function sida(titel: string, kropp: string, aktiv?: Yta): string {
  const nav = YTOR.map(
    (y) => `<a href="${y.vag}"${y.yta === aktiv ? ' aria-current=page' : ''}>${esc(y.text)}</a>`,
  ).join('');
  return (
    '<!doctype html><html lang=sv><head><meta charset=utf-8>' +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    '<meta name=apple-mobile-web-app-capable content=yes>' +
    `<title>${esc(titel)} — Ärenden</title><style>${CSS}</style></head><body>` +
    '<a class=hoppa href="#innehall">Hoppa till innehållet</a>' +
    `<header><nav aria-label="Vyns ytor">${nav}</nav>` +
    `<span class=tid><span class=dold>Renderad </span>${esc(klockslag(new Date()))}</span>` +
    '</header>' +
    `<main id=innehall tabindex=-1>${kropp}</main>` +
    '<footer class=fot>Läsyta. Ingenting här ändrar något.<br>' +
    'Ärendeplattformen är källan — inga länkar till Linear.</footer></body></html>'
  );
}

// ---- Proveniens (KRAV-5, AI Act art. 50) ----------------------------------

// Ikonen är REDUNDANT dekor: den upprepar ordet bredvid och bärs därför
// aria-hidden (Designlyft KRAV-5). Tas den bort ur uppläsningen försvinner
// ingen information — ordet och namnet står kvar i klartext.
const MARKNING: Record<string, { ikon: string; ord: string; klass: string; titel: string }> = {
  agent: {
    ikon: '🤖',
    ord: 'agent',
    klass: 'prov-agent',
    titel: 'AI-genererat innehåll — skrivet av en agent (AI Act art. 50)',
  },
  manniska: {
    ikon: '👤',
    ord: 'människa',
    klass: 'prov-manniska',
    titel: 'Skrivet av en människa',
  },
  system: { ikon: '⚙️', ord: 'system', klass: 'prov-system', titel: 'Skrivet av en systemprocess' },
};

/**
 * Enda vägen att skriva ut en aktör. Både typen och namnet kommer ur databasens
 * kolumner; agentrader bär ALLTID "agent"-märkningen (AI Act art. 50) och en
 * okänd typ märks som okänd i stället för att smyga förbi omärkt.
 */
export function proveniens(aktorTyp: string, aktorNamn: string): string {
  const m = MARKNING[aktorTyp] ?? {
    ikon: '❓',
    ord: aktorTyp,
    klass: 'prov-okand',
    titel: 'Okänd aktörstyp',
  };
  return (
    `<span class="prov ${m.klass}" title="${esc(m.titel)}">` +
    `<span aria-hidden=true>${esc(m.ikon)}</span>` +
    `${esc(m.ord)} · ${esc(aktorNamn)}</span>`
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
  // K-2/K-3
  andrade_prioritet: 'ändrade prioritet',
  andrade_deadline: 'ändrade deadline',
  andrade_milstolpe: 'ändrade milstolpe',
  andrade_foralder: 'ändrade förälder',
  arendet_oforandrat: 'lämnade ärendet oförändrat',
  lankade_arenden: 'länkade ärenden',
  lank_fanns_redan: 'länken fanns redan',
  lade_till_bilaga: 'lade till en dokumentlänk',
  bilagan_fanns_redan: 'dokumentlänken fanns redan',
};

export function verbText(verb: string): string {
  return VERB[verb] ?? verb.replace(/_/g, ' ');
}

// ---- K-3: bilagor och relationer -------------------------------------------

/**
 * Andra försvarslinjen mot ett farligt schema i en bilagas adress
 * (HttpUrlSchema är den första, vid skrivningen). Returnerar null för allt som
 * inte är absolut http/https — då renderas titeln som ren text i stället för
 * som en länk. En `javascript:`-URL i ett href är körbar kod i Davids
 * webbläsare, och att bara kontrollera den vid skrivningen vore att lita på att
 * ingen rad någonsin kommit in någon annan väg.
 */
export function sakerUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

/**
 * Relationens innebörd SEDD FRÅN det ärende sidan visar. 'blocks' är riktad, så
 * samma rad betyder olika saker i de två ändarna; 'related' är symmetrisk och
 * betyder detsamma i båda.
 */
export function relationText(typ: string, riktning: 'fran' | 'till'): string {
  if (typ === 'blocks') return riktning === 'fran' ? 'blockerar' : 'blockeras av';
  if (typ === 'related') return 'relaterat till';
  return typ;
}
